import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../src/store.mjs';
import { Bot, proactiveAllowed, reminderInput } from '../src/bot.mjs';
import { CompanionModel } from '../src/model.mjs';
import { Secrets } from '../src/secrets.mjs';
import { createAdminServer } from '../src/server.mjs';

const epoch = Date.parse('2026-11-12T08:00:00+08:00');
function setup() { let now = epoch; const store = new Store(':memory:', { now: () => now }); const alice = store.addUser('alice-openid', '甲'), bob = store.addUser('bob-openid', '乙'); return { store, alice, bob, advance: ms => now += ms }; }
const packet = (openid, id, content, at = epoch) => ({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { id, content, timestamp: new Date(at).toISOString(), author: { user_openid: openid } } });
const answer = bubbles => ({ bubbles, quotes: [], voice: false, sources: [], memoryIds: [] });
const immediate = async () => {};

function adminLoginFixture(options = {}) {
  const server = createAdminServer({ secrets: { verify: password => password === 'fixture-admin-password' }, publicOrigin: 'https://admin.example.com', ...options });
  const handle = server.listeners('request')[0];
  return async ({ remoteAddress = '127.0.0.1', realIp, forwardedFor, host = 'admin.example.com', origin = 'https://admin.example.com', password = 'fixture-admin-password' } = {}) => {
    const req = Readable.from([Buffer.from(JSON.stringify({ password }))]);
    Object.assign(req, { method: 'POST', url: '/api/login', socket: { remoteAddress }, headers: { host, origin, 'content-type': 'application/json', ...(realIp === undefined ? {} : { 'x-real-ip': realIp }), ...(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }) } });
    const result = {};
    const res = { socket: { localPort: 3210 }, writeHead(status, headers) { Object.assign(result, { status, headers }); }, end(body) { result.body = JSON.parse(body); } };
    await handle(req, res); return result;
  };
}

test('model request contains only this user’s memories and history; cost is settled', async () => {
  const { store, alice, bob } = setup();
  try {
    store.remember(alice.id, '甲的私人信息'); store.message(alice.id, 'user', '甲的私密正文'); store.message(bob.id, 'user', '乙的问候');
    let request;
    const model = new CompanionModel({ store, secrets: { values: () => ({ deepseekKey: 'test-secret' }) }, fetchImpl: async (_url, options) => { request = JSON.parse(options.body); return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer(['你好呀'])) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }); } });
    assert.deepEqual((await model.respond(bob.id)).bubbles, ['你好呀']);
    assert.match(JSON.stringify(request), /乙的问候/); assert.doesNotMatch(JSON.stringify(request), /甲的私人|甲的私密/);
    assert.ok(Math.abs(store.usage().spent - 0.00036) < 1e-10);
  } finally { store.close(); }
});

test('correcting memory removes source and derived history, blocks replay, leaves other user intact', () => {
  const { store, alice, bob } = setup();
  try {
    const source = store.inbound(alice.id, 'remote-a', '我住旧地址', 'text');
    const memory = store.remember(alice.id, '我住旧地址', [source]);
    store.message(alice.id, 'assistant', '原来的旧地址', { sources: [source], memories: [memory] });
    store.message(bob.id, 'user', '乙的独立内容');
    store.forget(alice.id, { memoryId: memory, replacement: '我住新地址' });
    assert.deepEqual(store.messages(alice.id), []); assert.equal(store.memories(alice.id)[0].text, '我住新地址');
    assert.equal(store.messages(bob.id).length, 1);
    assert.equal(store.inbound(alice.id, 'remote-a', '我住旧地址', 'text'), null);
  } finally { store.close(); }
});

test('personal overrides survive global changes; global off still wins and commands acknowledge', async () => {
  const { store, alice } = setup(); const sent = [];
  try {
    store.updateUser(alice.id, { prefs: { proactiveDaily: 4, proactiveEnabled: true } }); store.updateConfig({ proactiveDaily: 1, proactiveEnabled: false });
    assert.equal(store.preferences(alice.id).proactiveDaily, 4); assert.equal(store.preferences(alice.id).proactiveEnabled, false);
    const bot = new Bot({ store, model: { respond: () => { throw new Error('should not call AI'); } }, transport: { text: async (_id, text) => sent.push(text) }, sleep: immediate });
    await bot.accept(packet('alice-openid', 'settings-command', '/设置 次数 3'));
    assert.equal(store.user(alice.id).prefs.proactiveDaily, 3); assert.equal(sent.length, 1); assert.match(sent[0], /已保存/);
  } finally { store.close(); }
});

