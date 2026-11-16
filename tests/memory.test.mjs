import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { applyMemoryUpdates } from '../src/memory.mjs';

function fixture(t) {
  let now = Date.parse('2026-11-17T10:00:00+08:00');
  const store = new Store(':memory:', { now: () => now++ });
  t.after(() => store.close());
  const alice = store.addUser('memory-alice'), bob = store.addUser('memory-bob');
  const input = (raw, kind = 'text', user = alice) => ({ raw, kind, messageId: store.message(user.id, 'user', raw, { kind }) });
  const apply = (value, response, user = alice) => applyMemoryUpdates({ store, userId: user.id, input: value, response });
  return { store, alice, bob, input, apply };
}

test('长期记忆接受当前用户的逐字事实，不再要求特定第一人称关键词', t => {
  const { store, alice, input, apply } = fixture(t);
  const turn = input('今天的小组展示已经顺利结束了。以后叫我阿青吧。');
  assert.deepEqual(apply(turn, { memoryCandidates: [
    { quote: '今天的小组展示已经顺利结束了', kind: 'experience', contextIds: [] },
    { quote: '以后叫我阿青吧', kind: 'habit', contextIds: [] },
  ] }), { changed: true, edited: false });
  assert.deepEqual(store.memories(alice.id).map(row => ({ text: row.text, kind: row.kind, sources: row.sources })), [
    { text: '今天的小组展示已经顺利结束了', kind: 'experience', sources: [turn.messageId] },
    { text: '以后叫我阿青吧', kind: 'habit', sources: [turn.messageId] },
  ]);
  assert.deepEqual(apply(turn, { quotes: ['以后叫我阿青吧'] }), { changed: false, edited: false });
});

test('共同经历引用实际对话并保留所有来源，遗忘来源时清理衍生记忆和回复', t => {
  const { store, alice, input, apply } = fixture(t);
  const previous = input('今天给摸鱼起个暗号吧').messageId;
  const reply = store.message(alice.id, 'assistant', '那就叫深海巡逻。');
  const turn = input('好，以后摸鱼就叫深海巡逻。');
  apply(turn, { memoryCandidates: [{ quote: '以后摸鱼就叫深海巡逻', kind: 'habit', contextIds: [reply, previous] }] });
  const memory = store.memories(alice.id)[0];
  assert.equal(memory.text, '用户：今天给摸鱼起个暗号吧\n大肥鱼：那就叫深海巡逻。\n用户：以后摸鱼就叫深海巡逻');
  assert.deepEqual(memory.sources, [previous, reply, turn.messageId]);
  const derived = store.message(alice.id, 'assistant', '今天也去深海巡逻吗？', { memories: [memory.id] });
  store.forget(alice.id, { messageId: previous });
  assert.equal(store.memories(alice.id).length, 0);
  assert.ok(!store.messages(alice.id).some(row => row.id === derived));
});

test('共同经历拒绝跨用户、伪造、过旧及附件来源', t => {
  const { store, alice, bob, input, apply } = fixture(t);
  const foreign = input('乙的私人称呼', 'text', bob).messageId;
  const old = input('很久以前的聊天').messageId;
  for (let i = 0; i < 24; i++) input(`近期聊天 ${i}`);
  const voice = input('不可靠转写', 'voice').messageId;
  const image = input('图片推断事实', 'image').messageId;
  const command = input('/记住 指令内容', 'command').messageId;
  const system = store.message(alice.id, 'system', '内部状态');
  const turn = input('以后咱们就叫它深海巡逻。');
  for (const id of [foreign, voice, image, command, system, old, 'invented-id', turn.messageId]) {
    assert.deepEqual(apply(turn, { memoryCandidates: [{ quote: '以后咱们就叫它深海巡逻', kind: 'habit', contextIds: [id] }] }), { changed: false, edited: false });
  }
  assert.equal(store.memories(alice.id).length, 0);
  assert.equal(store.messages(bob.id)[0].content, '乙的私人称呼');
});

