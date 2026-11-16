import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Bot, proactiveAllowed, wantsQuiet } from '../src/bot.mjs';

const epoch = Date.parse('2026-11-17T12:00:00+08:00');
const answer = bubbles => ({ bubbles, quotes: [], voice: false, sources: [], memoryIds: [] });
const packet = (openid, id, content, at) => ({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { id, content, timestamp: new Date(at).toISOString(), author: { user_openid: openid } } });

test('a skipped opening sends nothing, consumes no opening allowance and keeps retry spacing across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fatfish-proactive-')), path = join(dir, 'db');
  let now = epoch, store = new Store(path, { now: () => now }), calls = 0;
  const sent = [], user = store.addUser('alice');
  store.updateConfig({ autoVoice: false, intervalHours: 0.1, proactiveRetryHours: 0.2 });
  store.inbound(user.id, 'hello', '上午好', 'text'); now += 360001;
  const makeBot = () => new Bot({ store, sleep: async () => {}, model: { respond: async () => { calls++; return calls === 1 ? { ...answer([]), skipped: true } : answer(['今天怎么样？']); } }, transport: { text: async (_id, text) => sent.push(text) } });
  try {
    await makeBot().tick();
    assert.equal(calls, 1); assert.deepEqual(sent, []);
    assert.equal(store.user(user.id).proactive_count, 0); assert.equal(store.user(user.id).unanswered, 0);
    assert.equal(store.messages(user.id).filter(m => m.role === 'assistant').length, 0);
    const stamp = store.user(user.id).last_proactive_check;
    store.close(); store = new Store(path, { now: () => now });
    now += 719999; await makeBot().tick(); assert.equal(calls, 1);
    assert.equal(store.user(user.id).last_proactive_check, stamp);
    now += 2; await makeBot().tick(); assert.equal(calls, 2); assert.equal(sent.length, 1);
    assert.equal(store.user(user.id).proactive_count, 1); assert.equal(store.user(user.id).unanswered, 1);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a failed proactive attempt retains spacing without incrementing unanswered', async () => {
  let now = epoch; const store = new Store(':memory:', { now: () => now }), user = store.addUser('alice');
  try {
    store.updateConfig({ intervalHours: 0.1, proactiveRetryHours: 0.2 });
    store.inbound(user.id, 'hello', '你好', 'text'); now += 360001;
    const bot = new Bot({ store, model: { respond: async () => { throw new Error('provider unavailable'); } } });
    await bot.tick();
    assert.equal(store.user(user.id).unanswered, 0);
    assert.equal(proactiveAllowed(store.user(user.id), store.config(), store.usage(), now + 1000), false);
  } finally { store.close(); }
});

test('proactive retry spacing is durable even while the provider request is still pending', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fatfish-inflight-')), path = join(dir, 'db');
  let now = epoch; const store = new Store(path, { now: () => now }), user = store.addUser('alice');
  let resume, started; const waiting = new Promise(resolve => { started = resolve; });
  try {
    store.updateConfig({ intervalHours: 0.1 }); store.inbound(user.id, 'hello', '你好', 'text'); now += 360001;
    const bot = new Bot({ store, model: { respond: () => { started(); return new Promise(resolve => { resume = () => resolve({ ...answer([]), skipped: true }); }); } } });
    const pending = bot.tick(); await waiting;
    const reopened = new Store(path, { now: () => now });
    try { assert.equal(proactiveAllowed(reopened.user(user.id), reopened.config(), reopened.usage(), now), false); assert.equal(reopened.user(user.id).proactive_count, 0); }
    finally { reopened.close(); }
    resume(); await pending;
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a natural quiet request pauses proactive chat while preserving the character’s own reply', async () => {
  let now = epoch; const store = new Store(':memory:', { now: () => now }), user = store.addUser('alice'), sent = [];
  try {
    store.updateConfig({ autoVoice: false, intervalHours: 0.1 });
    const bot = new Bot({ store, sleep: async () => {}, model: { respond: async () => answer(['行，你写。']) }, transport: { text: async (_id, text) => sent.push(text) } });
    await bot.accept(packet(user.openid, 'quiet', '先不聊了，我要把这段写完。', now));
    assert.deepEqual(sent, ['行，你写。']);
    assert.equal(store.user(user.id).busy_until, now + store.config().busyHours * 3600000);
    now += 3600000; assert.equal(proactiveAllowed(store.user(user.id), store.config(), store.usage(), now), false);
    await bot.accept(packet(user.openid, 'returned', '写完了', now));
    assert.equal(store.user(user.id).busy_until, 0);
    for (const text of ['我不想休息', '我明天要睡觉', '朋友说先不聊了', '“先不聊了”是什么意思？']) assert.equal(wantsQuiet(text), false, text);
  } finally { store.close(); }
});