test('new input during bubbles cancels unsent old content and answers the new input', async () => {
  const { store } = setup(); const sent = []; let latest; let calls = 0;
  try {
    const model = { respond: async () => answer(++calls === 1 ? ['旧回复第一条', '不应发送的旧回复'] : ['重新理解的新回复']) };
    const bot = new Bot({ store, model, sleep: immediate, transport: { text: async (_id, text) => { sent.push(text); if (text === '旧回复第一条') latest = bot.accept(packet('alice-openid', 'input-2', '我改主意了')); } } });
    await bot.accept(packet('alice-openid', 'input-1', '你好')); await latest;
    assert.deepEqual(sent, ['旧回复第一条', '重新理解的新回复']);
  } finally { store.close(); }
});

test('forgetting during generation prevents old reply or extracted memory from being committed', async () => {
  const { store, alice } = setup(); let resolve; let entered;
  const started = new Promise(done => entered = done), output = new Promise(done => resolve = done); const sent = [];
  try {
    const bot = new Bot({ store, sleep: immediate, model: { respond: () => { entered(); return output; } }, transport: { text: async (_id, value) => sent.push(value) } });
    const work = bot.accept(packet('alice-openid', 'secret-input', '我喜欢旧秘密')); await started;
    store.forget(alice.id, { keyword: '旧秘密' }); resolve({ ...answer(['旧秘密回应']), quotes: ['我喜欢旧秘密'] }); await work;
    assert.equal(sent.length, 0); assert.equal(store.memories(alice.id).length, 0); assert.equal(store.messages(alice.id).length, 0);
  } finally { store.close(); }
});

test('budget reservations prevent overspend, optional work stops at 90%, month rolls over', () => {
  const { store, advance } = setup();
  try {
    store.updateConfig({ totalBudget: 1, fixedReserve: 0, safetyReserve: 0 });
    const first = store.reserve('conversation', 0.8); assert.equal(store.usage().level, 'warning'); store.settle(first, 0.9);
    assert.equal(store.usage().level, 'reduced'); assert.throws(() => store.reserve('proactive', 0.01, true), /预算/);
    assert.throws(() => store.reserve('conversation', 0.2), /预算/);
    store.reserve('conversation', 0.1); assert.equal(store.usage().level, 'stopped');
    advance(32 * 86400000); assert.equal(store.usage().spent, 0); assert.equal(store.usage().level, 'normal');
  } finally { store.close(); }
});

test('reminders catch up within grace, mark older ones missed, run when AI budget is exhausted', async () => {
  const { store, alice, advance } = setup(); const sent = [];
  try {
    store.updateConfig({ totalBudget: 0, fixedReserve: 0, safetyReserve: 0 });
    const catchup = store.reminder(alice.id, '喝水', epoch + 60000);
    const bot = new Bot({ store, model: { respond: () => { throw new Error('AI must not run'); } }, transport: { text: async (_id, text) => sent.push(text) } });
    advance(6 * 60000); await bot.tick(); await bot.tick(); assert.equal(sent.length, 1); assert.match(sent[0], /来晚了一点.*喝水/); assert.equal(store.reminders(alice.id).find(r => r.id === catchup).status, 'sent');
    const missed = store.reminder(alice.id, '出门', store.now() + 60000); advance(40 * 60000); await bot.tick(); assert.equal(sent.length, 1); assert.equal(store.reminders(alice.id).find(r => r.id === missed).status, 'missed');
    assert.equal(reminderInput('/提醒 5分钟后 喝水', epoch).due, epoch + 300000); assert.throws(() => reminderInput('/提醒 2026-02-31 08:00 喝水', epoch), /无效/);
  } finally { store.close(); }
});

