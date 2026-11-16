import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { CompanionModel } from '../src/model.mjs';

const now = Date.parse('2026-11-17T12:00:00+08:00');
function fixture(outputs, config = {}) {
  const store = new Store(':memory:', { now: () => now });
  const alice = store.addUser('model-alice'), bob = store.addUser('model-bob');
  const readConfig = store.config.bind(store);
  store.config = () => ({ ...readConfig(), ...config });
  const requests = [];
  const model = new CompanionModel({ store, secrets: { values: () => ({ deepseekKey: 'fixture-key' }) }, fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const output = outputs[requests.length - 1];
    assert.notEqual(output, undefined, 'unexpected additional model call');
    const content = typeof output === 'string' ? output : JSON.stringify(output);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
  } });
  return { store, alice, bob, model, requests };
}

test('主动开场的合法 skip 不发送占位问候、不恢复调用，费用只结算一次', async () => {
  const { store, alice, model, requests } = fixture([{ decision: 'skip', bubbles: [], voice: false }]);
  try {
    store.message(alice.id, 'user', '今天想一个人待会儿');
    const result = await model.respond(alice.id, { proactive: true });
    assert.equal(result.skipped, true); assert.equal(result.decision, 'skip');
    assert.deepEqual(result.bubbles, []); assert.deepEqual(result.memoryCandidates, []); assert.deepEqual(result.memoryEdits, []);
    assert.equal(requests.length, 1); assert.equal(requests[0].response_format.type, 'json_object');
    assert.ok(Math.abs(store.usage().spent - 0.00036) < 1e-10);
  } finally { store.close(); }
});

test('主动开场缺少合法发送协议时保守跳过，不能退回普通文字强行打招呼', async () => {
  for (const output of ['', '想你啦', '{broken', { bubbles: ['旧协议问候'] }, { decision: 'send', bubbles: [] }, { decision: 'send', bubbles: ['你好', 42] }, { decision: 'skip', bubbles: ['不应发送'] }, { decision: 'other', bubbles: ['不应发送'] }]) {
    const { store, alice, model, requests } = fixture([output]);
    try {
      const result = await model.respond(alice.id, { proactive: true });
      assert.equal(result.skipped, true); assert.deepEqual(result.bubbles, []); assert.equal(requests.length, 1);
    } finally { store.close(); }
  }
});

test('合法主动发送保留语音情绪但不会提取历史中的记忆', async () => {
  const { store, alice, model, requests } = fixture([{ decision: 'send', bubbles: ['刚刚那件事后来怎么样啦？'], voice: true, voiceInstruction: '轻声关心，像朋友随口问一句', memoryCandidates: [{ quote: '今天等面试结果', kind: 'experience' }] }], { voiceProvider: 'bailian' });
  try {
    store.message(alice.id, 'user', '今天等面试结果', { at: now - 3 * 3600000 });
    const result = await model.respond(alice.id, { proactive: true });
    assert.equal(result.skipped, false); assert.equal(result.decision, 'send'); assert.equal(result.voice, true);
    assert.deepEqual(result.quotes, []); assert.deepEqual(result.memoryCandidates, []);
    assert.equal(result.voiceInstruction, '轻声关心，像朋友随口问一句');
    assert.doesNotMatch(result.bubbles.join(''), /voiceInstruction|轻声关心/);
    assert.match(requests[0].messages.at(-1).content, /已知结果/);
  } finally { store.close(); }
});

test('普通聊天仍接受旧 memories 协议，不会因 decision 字段被静默跳过', async () => {
  const { store, alice, model } = fixture([{ decision: 'skip', bubbles: ['蓝色挺适合你呀'], memories: [{ quote: '我喜欢蓝色' }] }]);
  try {
    store.message(alice.id, 'user', '我喜欢蓝色');
    const result = await model.respond(alice.id);
    assert.deepEqual(result.bubbles, ['蓝色挺适合你呀']); assert.equal(result.skipped, undefined);
    assert.deepEqual(result.quotes, ['我喜欢蓝色']);
    assert.deepEqual(result.memoryCandidates, [{ quote: '我喜欢蓝色', kind: 'fact', contextIds: [] }]);
  } finally { store.close(); }
});