test('问句、猜测、模型改写和非文字附件都不进入长期记忆', t => {
  const { store, alice, input, apply } = fixture(t);
  for (const [raw, quote] of [
    ['你猜我喜欢蓝色吗？', '喜欢蓝色'], ['我可能喜欢蓝色。', '喜欢蓝色'],
    ['如果我喜欢蓝色，就买蓝色的。', '喜欢蓝色'], ['是不是以后叫我阿青', '以后叫我阿青'],
    ['我喜欢绿色。', '我喜欢蓝色'], ['更正一下，别叫我阿青。', '叫我阿青'],
  ]) apply(input(raw), { quotes: [quote] });
  for (const kind of ['voice', 'image', 'command']) apply(input('我喜欢蓝色', kind), { quotes: ['我喜欢蓝色'] });
  assert.equal(store.memories(alice.id).length, 0);
  const turn = input('我喜欢绿色。你喜欢什么颜色？');
  apply(turn, { quotes: ['我喜欢绿色'] });
  assert.equal(store.memories(alice.id)[0].text, '我喜欢绿色');
});

test('伪造本轮输入或其他用户的消息 ID 不能成为来源', t => {
  const { store, alice, bob, input, apply } = fixture(t);
  const foreign = input('我喜欢绿色', 'text', bob);
  apply(foreign, { quotes: ['我喜欢绿色'] });
  const actual = input('我喜欢绿色');
  apply({ ...actual, raw: '我喜欢蓝色' }, { quotes: ['我喜欢蓝色'] });
  apply({ ...actual, messageId: 'made-up' }, { quotes: ['我喜欢绿色'] });
  assert.equal(store.memories(alice.id).length, 0);
});

test('自然遗忘删除旧来源、本轮指令及衍生记录，保持另一用户隔离且不重新提取', t => {
  const { store, alice, bob, input, apply } = fixture(t);
  const original = input('叫我小胖就好。');
  const memory = store.remember(alice.id, '叫我小胖就好', [original.messageId], { kind: 'habit' });
  store.message(alice.id, 'assistant', '小胖来了！', { memories: [memory] });
  const otherMemory = store.remember(bob.id, '叫我小胖就好');
  const turn = input('别再叫我小胖了。');
  assert.deepEqual(apply(turn, {
    memoryEdits: [{ id: memory, quote: '别再叫我小胖了' }],
    memoryCandidates: [{ quote: '叫我小胖', kind: 'habit' }],
  }), { changed: true, edited: true, memoryOutcome: { action: 'forgotten', count: 1 } });
  assert.deepEqual(store.memories(alice.id), []);
  assert.deepEqual(store.messages(alice.id), []);
  assert.equal(store.memories(bob.id)[0].id, otherMemory);
});

test('自然遗忘接受时间与礼貌前缀，不要求用户使用命令式开头', t => {
  const { store, alice, input, apply } = fixture(t);
  for (const raw of [
    '以后别叫这个名字了。', '从现在起不要再叫我小胖了。', '今后别提这个名字。',
    '对了，以后别叫这个名字了。', '麻烦你以后别叫这个名字了。', '对了，今后你别叫这个名字了。',
    '对了，你能不能忘掉小胖这个名字？',
  ]) {
    const memory = store.remember(alice.id, '叫我小胖', [], { kind: 'habit' });
    store.message(alice.id, 'assistant', '小胖，今天怎么样？', { memories: [memory] });
    const turn = input(raw);
    assert.deepEqual(apply(turn, { memoryEdits: [{ id: memory, quote: raw }] }), {
      changed: true, edited: true, memoryOutcome: { action: 'forgotten', count: 1 },
    }, raw);
    assert.deepEqual(store.memories(alice.id), []);
  }
});

test('含时间前缀的否定、转述和假设仍不能触发遗忘', t => {
  const { store, alice, input, apply } = fixture(t);
  const memory = store.remember(alice.id, '叫我小胖');
  for (const raw of [
    '以后不要忘记小胖这个名字。', '对了，朋友说，以后别叫这个名字了。',
    '如果以后别叫这个名字了，会怎么样？', '从现在起不必删除小胖这个名字。',
  ]) {
    assert.deepEqual(apply(input(raw), { memoryEdits: [{ id: memory, quote: raw }] }), { changed: false, edited: false }, raw);
    assert.equal(store.memories(alice.id)[0].id, memory);
  }
});

test('自然更正仅保存本轮新原文，旧值和纠正指令不回流', t => {
  const { store, alice, input, apply } = fixture(t);
  const original = input('以后叫我小胖。');
  const memory = store.remember(alice.id, '以后叫我小胖', [original.messageId], { kind: 'habit' });
  const turn = input('更正一下，以后叫我阿青。');
  assert.deepEqual(apply(turn, {
    memoryEdits: [{ id: memory, quote: '更正一下', replacementQuote: '以后叫我阿青' }],
    quotes: ['以后叫我小胖'],
  }), { changed: true, edited: true, memoryOutcome: { action: 'corrected', count: 1 } });
  const replacement = store.memories(alice.id)[0];
  assert.equal(replacement.text, '以后叫我阿青'); assert.equal(replacement.kind, 'habit');
  assert.deepEqual(replacement.sources, [turn.messageId]);
  assert.deepEqual(store.messages(alice.id), []);
});