test('unanswered proactive openings pause and a returning user clears the pause', () => {
  const { store, alice, advance } = setup();
  try {
    store.inbound(alice.id, 'hello', '你好', 'text'); advance(3 * 3600000); store.initiated(alice.id); advance(3 * 3600000); store.initiated(alice.id);
    assert.equal(store.user(alice.id).unanswered, 2); assert.equal(proactiveAllowed(store.user(alice.id), store.preferences(alice.id), store.usage(), store.now()), false);
    store.inbound(alice.id, 'back', '我回来啦', 'text'); assert.equal(store.user(alice.id).pause_until, 0); assert.equal(store.user(alice.id).unanswered, 0);
  } finally { store.close(); }
});

test('settings and memory persist; expired chat does not erase long-term memory; uncertain sends are not retried', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fatfish-test-')); let store;
  try {
    const path = join(dir, 'test.sqlite'); store = new Store(path, { now: () => epoch }); const user = store.addUser('alice');
    const source = store.message(user.id, 'user', '长期偏好', { at: epoch - 31 * 86400000 }); store.remember(user.id, '长期偏好', [source]); store.updateUser(user.id, { prefs: { autoVoice: false } });
    const reminder = store.reminder(user.id, '提醒', epoch + 60000); store.markReminder(reminder, 'sending'); store.prune(); store.close();
    store = new Store(path, { now: () => epoch + 120000 }); assert.equal(store.messages(user.id).length, 0); assert.equal(store.memories(user.id).length, 1); assert.equal(store.user(user.id).prefs.autoVoice, false); assert.equal(store.reminders(user.id)[0].status, 'uncertain'); assert.equal(store.dueReminders().length, 0);
  } finally { store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('admin authentication gates private data and rejects cross-origin writes; credentials never echo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fatfish-http-')); const { store } = setup();
  const secrets = new Secrets(join(dir, 'secrets.json'), { ADMIN_PASSWORD: 'fixture-admin-password', DEEPSEEK_API_KEY: 'fixture-api-secret' });
  const runtime = { gateway: 'ready', release: 'fixture-release', events: [] };
  const server = createAdminServer({ store, secrets, bot: { stop() {}, cancel() {} }, runtime, publicDir: join(process.cwd(), 'public') });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${origin}/api/health`); assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, release: 'fixture-release' });
    runtime.gateway = 'failed'; assert.equal((await fetch(`${origin}/api/health`)).status, 503);
    runtime.gateway = 'resumed'; assert.equal((await fetch(`${origin}/api/health`)).status, 200);
    assert.equal((await fetch(`${origin}/api/state`)).status, 401);
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'fixture-admin-password' }) });
    assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0];
    const response = await fetch(`${origin}/api/state`, { headers: { Cookie: cookie } }); assert.equal(response.status, 200); assert.doesNotMatch(await response.text(), /fixture-admin-password|fixture-api-secret|alice-openid/);
    assert.equal((await fetch(`${origin}/api/config`, { method: 'PUT', headers: { Cookie: cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('admin trusted loopback proxy keeps login failures separate for IPv4 and IPv6 visitors', async () => {
  for (const remoteAddress of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1']) {
    const login = adminLoginFixture({ trustProxy: true });
    for (let i = 0; i < 5; i++) assert.equal((await login({ remoteAddress, realIp: '192.0.2.10', password: 'wrong' })).status, 401);
    assert.equal((await login({ remoteAddress, realIp: '192.0.2.10' })).status, 429);
    assert.equal((await login({ remoteAddress, realIp: '2001:db8::20' })).status, 200);
    assert.equal((await login({ remoteAddress, realIp: '192.0.2.10' })).status, 429);
    assert.equal((await login({ remoteAddress, realIp: '198.51.100.30' })).status, 200);
  }
});

test('admin ignores proxy IP headers unless explicitly enabled for a loopback peer', async () => {
  for (const { trustProxy, remoteAddress } of [
    { remoteAddress: '127.0.0.1' }, { trustProxy: false, remoteAddress: '::1' },
    { trustProxy: true, remoteAddress: '203.0.113.10' }, { trustProxy: true, remoteAddress: '2001:db8::10' },
    { trustProxy: true, remoteAddress: '::ffff:203.0.113.10' },
  ]) {
    const login = adminLoginFixture({ trustProxy });
    for (let i = 0; i < 5; i++) assert.equal((await login({ remoteAddress, realIp: `192.0.2.${i + 1}`, password: 'wrong' })).status, 401);
    assert.equal((await login({ remoteAddress, realIp: '198.51.100.10', forwardedFor: '198.51.100.20' })).status, 429);
  }
});

test('admin falls back to the socket peer for absent or invalid proxy IPs and ignores X-Forwarded-For', async () => {
  for (const realIp of [undefined, '', 'invalid', '999.1.1.1', '192.0.2.1, 198.51.100.2', '192.0.2.1:4321', '[2001:db8::1]', ['192.0.2.1', '198.51.100.2']]) {
    const login = adminLoginFixture({ trustProxy: true });
    for (let i = 0; i < 5; i++) assert.equal((await login({ realIp, forwardedFor: `192.0.2.${i + 1}`, password: 'wrong' })).status, 401);
    assert.equal((await login({ forwardedFor: '198.51.100.10' })).status, 429);
  }
});

test('admin uses Secure cookies for the HTTPS public host and keeps SSH HTTP login usable', async () => {
  const login = adminLoginFixture();
  const publicLogin = await login(); assert.equal(publicLogin.status, 200);
  assert.match(publicLogin.headers['Set-Cookie'], /; Secure(?:;|$)/);
  for (const host of ['127.0.0.1:3210', 'localhost:3210']) {
    const localLogin = await login({ host, origin: `http://${host}` }); assert.equal(localLogin.status, 200);
    assert.doesNotMatch(localLogin.headers['Set-Cookie'], /; Secure(?:;|$)/);
    assert.match(localLogin.headers['Set-Cookie'], /; HttpOnly; SameSite=Strict;/);
  }
  const httpLogin = await adminLoginFixture({ publicOrigin: 'http://admin.example.com' })({ origin: 'http://admin.example.com' });
  assert.equal(httpLogin.status, 200); assert.doesNotMatch(httpLogin.headers['Set-Cookie'], /; Secure(?:;|$)/);
});

