import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Bot } from '../src/bot.mjs';
import { createAdminServer } from '../src/server.mjs';
import { QqApi } from '../scripts/lib/qq-api.mjs';

const epoch = Date.parse('2026-11-17T12:00:00+08:00');
const answer = bubbles => ({ bubbles, voice: false, quotes: [], sources: [], memoryIds: [] });
const packet = (openid, id, content, at = epoch) => ({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { id, content, timestamp: new Date(at).toISOString(), author: { user_openid: openid } } });
const immediate = async () => {};
function fixture(t) {
  let now = epoch;
  const store = new Store(':memory:', { now: () => now });
  t.after(() => store.close());
  const alice = store.addUser('delete-alice'), bob = store.addUser('keep-bob');
  store.updateConfig({ autoVoice: false });
  return { store, alice, bob, advance: ms => now += ms };
}

function adminClient(store, bot) {
  const server = createAdminServer({ store, bot, secrets: { verify: value => value === 'fixture-password', status: () => ({ adminConfigured: true }) }, runtime: { gateway: 'ready' }, publicOrigin: 'https://admin.example.com' });
  const handle = server.listeners('request')[0];
  return async ({ path, method = 'GET', origin = 'https://admin.example.com', cookie, body = {} }) => {
    const req = Readable.from(method === 'GET' ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, url: path, socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'admin.example.com', origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } });
    const result = {}, res = { socket: { localPort: 3210 }, writeHead(status, headers) { Object.assign(result, { status, headers }); }, end(value) { result.body = JSON.parse(value); } };
    await handle(req, res); return result;
  };
}