test('自然更正支持一到两个字的新称呼，遗忘后只有正向新值可成为替换', t => {
  const { store, alice, input, apply } = fixture(t);
  for (const [raw, quote, replacementQuote, expected] of [
    ['更正一下，以后叫我栗。', '更正一下', '栗', '以后叫我栗'],
    ['以后别叫我小胖了，叫我小栗。', '以后别叫我小胖了', '小栗', '叫我小栗'],
    ['对了，忘掉小胖这个名字。今后叫我小栗吧。', '忘掉小胖这个名字', '小栗', '今后叫我小栗吧'],
  ]) {
    const memory = store.remember(alice.id, '叫我小胖', [], { kind: 'habit' });
    const turn = input(raw);
    assert.deepEqual(apply(turn, { memoryEdits: [{ id: memory, quote, replacementQuote }] }), {
      changed: true, edited: true, memoryOutcome: { action: 'corrected', count: 1 },
    }, raw);
    const saved = store.memories(alice.id)[0];
    assert.equal(saved.text, expected); assert.equal(saved.kind, 'habit');
    assert.deepEqual(saved.sources, [turn.messageId]);
    store.forget(alice.id, { memoryId: saved.id });
  }
});

test('更正短地点引用时保留其原文事实属性，不只留下孤立地点名', t => {
  const { store, alice, bob, input, apply } = fixture(t);
  const original = input('我住北京。');
  const memory = store.remember(alice.id, '我住北京', [original.messageId]);
  const other = store.remember(bob.id, '我住北京');
  const turn = input('更正一下，我现在住上海。');
  assert.deepEqual(apply(turn, { memoryEdits: [{ id: memory, quote: '更正一下', replacementQuote: '上海' }] }), {
    changed: true, edited: true, memoryOutcome: { action: 'corrected', count: 1 },
  });
  assert.equal(store.memories(alice.id)[0].text, '我现在住上海');
  assert.deepEqual(store.memories(alice.id)[0].sources, [turn.messageId]);
  assert.deepEqual(store.messages(alice.id), []);
  assert.equal(store.memories(bob.id)[0].id, other);
});

test('模型漏掉替换字段时仍可从明确正向新事实分句更正称呼或住址', t => {
  const { store, alice, input, apply } = fixture(t);
  for (const [old, kind, raw, quote, expected] of [
    ['叫我团子', 'habit', '以后别叫我团子了，叫我小禾。', '以后别叫我团子了', '叫我小禾'],
    ['我住北京', 'fact', '更正一下，我现在住上海。', '更正一下', '我现在住上海'],
  ]) {
    const memory = store.remember(alice.id, old, [], { kind });
    const turn = input(raw);
    assert.deepEqual(apply(turn, { memoryEdits: [{ id: memory, quote }] }), {
      changed: true, edited: true, memoryOutcome: { action: 'corrected', count: 1 },
    });
    const saved = store.memories(alice.id)[0];
    assert.equal(saved.text, expected); assert.deepEqual(saved.sources, [turn.messageId]);
    store.forget(alice.id, { memoryId: saved.id });
  }
});

test('漏字段回退不从猜测、转述、否定或无关属性中创建替换', t => {
  const { store, alice, input, apply } = fixture(t);
  for (const raw of [
    '别叫我团子了。可能以后叫我小禾。', '别叫我团子了。朋友说，叫我小禾。',
    '别叫我团子了。不要叫我小禾。', '别叫我团子了。我现在住上海。',
  ]) {
    const memory = store.remember(alice.id, '叫我团子', [], { kind: 'habit' });
    assert.deepEqual(apply(input(raw), { memoryEdits: [{ id: memory, quote: '别叫我团子了' }] }), {
      changed: true, edited: true, memoryOutcome: { action: 'forgotten', count: 1 },
    });
    assert.deepEqual(store.memories(alice.id), []);
  }
});

