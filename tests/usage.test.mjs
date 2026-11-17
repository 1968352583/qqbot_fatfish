import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Voice } from '../src/voice.mjs';
import { BAILIAN_MODEL } from '../src/bailian.mjs';

const epoch = Date.parse('2026-11-17T18:00:00+08:00');
const audio = Buffer.alloc(24044);
audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(24000, 24);
audio.writeUInt32LE(48000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
const audioUrl = 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.wav?Signature=private-fixture';
const synthesis = usage => Response.json({ output: { audio: { url: audioUrl } }, ...(usage === undefined ? {} : { usage }) });
function fixture(fetchImpl, patch = {}) {
  let now = epoch;
  const store = new Store(':memory:', { now: () => now });
  store.updateConfig({ voiceProvider: 'bailian', bailianWorkspace: 'llm-fixture', bailianPricePer10k: 1.4, ...patch });
  const voice = new Voice({ store, secrets: { values: () => ({ bailianKey: 'private-bailian-key', ttsKey: 'private-http-key' }) }, fetchImpl });
  return { store, voice, advance: ms => { now += ms; } };
}
const almost = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('项目月度费用按实际kind分组，总预算字段与预留逻辑保持兼容', () => {
  const { store } = fixture();
  try {
    const conversation = store.reserve('conversation', 0.2); store.settle(conversation, 0.1);
    const proactive = store.reserve('proactive', 0.1); store.settle(proactive, 0.03);
    const voice = store.reserve('voice', 0.02, false, { provider: 'bailian', estimatedCharacters: 100, pricePer10k: 2, outcome: 'pending' });
    const design = store.reserve('voice-design', 0, false, { provider: 'bailian', model: 'voice-enrollment', pricePer10k: 0, outcome: 'pending' });
    store.settle(design, 0, 'settled', { outcome: 'succeeded' });
    const usage = store.usage();
    almost(usage.spent, 0.15); assert.equal(usage.month, '2026-11'); assert.equal(usage.limit, 60); assert.equal(usage.level, 'normal');
    assert.deepEqual(usage.breakdown.map(row => row.kind), ['conversation', 'proactive', 'voice', 'voice-design']);
    assert.equal(usage.voice.calls, 2); almost(usage.voice.amount, 0.02); almost(usage.voice.reservedAmount, 0.02);
    assert.equal(usage.voice.pendingCalls, 1); assert.equal(usage.voice.estimatedCharacters, 100);
    assert.equal(usage.voice.byKind.find(row => row.kind === 'voice-design').calls, 1);
    store.settle(voice, undefined, 'estimated', { outcome: 'uncertain' });
    assert.equal(store.usage().voice.uncertainCalls, 1); almost(store.usage().voice.estimatedAmount, 0.02);
  } finally { store.close(); }
});

test('语音处理中保留预算预留，返回字符后换成供应商用量，不把输入估算重复相加', async () => {
  let resolve, started;
  const waiting = new Promise(done => { resolve = done; }), entered = new Promise(done => { started = done; });
  const { store, voice } = fixture(async (_url, options) => { if (options.method === 'POST') { started(); return waiting; } return new Response(audio); });
  try {
    const task = voice.synthesize('你好'); await entered;
    const pending = store.usage().voice;
    assert.equal(pending.calls, 1); assert.equal(pending.pendingCalls, 1); assert.equal(pending.estimatedCharacters, 4);
    almost(pending.reservedAmount, 4 / 10000 * 1.4);
    resolve(synthesis({ characters: 20 })); await task;
    const used = store.usage().voice;
    assert.equal(used.pendingCalls, 0); assert.equal(used.reportedCharacters, 20); assert.equal(used.estimatedCharacters, 0);
    assert.equal(used.reportedCharacterCalls, 1); assert.equal(used.unknownCharacterCalls, 0);
    almost(used.amount, 20 / 10000 * 1.4);
    assert.equal(used.recent[0].reportedCharacters, 20); assert.equal(used.recent[0].estimatedCharacters, 4);
    assert.equal(used.recent[0].model, BAILIAN_MODEL); assert.equal(used.recent[0].outcome, 'succeeded');
    store.updateConfig({ bailianPricePer10k: 900 });
    almost(store.usage().voice.amount, 20 / 10000 * 1.4); assert.equal(store.usage().voice.recent[0].pricePer10k, 1.4);
  } finally { store.close(); }
});

test('返回零字符有效，未返回或无效字符只记输入估算并明确标记', async () => {
  for (const billed of [0, undefined, -1, '20', 1.5]) {
    const { store, voice } = fixture(async (_url, options) => options.method === 'POST' ? synthesis(billed === undefined ? undefined : { characters: billed }) : new Response(audio));
    try {
      await voice.synthesize('你好');
      const usage = store.usage().voice, row = usage.recent[0];
      assert.equal(row.reportedCharacters, billed === 0 ? 0 : null);
      assert.equal(row.characterBasis, billed === 0 ? 'provider' : 'estimated');
      assert.equal(row.status, billed === 0 ? 'settled' : 'estimated');
      assert.equal(usage.reportedCharacterCalls, billed === 0 ? 1 : 0);
      assert.equal(usage.estimatedCharacters, billed === 0 ? 0 : 4);
      assert.equal(usage.uncertainCalls, 0, 'successful response without usage is not an uncertain API outcome');
    } finally { store.close(); }
  }
});

test('明确拒绝、连接不明与下载失败分别记录，已合成的字符和费用不会抹掉', async () => {
  for (const mode of ['rejected', 'uncertain', 'malformed', 'download']) {
    const { store, voice } = fixture(async (_url, options) => {
      if (mode === 'rejected') return new Response('private-provider-body', { status: 403 });
      if (mode === 'uncertain') throw new Error('private-network-detail');
      if (mode === 'malformed') return Response.json({ unrelated: true });
      return options.method === 'POST' ? synthesis({ characters: 20 }) : new Response('', { status: 502 });
    });
    try {
      await assert.rejects(voice.synthesize('你好'));
      const usage = store.usage().voice, row = usage.recent[0];
      if (mode === 'rejected') {
        assert.equal(row.status, 'rejected'); assert.equal(usage.rejectedCalls, 1); assert.equal(usage.estimatedCharacters, 0); assert.equal(usage.amount, 0);
      } else if (mode === 'download') {
        assert.equal(row.status, 'settled'); assert.equal(row.outcome, 'audio_failed'); assert.equal(usage.reportedCharacters, 20); assert.equal(usage.failedCalls, 1);
        almost(usage.amount, 20 / 10000 * 1.4);
      } else {
        assert.equal(row.status, 'estimated'); assert.equal(row.outcome, 'uncertain'); assert.equal(usage.uncertainCalls, 1); assert.equal(usage.estimatedCharacters, 4);
        almost(usage.amount, 4 / 10000 * 1.4);
      }
      assert.doesNotMatch(JSON.stringify(usage), /private|Signature|你好|audio\.wav/);
    } finally { store.close(); }
  }
});

test('音色设计列入语音调用并单独分组，未返回字符不虚构字符消耗', async () => {
  const { store, voice } = fixture(async () => Response.json({ output: { voice_id: `${BAILIAN_MODEL}-vd-fixture`, target_model: BAILIAN_MODEL, preview_audio: { data: audio.toString('base64') } } }));
  try {
    await voice.bailian.design({ prompt: '轻松自然的成年声音', text: '你好呀，今天有没有什么有趣的事情，讲给我听听吧。' });
    const usage = store.usage().voice;
    assert.equal(usage.calls, 1); assert.equal(usage.amount, 0); assert.equal(usage.unknownCharacterCalls, 1);
    assert.equal(usage.byKind[0].kind, 'voice-design'); assert.equal(usage.recent[0].model, 'voice-enrollment');
    assert.equal(usage.recent[0].reportedCharacters, null); assert.equal(usage.recent[0].estimatedCharacters, null);
  } finally { store.close(); }
});

test('HTTP语音明确拒绝不被catch改写，服务器错误保留估算，成功无字符也明确估算', async () => {
  for (const status of [401, 408, 502, 200]) {
    const { store, voice } = fixture(async () => new Response(status === 200 ? audio : 'provider-error', { status }), { voiceProvider: 'http', voiceEndpoint: 'https://tts.example.test/synthesize', voiceModel: 'fixture-tts', voicePricePer10k: 2 });
    try {
      if (status === 200) await voice.synthesize('你好'); else await assert.rejects(voice.synthesize('你好'));
      const usage = store.usage().voice, row = usage.recent[0];
      assert.equal(row.provider, 'http'); assert.equal(row.reportedCharacters, null);
      if (status === 401) { assert.equal(row.status, 'rejected'); assert.equal(row.outcome, 'rejected'); assert.equal(usage.amount, 0); }
      else { assert.equal(row.status, 'estimated'); assert.equal(row.outcome, status === 200 ? 'succeeded' : 'uncertain'); almost(usage.amount, 4 / 10000 * 2); }
    } finally { store.close(); }
  }
});

test('旧六列usage数据库迁移保留原金额；未知字符不能通过当前单价反推', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fatfish-usage-migration-'));
  const path = join(directory, 'legacy.sqlite'); let store;
  try {
    const old = new DatabaseSync(path);
    old.exec('CREATE TABLE usage (id TEXT PRIMARY KEY, month TEXT NOT NULL, kind TEXT NOT NULL, amount REAL NOT NULL, status TEXT NOT NULL, at INTEGER NOT NULL)');
    old.prepare('INSERT INTO usage VALUES (?,?,?,?,?,?)').run('legacy-voice', '2026-11', 'voice', 0.031, 'settled', epoch);
    old.prepare('INSERT INTO usage VALUES (?,?,?,?,?,?)').run('legacy-pending', '2026-11', 'voice', 0.009, 'reserved', epoch + 1);
    old.close();
    store = new Store(path, { now: () => epoch + 100 }); store.updateConfig({ bailianPricePer10k: 999 });
    const usage = store.usage();
    almost(usage.spent, 0.04); assert.equal(usage.voice.calls, 2); assert.equal(usage.voice.unknownCharacterCalls, 2);
    assert.equal(usage.voice.reportedCharacters, 0); assert.equal(usage.voice.estimatedCharacters, 0);
    for (const row of usage.voice.recent) { assert.equal(row.characterBasis, 'unknown'); assert.equal(row.reportedCharacters, null); assert.equal(row.estimatedCharacters, null); assert.equal(row.pricePer10k, null); }
    assert.equal(usage.voice.recent[0].status, 'estimated');
    store.db.prepare('INSERT INTO usage VALUES (?,?,?,?,?,?)').run('still-six-columns', '2026-11', 'conversation', 0.1, 'settled', epoch + 2);
    almost(store.usage().spent, 0.14);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('重启后未完成语音的预留转为结果不明估算，保存原字符估算和单价', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fatfish-usage-restart-')); let store;
  try {
    const path = join(directory, 'usage.sqlite');
    store = new Store(path, { now: () => epoch });
    store.reserve('voice', 0.01, false, { provider: 'bailian', model: BAILIAN_MODEL, estimatedCharacters: 50, pricePer10k: 2, outcome: 'pending' });
    store.close(); store = new Store(path, { now: () => epoch + 1000 });
    const usage = store.usage().voice;
    assert.equal(usage.pendingCalls, 0); assert.equal(usage.uncertainCalls, 1); assert.equal(usage.estimatedCharacters, 50);
    assert.equal(usage.recent[0].pricePer10k, 2); almost(usage.estimatedAmount, 0.01);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('最近语音最多20条跨月份展示，月度统计按北京时间切换', () => {
  const { store, advance } = fixture();
  try {
    for (let i = 0; i < 25; i++) {
      const id = store.reserve('voice', 0.001, false, { provider: 'http', estimatedCharacters: 10, outcome: 'pending' });
      store.settle(id, 0.001, 'estimated', { outcome: 'succeeded' }); advance(1000);
    }
    assert.equal(store.usage().voice.calls, 25); assert.equal(store.usage().voice.recent.length, 20);
    advance(Date.parse('2026-12-01T00:00:01+08:00') - store.now());
    const usage = store.usage(); assert.equal(usage.month, '2026-12'); assert.equal(usage.spent, 0); assert.equal(usage.voice.calls, 0);
    assert.equal(usage.voice.recent.length, 20); assert.ok(usage.voice.recent.every(row => row.month === '2026-11'));
  } finally { store.close(); }
});

test('语音元数据只存白名单字段，预算仍拦截付费调用，零成本本地语音不受云预算影响', () => {
  const { store } = fixture();
  try {
    const id = store.reserve('voice', 0.01, false, { provider: 'bailian', model: BAILIAN_MODEL, estimatedCharacters: 20, outcome: 'pending', text: '秘密台词', audio: 'private-audio', key: 'private-key', headers: { Authorization: 'private-token' } });
    assert.doesNotMatch(JSON.stringify(store.usage()), /秘密台词|private-/);
    assert.doesNotMatch(JSON.stringify(store.db.prepare('SELECT * FROM usage_details').all()), /秘密台词|private-/);
    store.settle(id, 0, 'rejected', { outcome: 'rejected' });
    store.updateConfig({ totalBudget: 0, fixedReserve: 0, safetyReserve: 0 });
    assert.throws(() => store.reserve('voice', 0.01, false, { provider: 'bailian' }), /预算/);
    assert.throws(() => store.reserve('voice-design', 0, false, { provider: 'bailian' }), /预算/);
    const local = store.reserve('voice', 0, false, { provider: 'system', model: 'macos-say', pricePer10k: 0, outcome: 'pending' });
    store.settle(local, 0, 'settled', { outcome: 'succeeded' });
    assert.equal(store.usage().voice.recent[0].characterBasis, 'not_applicable'); assert.equal(store.usage().spent, 0);
  } finally { store.close(); }
});