test('删除成员持久清理个人正文与设置，保留另一成员、费用和邀请码消费状态', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fatfish-delete-member-')), path = join(dir, 'db');
  let store = new Store(path, { now: () => epoch });
  try {
    const code = store.invite(), alice = store.join('alice', code), bob = store.addUser('bob');
    store.updateUser(alice.id, { name: '待删名称', prefs: { autoVoice: false, proactiveDaily: 7 } });
    const source = store.inbound(alice.id, 'old-receipt', '待删个人正文', 'text');
    const memory = store.remember(alice.id, '待删相处习惯', [source], { kind: 'habit' });
    store.message(alice.id, 'assistant', '待删衍生回复', { sources: [source], memories: [memory] });
    const reminder = store.reminder(alice.id, '待删约定', epoch + 60000, { sources: [source] });
    store.prepareReminderDelivery(alice.id, reminder, '待删到点文案', { sources: [source], memories: [memory] });
    store.replySequence('old-receipt');
    const keptSource = store.message(bob.id, 'user', '另一成员保留正文');
    const keptMemory = store.remember(bob.id, '另一成员保留习惯', [keptSource], { kind: 'habit' });
    const keptReminder = store.reminder(bob.id, '另一成员保留约定', epoch + 120000);
    const cost = store.reserve('conversation', 1); store.settle(cost, 0.25);
    assert.deepEqual(store.deleteUser(alice.id), { deleted: true, id: alice.id, messages: 2, memories: 1, reminders: 1 });
    store.close(); store = new Store(path, { now: () => epoch });
    assert.equal(store.user(alice.id), undefined); assert.equal(store.byOpenid('alice'), undefined);
    assert.equal(store.claimLegacyMemberImport(), false);
    assert.deepEqual(store.messages(alice.id), []); assert.deepEqual(store.memories(alice.id), []); assert.deepEqual(store.reminders(alice.id), []);
    assert.equal(store.db.prepare('SELECT COUNT(*) total FROM memory_kinds WHERE memory_id=?').get(memory).total, 0);
    assert.equal(store.messages(bob.id)[0].id, keptSource); assert.equal(store.memories(bob.id)[0].id, keptMemory);
    assert.equal(store.reminders(bob.id)[0].id, keptReminder); assert.equal(store.memories(bob.id)[0].kind, 'habit');
    assert.equal(store.usage().spent, 0.25);
    assert.equal(store.join('alice', code), null);
    const newUser = store.join('alice', store.invite());
    assert.notEqual(newUser.id, alice.id); assert.equal(newUser.name, '新朋友'); assert.deepEqual(newUser.prefs, {});
    assert.equal(store.inbound(newUser.id, 'old-receipt', '旧事件重放不得恢复', 'text'), null);
    assert.deepEqual(store.messages(newUser.id), []); assert.deepEqual(store.memories(newUser.id), []);
    assert.equal(store.deleteUser(alice.id), null);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('首次空库仍可导入测试账号，删除最后一位成员后不能再次自动导入', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  assert.equal(store.claimLegacyMemberImport(), true);
  assert.equal(store.claimLegacyMemberImport(), false);
  const user = store.addUser('previous-test-account');
  store.deleteUser(user.id);
  assert.deepEqual(store.users(), []);
  assert.equal(store.claimLegacyMemberImport(), false);
  const upgrade = new Store(':memory:'); t.after(() => upgrade.close());
  const existing = upgrade.addUser('pre-upgrade-account');
  upgrade.deleteUser(existing.id);
  assert.equal(upgrade.claimLegacyMemberImport(), false);
});

test('管理员删除成员必须认证且同源，删除后重复访问返回不存在', async t => {
  const { store, alice, bob } = fixture(t);
  const bot = new Bot({ store }), request = adminClient(store, bot);
  bot.reminderCommands.ask(alice.id, { hour: 8, text: '待确认约定' });
  bot.cooldowns.set(alice.id, epoch + 10000);
  const path = `/api/users/${alice.id}`;
  assert.equal((await request({ path, method: 'DELETE' })).status, 401);
  assert.ok(store.user(alice.id));
  const login = await request({ path: '/api/login', method: 'POST', body: { password: 'fixture-password' } });
  const cookie = login.headers['Set-Cookie'].split(';')[0];
  assert.equal((await request({ path, method: 'DELETE', cookie, origin: 'https://other.example.com' })).status, 403);
  assert.ok(store.user(alice.id));
  const result = await request({ path, method: 'DELETE', cookie });
  assert.equal(result.status, 200); assert.equal(result.body.deleted, true); assert.equal(result.body.id, alice.id);
  assert.equal(bot.reminderCommands.pending.has(alice.id), false); assert.equal(bot.cooldowns.has(alice.id), false);
  assert.ok(store.user(bob.id));
  assert.equal((await request({ path, method: 'DELETE', cookie })).status, 404);
  assert.equal((await request({ path: `${path}/messages`, cookie })).status, 404);
  assert.deepEqual((await request({ path: '/api/state', cookie })).body.users.map(user => user.id), [bob.id]);
});

test('删除正在生成回复的成员会中止任务，拒绝旧提取结果并保留另一成员正常聊天', async t => {
  const { store, alice, bob } = fixture(t), started = Promise.withResolvers(), pending = Promise.withResolvers(), sent = [];
  let signal;
  const bot = new Bot({ store, sleep: immediate, model: { respond: async (id, options) => {
    if (id === alice.id) { signal = options.signal; started.resolve(); return pending.promise; }
    return answer(['乙的正常回复']);
  } }, transport: { text: async (openid, text) => sent.push({ openid, text }) } });
  bot.reminderCommands.ask(alice.id, { hour: 8, text: '删除后不应续约' });
  const work = bot.accept(packet(alice.openid, 'waiting-model', '我喜欢蓝色'));
  await started.promise;
  bot.cooldowns.set(alice.id, epoch + 10000);
  bot.deleteUser(alice.id);
  assert.equal(signal.aborted, true); assert.equal(bot.jobs.has(alice.id), false);
  assert.equal(bot.cooldowns.has(alice.id), false); assert.equal(bot.reminderCommands.pending.has(alice.id), false);
  await bot.accept(packet(bob.openid, 'bob-message', '你好'));
  pending.resolve({ ...answer(['不应发出的旧回复']), quotes: ['我喜欢蓝色'] }); await work;
  assert.deepEqual(sent, [{ openid: bob.openid, text: '乙的正常回复' }]);
  assert.deepEqual(store.messages(alice.id), []); assert.deepEqual(store.memories(alice.id), []);
  await bot.accept(packet(alice.openid, 'no-invitation', '还能聊天吗'));
  assert.equal(store.byOpenid(alice.openid), undefined);
});

test('删除等待收尾输入的成员不会重新创建待确认约定', async t => {
  const { store, alice } = fixture(t), started = Promise.withResolvers(), pending = Promise.withResolvers();
  const bot = new Bot({ store, sleep: () => { started.resolve(); return pending.promise; }, transport: { text: async () => assert.fail('deleted member must not get a new send') } });
  const work = bot.accept(packet(alice.openid, 'waiting-input', '八点叫我吃饭'));
  await started.promise; bot.deleteUser(alice.id); pending.resolve(); await work;
  assert.equal(bot.reminderCommands.pending.has(alice.id), false);
  assert.deepEqual(store.reminders(alice.id), []);
});

test('删除时已提交的文本请求可完成，但不留旧记录、不发后续气泡，也不写入重新加入的账号', async t => {
  const { store, alice } = fixture(t), started = Promise.withResolvers(), pending = Promise.withResolvers(), sent = [], logged = [];
  const bot = new Bot({ store, sleep: immediate, log: (...value) => logged.push(value), model: { respond: async () => answer(['已提交的一条', '不得提交的第二条']) }, transport: { text: async (_openid, text) => { sent.push(text); started.resolve(); await pending.promise; } } });
  const work = bot.accept(packet(alice.openid, 'inflight-text', '你好'));
  await started.promise; bot.deleteUser(alice.id);
  const rejoined = store.join(alice.openid, store.invite());
  pending.resolve(); await work;
  assert.deepEqual(sent, ['已提交的一条']); assert.deepEqual(logged, []);
  assert.deepEqual(store.messages(alice.id), []); assert.deepEqual(store.messages(rejoined.id), []);
});

test('删除等待语音合成或发送的成员，不继续发送语音附文或重建聊天记录', async t => {
  for (const stage of ['synthesis', 'audio']) {
    const { store, alice } = fixture(t), started = Promise.withResolvers(), pending = Promise.withResolvers(), sent = [], logged = [];
    store.updateConfig({ voiceWithText: true });
    const bot = new Bot({ store, sleep: immediate, log: (...value) => logged.push(value), model: { respond: async () => answer(['语音测试']) },
      voice: { synthesize: async () => { if (stage === 'synthesis') { started.resolve(); await pending.promise; } return Buffer.from('fixture-audio'); } },
      transport: { text: async () => assert.fail('no follow-up text after deletion'), audio: async () => { sent.push('audio'); started.resolve(); await pending.promise; } } });
    const work = bot.accept(packet(alice.openid, `voice-${stage}`, '用语音回复我'));
    await started.promise; bot.deleteUser(alice.id); pending.resolve(); await work;
    assert.deepEqual(sent, stage === 'synthesis' ? [] : ['audio']); assert.deepEqual(logged, []);
    assert.deepEqual(store.messages(alice.id), []);
  }
});

test('删除主动生成中的成员不发送开场，其他成员的主动机会保持可用', async t => {
  const { store, alice, bob, advance } = fixture(t), started = Promise.withResolvers(), pending = Promise.withResolvers(), sent = [], logged = [];
  store.updateConfig({ intervalHours: 0.1 });
  store.inbound(alice.id, 'alice-before', '你好', 'text'); store.inbound(bob.id, 'bob-before', '你好', 'text'); advance(360001);
  const bot = new Bot({ store, sleep: immediate, log: (...value) => logged.push(value), model: { respond: async id => {
    if (id === alice.id) { started.resolve(); return pending.promise; }
    return answer(['乙的主动开场']);
  } }, transport: { text: async (openid, text) => sent.push({ openid, text }) } });
  const work = bot.tick(); await started.promise; bot.deleteUser(alice.id);
  pending.resolve(answer(['不应发送的主动开场'])); await work;
  assert.deepEqual(sent, [{ openid: bob.openid, text: '乙的主动开场' }]); assert.deepEqual(logged, []);
  assert.equal(bot.cooldowns.has(alice.id), false); assert.equal(store.user(bob.id).proactive_count, 1);
});

test('删除正在发送约定的成员后不发其剩余约定，也不影响另一成员的约定', async t => {
  const { store, alice, bob, advance } = fixture(t), started = Promise.withResolvers(), pending = Promise.withResolvers(), sent = [], logged = [];
  store.reminder(alice.id, '在途约定', epoch + 60000);
  store.reminder(alice.id, '不得发送的后续约定', epoch + 60001);
  const kept = store.reminder(bob.id, '乙的约定', epoch + 60002); advance(120000);
  const bot = new Bot({ store, log: (...value) => logged.push(value), transport: { text: async (openid, text) => {
    sent.push({ openid, text }); if (openid === alice.openid) { started.resolve(); await pending.promise; }
  } } });
  const work = bot.tick(); await started.promise; bot.deleteUser(alice.id); pending.resolve(); await work;
  assert.equal(sent.length, 2); assert.equal(sent[0].openid, alice.openid); assert.equal(sent[1].openid, bob.openid);
  assert.deepEqual(store.messages(alice.id), []); assert.deepEqual(store.reminders(alice.id), []); assert.deepEqual(logged, []);
  assert.equal(store.reminders(bob.id).find(row => row.id === kept).status, 'sent');
});

test('QQ 等待鉴权或上传时删除成员，不再提交实际消息请求', async t => {
  for (const stage of ['text-token', 'audio-upload', 'reminder-token']) {
    const { store, alice, advance } = fixture(t), started = Promise.withResolvers(), pending = Promise.withResolvers(), paths = [], logged = [];
    let signal;
    const api = new QqApi({ appId: '123456', appSecret: 'fixture-secret', fetchImpl: async (url, options) => {
      const path = new URL(url).pathname; paths.push(path);
      if (path.endsWith('/messages')) assert.fail('deletion must prevent the later message stage');
      if ((stage !== 'audio-upload' && path === '/app/getAppAccessToken') || path.endsWith('/files')) {
        signal = options.signal; started.resolve(); return pending.promise;
      }
      return Response.json({ access_token: 'fixture-token', expires_in: 3600 });
    } });
    const bot = new Bot({ store, sleep: immediate, log: (...value) => logged.push(value), model: { respond: async () => answer(['待发送消息']) },
      voice: { synthesize: async () => ({ bytes: Buffer.from('fixture-audio'), filename: 'fixture.wav' }) }, transport: api });
    let work;
    if (stage === 'reminder-token') {
      store.reminder(alice.id, '待发约定', epoch + 60000); advance(120000); work = bot.tick();
    } else work = bot.accept(packet(alice.openid, stage, stage === 'audio-upload' ? '用语音回复我' : '你好'));
    await started.promise; bot.deleteUser(alice.id);
    assert.equal(signal.aborted, true); assert.equal(bot.reminderJobs.size, 0);
    pending.resolve(Response.json(stage === 'audio-upload' ? { file_info: 'fixture-upload' } : { access_token: 'fixture-token', expires_in: 3600 }));
    await work;
    assert.equal(paths.some(path => path.endsWith('/messages')), false); assert.deepEqual(logged, []);
    assert.deepEqual(store.messages(alice.id), []);
  }
});