test('独立否定请求不会阻止另一分句的明确遗忘，前置转述和假设仍保持作用域', t => {
  const { store, alice, input, apply } = fixture(t);
  const birthday = store.remember(alice.id, '我的生日是六月一日');
  const original = input('旧地址在北京。');
  const address = store.remember(alice.id, '旧地址在北京', [original.messageId]);
  const turn = input('不要忘记我的生日，但忘掉旧地址。');
  assert.deepEqual(apply(turn, { memoryEdits: [{ id: address, quote: '忘掉旧地址' }] }), {
    changed: true, edited: true, memoryOutcome: { action: 'forgotten', count: 1 },
  });
  assert.deepEqual(store.memories(alice.id).map(row => row.id), [birthday]);
  const nickname = store.remember(alice.id, '叫我小胖', [], { kind: 'habit' });
  for (const raw of ['朋友说，不要叫我小胖。', '如果他来问，不要叫我小胖。']) {
    assert.deepEqual(apply(input(raw), { memoryEdits: [{ id: nickname, quote: '不要叫我小胖' }] }), { changed: false, edited: false });
    assert.ok(store.memories(alice.id).some(row => row.id === nickname));
  }
});

test('明确遗忘目标不能被模型换成另一属性或另一个旧称呼', t => {
  const { store, alice, input, apply } = fixture(t);
  const birthday = store.remember(alice.id, '我的生日是六月一日');
  const nickname = store.remember(alice.id, '叫我小禾', [], { kind: 'habit' });
  for (const [raw, id] of [['忘掉旧地址。', birthday], ['别叫我团子。', nickname]]) {
    assert.deepEqual(apply(input(raw), { memoryEdits: [{ id, quote: raw }] }), { changed: false, edited: false });
    assert.ok(store.memories(alice.id).some(row => row.id === id));
  }
  assert.equal(apply(input('别叫我小禾了。'), { memoryEdits: [{ id: nickname, quote: '别叫我小禾了' }] }).edited, true);
  assert.equal(store.memories(alice.id)[0].id, birthday);
});

test('明确事实末尾的这件事不降级为纯指代，也不能指向另一属性', t => {
  const { store, alice, input, apply } = fixture(t);
  const birthday = store.remember(alice.id, '我的生日是六月一日');
  const source = input('旧地址在河边');
  const address = store.remember(alice.id, '旧地址在河边', [source.messageId]);
  const turn = input('忘掉旧地址在河边这件事');
  assert.deepEqual(apply(turn, { memoryEdits: [{ id: birthday, quote: turn.raw }] }), { changed: false, edited: false });
  assert.deepEqual(apply(turn, { memoryEdits: [{ id: address, quote: turn.raw }] }), {
    changed: true, edited: true, memoryOutcome: { action: 'forgotten', count: 1 },
  });
  assert.deepEqual(store.memories(alice.id).map(row => row.id), [birthday]);
});

test('指代某个名字需要近期来源定位，无法定位时保留已有记忆', t => {
  const { store, alice, input, apply } = fixture(t);
  const memory = store.remember(alice.id, '叫我团子', [], { kind: 'habit' });
  assert.deepEqual(apply(input('以后别叫这个名字了。'), { memoryEdits: [{ id: memory, quote: '以后别叫这个名字了' }] }), { changed: false, edited: false });
  store.message(alice.id, 'assistant', '今天心情怎么样？', { memories: [memory] });
  assert.deepEqual(apply(input('以后别叫这个名字了。'), { memoryEdits: [{ id: memory, quote: '以后别叫这个名字了' }] }), { changed: false, edited: false });
  store.message(alice.id, 'assistant', '团子，回来啦。', { memories: [memory] });
  assert.equal(apply(input('以后别叫这个名字了。'), { memoryEdits: [{ id: memory, quote: '以后别叫这个名字了' }] }).edited, true);
});

test('模型不能从忘记指令中提取旧值或无关文字伪装替换', t => {
  const { store, alice, input, apply } = fixture(t);
  for (const [raw, replacementQuote] of [
    ['以后别叫我小胖了。', '小胖'],
    ['忘掉小胖这个名字，小栗是我朋友。', '小栗'],
    ['忘掉小胖这个名字。', '并不存在的新名字'],
  ]) {
    const memory = store.remember(alice.id, '叫我小胖', [], { kind: 'habit' });
    const turn = input(raw);
    assert.deepEqual(apply(turn, { memoryEdits: [{ id: memory, quote: raw, replacementQuote }] }), {
      changed: true, edited: true, memoryOutcome: { action: 'forgotten', count: 1 },
    }, raw);
    assert.deepEqual(store.memories(alice.id), []);
  }
});