test('natural forgetting discards the first reply and regenerates from cleaned records', async () => {
  const store = new Store(':memory:', { now: () => epoch }), user = store.addUser('alice'), other = store.addUser('bob'), sent = [];
  try {
    store.updateConfig({ autoVoice: false });
    const source = store.message(user.id, 'user', '叫我旧昵称');
    const memory = store.remember(user.id, '叫我旧昵称', [source], { kind: 'habit' });
    store.remember(other.id, '其他用户的独立信息');
    let calls = 0;
    const model = { respond: async (id, options) => {
      calls++;
      if (calls === 1) return { ...answer(['当然啦，旧昵称']), memoryEdits: [{ id: memory, quote: '以后别叫旧昵称了' }] };
      assert.deepEqual(options.memoryOutcome, { action: 'forgotten', count: 1 });
      assert.equal('raw' in options, false);
      assert.equal(store.memories(id).length, 0);
      assert.ok(store.messages(id).every(m => !m.content.includes('旧昵称')));
      return answer(['好，那就不提了。']);
    } };
    const bot = new Bot({ store, model, sleep: async () => {}, transport: { text: async (_id, text) => sent.push(text) } });
    await bot.accept(packet(user.openid, 'forget', '以后别叫旧昵称了', epoch));
    assert.equal(calls, 2); assert.deepEqual(sent, ['好，那就不提了。']);
    assert.equal(store.memories(other.id).length, 1);
    assert.ok(store.messages(user.id).every(m => !m.content.includes('旧昵称')));
  } finally { store.close(); }
});

test('failure after a committed memory edit sends a safe acknowledgment without restoring the old value', async () => {
  const store = new Store(':memory:', { now: () => epoch }), user = store.addUser('alice'), sent = [];
  try {
    const source = store.message(user.id, 'user', '旧地址在河边');
    const memory = store.remember(user.id, '旧地址在河边', [source]);
    let calls = 0;
    const model = { respond: async () => { if (++calls === 2) throw new Error('budget exhausted'); return { ...answer(['我记得你在河边']), memoryEdits: [{ id: memory, quote: '忘掉旧地址在河边这件事' }] }; } };
    const bot = new Bot({ store, model, sleep: async () => {}, transport: { text: async (_id, text) => sent.push(text) } });
    await bot.accept(packet(user.openid, 'forget', '忘掉旧地址在河边这件事', epoch));
    assert.deepEqual(sent, ['好，那就不提了。']); assert.equal(store.memories(user.id).length, 0);
    assert.ok(store.messages(user.id).every(m => !m.content.includes('河边')));
  } finally { store.close(); }
});

test('new input during a memory acknowledgment cancels the stale reply', async () => {
  const store = new Store(':memory:', { now: () => epoch }), user = store.addUser('alice'), sent = [];
  try {
    store.updateConfig({ autoVoice: false });
    const source = store.message(user.id, 'user', '叫我小秘密');
    const memory = store.remember(user.id, '叫我小秘密', [source]);
    let calls = 0, resume, started;
    const waiting = new Promise(resolve => { started = resolve; });
    const model = { respond: async () => {
      if (++calls === 1) return { ...answer(['小秘密']), memoryEdits: [{ id: memory, quote: '忘掉小秘密这个称呼' }] };
      if (calls === 2) { started(); return new Promise(resolve => { resume = () => resolve(answer(['旧一轮确认'])); }); }
      return answer(['新话题']);
    } };
    const bot = new Bot({ store, model, sleep: async () => {}, transport: { text: async (_id, text) => sent.push(text) } });
    const first = bot.accept(packet(user.openid, 'forget', '忘掉小秘密这个称呼', epoch));
    await waiting; await bot.accept(packet(user.openid, 'new', '换个话题吧', epoch)); resume(); await first;
    assert.deepEqual(sent, ['新话题']); assert.equal(store.memories(user.id).length, 0);
  } finally { store.close(); }
});

test('memory categories survive restart and old records migrate without losing text or reminders', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fatfish-memory-')), path = join(dir, 'db');
  let store = new Store(path, { now: () => epoch });
  try {
    const user = store.addUser('alice'); store.remember(user.id, '原来的记忆'); store.reminder(user.id, '喝水', epoch + 60000);
    store.db.exec('DROP TABLE memory_kinds; ALTER TABLE users DROP COLUMN last_proactive_check;');
    store.close(); store = new Store(path, { now: () => epoch });
    assert.equal(store.memories(user.id)[0].kind, 'fact'); assert.equal(store.reminders(user.id).length, 1);
    const source = store.message(user.id, 'user', '咱们叫它午饭计划');
    const memory = store.remember(user.id, '咱们叫它午饭计划', [source], { kind: 'experience' });
    store.close(); store = new Store(path, { now: () => epoch });
    assert.equal(store.memories(user.id).find(m => m.id === memory).kind, 'experience');
    store.forget(user.id, { memoryId: memory });
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM memory_kinds WHERE memory_id=?').get(memory).n, 0);
    // The older release's five-column insert remains usable after migration.
    store.db.prepare('INSERT INTO memories VALUES (?,?,?,?,?)').run('legacy-insert', user.id, '兼容旧发布版本', '[]', epoch);
    assert.equal(store.memories(user.id).find(m => m.id === 'legacy-insert').kind, 'fact');
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