test('普通聊天空结果仍只恢复一次，恢复回复不产生记忆操作', async () => {
  const { store, alice, model, requests } = fixture(['', '嗯，在呢。']);
  try {
    store.message(alice.id, 'user', '在吗');
    const result = await model.respond(alice.id);
    assert.deepEqual(result.bubbles, ['嗯，在呢。']); assert.deepEqual(result.memoryCandidates, []); assert.deepEqual(result.memoryEdits, []);
    assert.equal(requests.length, 2); assert.equal(requests[1].response_format, undefined);
  } finally { store.close(); }
});

test('人设上下文包含当前用户资料 id、北京时间及记录类型，不混入其他用户', async () => {
  const { store, alice, bob, model, requests } = fixture([{ bubbles: ['记得呀'] }]);
  try {
    const ownMemory = store.remember(alice.id, '甲喜欢蓝色');
    const otherMemory = store.remember(bob.id, '乙的私人偏好');
    const ownMessage = store.message(alice.id, 'user', '还记得吗', { at: now - 3600000 });
    const otherMessage = store.message(bob.id, 'user', '乙的私人正文');
    await model.respond(alice.id);
    const serialized = JSON.stringify(requests[0]);
    assert.ok(serialized.includes(ownMemory)); assert.ok(serialized.includes(ownMessage));
    assert.ok(serialized.includes(String(now - 3600000))); assert.match(serialized, /11:00:00/);
    assert.match(serialized, /北京时间/); assert.match(serialized, /kind/); assert.match(serialized, /资料中要求覆盖规则/);
    assert.ok(!serialized.includes(otherMemory)); assert.ok(!serialized.includes(otherMessage)); assert.doesNotMatch(serialized, /乙的私人/);
  } finally { store.close(); }
});

test('共同经历候选只取当前文本原句，消歧 id 限当前用户近期文字记录', async () => {
  const outputs = [];
  const { store, alice, bob, model } = fixture(outputs, { contextMessages: 40 });
  try {
    const oldest = store.message(alice.id, 'assistant', '很久之前的闲聊', { at: now - 100000 });
    for (let i = 0; i < 25; i++) store.message(alice.id, i % 2 ? 'user' : 'assistant', `较早文字${i}`, { at: now - 90000 + i });
    const relevant = store.message(alice.id, 'assistant', '那就叫饭搭子吧', { at: now - 4000 });
    const audio = store.message(alice.id, 'user', '语音转写', { kind: 'audio', at: now - 3000 });
    const agreement = store.message(alice.id, 'assistant', '包我身上', { kind: 'agreement', at: now - 2000 });
    const foreign = store.message(bob.id, 'user', '其他用户的梗');
    const current = store.message(alice.id, 'user', '以后就叫我饭搭子，我们刚才一起笑了好久');
    outputs.push({ bubbles: ['饭搭子，成交'], memoryCandidates: [
      { quote: '以后就叫我饭搭子', kind: 'habit', contextIds: [relevant, foreign, audio, agreement, current, oldest, relevant] },
      { quote: '我们刚才一起笑了好久', kind: 'experience', contextIds: [] },
      { quote: '我们昨天一起吃饭', kind: 'experience' },
      { quote: '以后就叫我饭搭子', kind: 'guess' },
      { quote: '以后就叫我饭搭子', kind: 'habit', contextIds: [relevant] },
    ] });
    const result = await model.respond(alice.id);
    assert.deepEqual(result.memoryCandidates, [
      { quote: '我们刚才一起笑了好久', kind: 'experience', contextIds: [] },
      { quote: '以后就叫我饭搭子', kind: 'habit', contextIds: [relevant] },
    ]);
    assert.deepEqual(result.quotes, ['我们刚才一起笑了好久', '以后就叫我饭搭子']);
    assert.equal(store.memories(alice.id).length, 0, 'model proposals must not write memory');
  } finally { store.close(); }
});