test('无明确意图、假设、否定请求和伪造更正均不能删除已有记忆', t => {
  const { store, alice, input, apply } = fixture(t);
  const memory = store.remember(alice.id, '以后叫我阿青');
  for (const [raw, quote, replacementQuote] of [
    ['今天真开心。', '今天真开心', undefined],
    ['如果我让你忘掉阿青这个称呼，会怎样？', '忘掉阿青这个称呼', undefined],
    ['不要忘记阿青这个称呼。', '忘记阿青这个称呼', undefined],
    ['你忘记了我的生日。', '忘记了我的生日', undefined],
    ['朋友说，忘掉阿青这个称呼。', '忘掉阿青这个称呼', undefined],
    ['忘掉阿青这个称呼会怎么样？', '忘掉阿青这个称呼', undefined],
    ['更正一下，以后叫我小鱼。', '更正一下', '以后叫我阿明'],
    ['更正一下，可能以后叫我小鱼。', '更正一下', '以后叫我小鱼'],
  ]) {
    assert.deepEqual(apply(input(raw), { memoryEdits: [{ id: memory, quote, replacementQuote }] }), { changed: false, edited: false });
    assert.equal(store.memories(alice.id)[0].id, memory);
  }
});

test('同一次更正可以更新具有共同来源的两条记忆，新值不被后续级联误删', t => {
  const { store, alice, input, apply } = fixture(t);
  const original = input('我喜欢红色，以后叫我小胖。');
  const color = store.remember(alice.id, '我喜欢红色', [original.messageId]);
  const nickname = store.remember(alice.id, '以后叫我小胖', [original.messageId], { kind: 'habit' });
  const turn = input('更正一下，我喜欢蓝色。以后叫我阿青。');
  const result = apply(turn, { memoryEdits: [
    { id: color, quote: '更正一下', replacementQuote: '我喜欢蓝色' },
    { id: nickname, quote: '更正一下', replacementQuote: '以后叫我阿青' },
  ] });
  assert.deepEqual(result, { changed: true, edited: true, memoryOutcome: { action: 'corrected', count: 2 } });
  assert.deepEqual(store.memories(alice.id).map(row => row.text), ['我喜欢蓝色', '以后叫我阿青']);
  assert.deepEqual(store.messages(alice.id), []);
});

test('自然遗忘拒绝另一用户的记忆 ID、伪造 ID 与非本轮引用', t => {
  const { store, alice, bob, input, apply } = fixture(t);
  const own = store.remember(alice.id, '阿青这个称呼'), foreign = store.remember(bob.id, '乙的称呼');
  const turn = input('忘掉阿青这个称呼。');
  for (const edit of [
    { id: foreign, quote: '忘掉阿青这个称呼' }, { id: 'invented-id', quote: '忘掉阿青这个称呼' },
    { id: own, quote: '删掉阿青这个称呼' },
  ]) assert.deepEqual(apply(turn, { memoryEdits: [edit] }), { changed: false, edited: false });
  assert.equal(store.memories(alice.id)[0].id, own);
  assert.equal(store.memories(bob.id)[0].id, foreign);
});

test('关闭自动长期记忆仍允许用户明确更正与遗忘', t => {
  const { store, alice, input, apply } = fixture(t);
  store.updateConfig({ autoMemory: false });
  apply(input('我喜欢绿色。'), { quotes: ['我喜欢绿色'] });
  assert.equal(store.memories(alice.id).length, 0);
  const memory = store.remember(alice.id, '以后叫我小胖', [], { kind: 'habit' });
  apply(input('更正一下，以后叫我阿青。'), { memoryEdits: [{ id: memory, quote: '更正一下', replacementQuote: '以后叫我阿青' }] });
  assert.equal(store.memories(alice.id)[0].text, '以后叫我阿青');
});

test('来源引用有数量及长度上限，不截断保存无法核对的文本', t => {
  const { store, alice, input, apply } = fixture(t);
  const contexts = [input('甲'.repeat(200)).messageId, input('乙'.repeat(200)).messageId, input('丙'.repeat(201)).messageId];
  const turn = input('丁'.repeat(200));
  for (const contextIds of [[contexts[0], contexts[1]], [contexts[2]], contexts]) {
    apply(turn, { memoryCandidates: [{ quote: turn.raw, kind: 'experience', contextIds }] });
  }
  assert.equal(store.memories(alice.id).length, 0);
  apply(turn, { memoryCandidates: [{ quote: turn.raw, kind: 'experience', contextIds: [contexts[0]] }] });
  assert.ok(store.memories(alice.id)[0].text.length < 500);
});