test('pending reminders respect cancellation and global off between sends', async () => {
  for (const action of ['cancel', 'disable']) {
    const { store, alice, advance } = setup(); const sent = [];
    try {
      store.reminder(alice.id, '先发这条', epoch + 60000);
      const second = store.reminder(alice.id, '尚未发送', epoch + 60001);
      const bot = new Bot({ store, transport: { text: async (_id, text) => { sent.push(text); if (action === 'cancel') store.cancelReminder(alice.id, second); else store.updateConfig({ enabled: false }); } } });
      advance(120000); await bot.tick(); assert.equal(sent.length, 1); assert.match(sent[0], /先发这条/);
      assert.equal(store.reminders(alice.id).find(r => r.id === second).status, action === 'cancel' ? 'cancelled' : 'pending');
    } finally { store.close(); }
  }
});

test('explicit memories keep provenance for deletion and remain available beyond 100 entries', async () => {
  const { store, alice } = setup();
  try {
    const bot = new Bot({ store, sleep: immediate, transport: { text: async () => {} } });
    await bot.accept(packet('alice-openid', 'remember-source', '/记住 我喜欢蓝色'));
    const memory = store.memories(alice.id)[0]; assert.equal(memory.sources.length, 1);
    store.forget(alice.id, { memoryId: memory.id }); assert.ok(!store.messages(alice.id).some(m => m.content.includes('蓝色')));
    for (let i = 0; i < 101; i++) store.remember(alice.id, `偏好 ${i}`);
    assert.equal(store.memories(alice.id).length, 101); assert.match(bot.command(alice.id, '/记忆 21'), /偏好 100/);
  } finally { store.close(); }
});

test('voice synthesis failure falls back to the same text and records only the delivered text', async () => {
  const { store, alice } = setup(); const sent = [];
  try {
    const bot = new Bot({ store, sleep: immediate, model: { respond: async () => answer(['你好，今天怎么样？']) }, voice: { synthesize: async () => { throw new Error('voice unavailable'); } }, transport: { text: async (_id, text) => sent.push(text), audio: async () => assert.fail('no audio should be sent') } });
    await bot.accept(packet('alice-openid', 'voice-fallback', '用语音回复我'));
    assert.deepEqual(sent, ['你好，今天怎么样？']);
    const replies = store.messages(alice.id).filter(m => m.role === 'assistant'); assert.equal(replies.length, 1); assert.equal(replies[0].kind, 'text');
  } finally { store.close(); }
});