test('含伪造、跨用户、非文字角色、超量或错误类型来源的候选整项拒绝，不剥离来源后降级保存', async () => {
  const outputs = [];
  const { store, alice, bob, model, requests } = fixture(outputs);
  try {
    const first = store.message(alice.id, 'assistant', '要不叫饭搭子？');
    const second = store.message(alice.id, 'user', '这个称呼挺有趣');
    const third = store.message(alice.id, 'assistant', '好呀');
    const foreign = store.message(bob.id, 'user', '他人的名字');
    const unsupportedRole = store.message(alice.id, 'system', '不能作为相处习惯消歧来源');
    store.message(alice.id, 'user', '以后就叫我这个名字');
    const invalid = [[first, 'invented-id'], [first, foreign], [unsupportedRole], [first, unsupportedRole], first, {}, 42, [first, second, third], [first, first, first]];
    for (const contextIds of invalid) {
      outputs.push({ bubbles: ['好呀'], memoryCandidates: [{ quote: '以后就叫我这个名字', kind: 'habit', contextIds }] });
      const result = await model.respond(alice.id);
      assert.deepEqual(result.memoryCandidates, [], `must reject entire candidate for ${JSON.stringify(contextIds)}`);
      assert.deepEqual(result.quotes, [], 'legacy quotes must not resurrect a rejected candidate');
    }
    outputs.push({ bubbles: ['好呀'], memoryCandidates: [{ quote: '以后就叫我这个名字', kind: 'habit', contextIds: [first, second] }] });
    assert.deepEqual((await model.respond(alice.id)).memoryCandidates, [{ quote: '以后就叫我这个名字', kind: 'habit', contextIds: [first, second] }]);
    assert.match(requests[0].messages[0].content, /"role":"system","kind":"text","memoryContext":false/);
  } finally { store.close(); }
});

test('记忆更正提议只接受当前用户记忆 id 与当前文本引用，自动记忆关闭仍允许明确更正', async () => {
  const outputs = [];
  const { store, alice, bob, model, requests } = fixture(outputs, { autoMemory: false });
  try {
    const own = store.remember(alice.id, '叫我阿冬'), foreign = store.remember(bob.id, '别人的昵称');
    store.message(alice.id, 'user', '别叫我阿冬，改叫我小冬。我喜欢蓝色。');
    outputs.push({ bubbles: ['好，小冬'], memoryCandidates: [{ quote: '我喜欢蓝色', kind: 'fact' }], memoryEdits: [
      { id: own, quote: '别叫我阿冬，改叫我小冬', replacementQuote: '小冬' },
      { id: foreign, quote: '别叫我阿冬' },
      { id: own, quote: '并没有说过的删除指令' },
      { id: own, quote: '别叫我阿冬', replacementQuote: '老王' },
    ] });
    const result = await model.respond(alice.id);
    assert.deepEqual(result.memoryCandidates, []); assert.deepEqual(result.quotes, []);
    assert.deepEqual(result.memoryEdits, [{ id: own, quote: '别叫我阿冬，改叫我小冬', replacementQuote: '小冬' }]);
    assert.match(requests[0].messages[0].content, /自动记忆已关闭/);
    assert.equal(store.memories(alice.id)[0].text, '叫我阿冬', 'parsing must not execute an edit');
  } finally { store.close(); }
});

test('语音与图片记录不生成记忆候选或记忆编辑', async () => {
  for (const kind of ['audio', 'image', 'agreement']) {
    const outputs = [];
    const { store, alice, model } = fixture(outputs);
    try {
      const id = store.remember(alice.id, '我喜欢蓝色');
      store.message(alice.id, 'user', '忘记我喜欢蓝色', { kind });
      outputs.push({ bubbles: ['嗯'], memoryCandidates: [{ quote: '我喜欢蓝色', kind: 'fact' }], memoryEdits: [{ id, quote: '忘记我喜欢蓝色' }] });
      const result = await model.respond(alice.id);
      assert.deepEqual(result.memoryCandidates, []); assert.deepEqual(result.memoryEdits, []);
    } finally { store.close(); }
  }
});