test('media input uses approved image URLs and reference transcription without turning guesses into memories', async () => {
  const { store, alice } = setup(); const sent = [], seen = [];
  try {
    const bot = new Bot({ store, sleep: immediate, model: { respond: async (_id, options) => { seen.push(options.images); return { ...answer(['收到啦']), quotes: ['我喜欢蓝色'] }; } }, transport: { text: async (_id, text) => sent.push(text) } });
    const voice = packet('alice-openid', 'voice-input', ''); voice.d.attachments = [{ content_type: 'audio/wav', asr_refer_text: '我喜欢蓝色' }]; await bot.accept(voice);
    const picture = packet('alice-openid', 'picture-input', ''); picture.d.attachments = [{ content_type: 'image/png', url: 'https://example.qpic.cn/image.png' }]; await bot.accept(picture);
    const unsupported = packet('alice-openid', 'unsafe-image', ''); unsupported.d.attachments = [{ content_type: 'image/png', url: 'http://127.0.0.1/private' }]; await bot.accept(unsupported);
    assert.deepEqual(seen, [[], ['https://example.qpic.cn/image.png']]); assert.equal(store.memories(alice.id).length, 0); assert.match(sent.at(-1), /附件/);
    assert.match(store.messages(alice.id)[0].content, /参考转写/); assert.ok(!store.messages(alice.id).some(m => m.content.includes('qpic.cn')));
  } finally { store.close(); }
});

test('real QQ multimedia host reaches image understanding instead of unsupported attachment fallback', async () => {
  const { store } = setup(); let images; const sent = [];
  try {
    const bot = new Bot({ store, sleep: immediate, model: { respond: async (_id, input) => { images = input.images; return answer(['图片收到了']); } }, transport: { text: async (_id, text) => sent.push(text) } });
    const input = packet('alice-openid', 'real-image-shape', ''); input.d.attachments = [{ content_type: 'image/jpeg', url: 'https://multimedia.nt.qq.com.cn/example.jpg', size: 1024 }];
    await bot.accept(input); assert.deepEqual(sent, ['图片收到了']); assert.deepEqual(images, ['https://multimedia.nt.qq.com.cn/example.jpg']);
  } finally { store.close(); }
});

test('blank JSON-mode output gets one budgeted recovery attempt instead of the generic stuck reply', async () => {
  const { store, alice } = setup(); const requests = [];
  try {
    store.message(alice.id, 'user', '[语音参考转写，可能不准确] 你好');
    const model = new CompanionModel({ store, secrets: { values: () => ({ deepseekKey: 'fixture-key' }) }, fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: requests.length === 1 ? '   ' : '你好呀，听见你啦。' } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    } });
    const result = await model.respond(alice.id); assert.deepEqual(result.bubbles, ['你好呀，听见你啦。']); assert.deepEqual(result.quotes, []);
    assert.equal(requests.length, 2); assert.equal(requests[0].response_format.type, 'json_object'); assert.equal(requests[1].response_format, undefined);
    assert.ok(Math.abs(store.usage().spent - 0.00072) < 1e-10);
  } finally { store.close(); }
});

test('blank recovery stops after two calls and cannot bypass the budget', async () => {
  for (const budget of [100, 0.02]) {
    const { store, alice } = setup(); let calls = 0;
    try {
      store.updateConfig({ totalBudget: budget, fixedReserve: 0, safetyReserve: 0 });
      store.message(alice.id, 'user', '你好');
      const model = new CompanionModel({ store, secrets: { values: () => ({ deepseekKey: 'fixture-key' }) }, fetchImpl: async () => {
        calls++; return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '' } }], usage: { prompt_tokens: 5000, completion_tokens: 1000 } });
      } });
      await assert.rejects(model.respond(alice.id), budget === 100 ? /有效回复/ : /预算/); assert.equal(calls, budget === 100 ? 2 : 1);
    } finally { store.close(); }
  }
});