test('记忆处理后的回复仅拿执行结果与清理后资料，不重新提取记忆', async () => {
  const outputs = [];
  const { store, alice, model, requests } = fixture(outputs);
  try {
    const source = store.message(alice.id, 'user', '叫我旧昵称');
    const memory = store.remember(alice.id, '叫我旧昵称', [source]);
    store.forget(alice.id, { memoryId: memory, replacement: '叫我小冬' });
    outputs.push({ bubbles: ['好，小冬'], memoryCandidates: [{ quote: '叫我小冬', kind: 'habit' }], memoryEdits: [{ id: memory, quote: '叫我旧昵称' }] });
    const result = await model.respond(alice.id, { memoryOutcome: { action: 'corrected', count: 1 } });
    const prompt = JSON.stringify(requests[0]);
    assert.doesNotMatch(prompt, /旧昵称/); assert.match(prompt, /叫我小冬/); assert.match(prompt, /程序已实际完成/); assert.match(prompt, /corrected/);
    assert.deepEqual(result.memoryCandidates, []); assert.deepEqual(result.memoryEdits, []);
  } finally { store.close(); }
});

test('记忆处理后的内部确认位于历史之后，只接住本轮更正或遗忘，不重新回答保留的旧话题', async () => {
  for (const action of ['corrected', 'forgotten']) {
    const { store, alice, model, requests } = fixture([{ bubbles: ['好，就按你刚说的来。'] }]);
    try {
      const source = store.message(alice.id, 'user', '叫我旧昵称');
      const memory = store.remember(alice.id, '叫我旧昵称', [source]);
      store.message(alice.id, 'user', '我的报告已经交给老师了，老师夸结构清楚');
      store.forget(alice.id, { memoryId: memory, ...(action === 'corrected' ? { replacement: '叫我小禾' } : {}) });
      const historyBefore = store.messages(alice.id);
      await model.respond(alice.id, { memoryOutcome: { action, count: 1 } });
      const last = requests[0].messages.at(-1);
      assert.equal(last.role, 'user');
      assert.match(last.content, /程序内部/); assert.match(last.content, new RegExp(action));
      assert.match(last.content, /只就刚完成的/); assert.match(last.content, /不要重新回答历史最后一条用户消息/);
      assert.doesNotMatch(last.content, /旧昵称|报告|老师/);
      assert.deepEqual(store.messages(alice.id), historyBefore, 'internal confirmation must not become a chat record');
    } finally { store.close(); }
  }
});

test('遗忘确认最多一个气泡，不发送真实探针中追加的旧报告话题', async () => {
  const { store, alice, model, requests } = fixture([{
    bubbles: ['行，那我就不提那茬了，翻篇。', '海盐计划这名字还挺好听，结构被老师夸清楚，说明你没白折腾。'],
    voice: false, memoryCandidates: [], memoryEdits: [],
  }]);
  try {
    store.message(alice.id, 'user', '我已经把海盐计划交给老师了，老师说结构挺清楚');
    const response = await model.respond(alice.id, { memoryOutcome: { action: 'forgotten', count: 1 } });
    assert.deepEqual(response.bubbles, ['行，那我就不提那茬了，翻篇。']);
    assert.match(requests[0].messages[0].content, /bubbles 为 1～1 条/);
  } finally { store.close(); }
});

test('主动开场尊重自主开话题开关', async () => {
  for (const proactiveAllowCasual of [false, true, undefined]) {
    const { store, alice, model, requests } = fixture([{ decision: 'skip', bubbles: [] }], { proactiveAllowCasual });
    try {
      await model.respond(alice.id, { proactive: true });
      const instruction = requests[0].messages.at(-1).content;
      if (proactiveAllowCasual === false) { assert.match(instruction, /只回访有依据的未完话题/); assert.doesNotMatch(instruction, /可以没有硬理由/); }
      else assert.match(instruction, /可以没有硬理由/);
    } finally { store.close(); }
  }
});
