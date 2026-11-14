import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Bot } from '../src/bot.mjs';
import { reminderInput } from '../src/reminders.mjs';
import { CompanionModel } from '../src/model.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const epoch = Date.parse('2026-11-13T00:30:00+08:00');
const packet = (id, content, at = epoch, openid = 'test-user') => ({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { id, content, timestamp: new Date(at).toISOString(), author: { user_openid: openid } } });

test('an agreement keeps its exact time while the character replies without reciting it, then arrives without another AI call', async () => {
  for (const [request, due, subject, reply, arrival] of [
    ['早上8点叫我吃饭', Date.parse('2026-11-13T08:00:00+08:00'), '吃饭', '行，包我身上。', '吃饭啦，先歇会儿。'],
    ['一分钟后叫我喝水', epoch + 60000, '喝水', '行，你先忙。', '喝水啦，歇一歇。'],
  ]) {
    let now = epoch, modelCalls = 0; const sent = [];
    const store = new Store(':memory:', { now: () => now }); const user = store.addUser('test-user');
    const bot = new Bot({ store, sleep: async () => {}, model: { respond: async (_id, { agreement }) => {
      modelCalls++; assert.equal(store.reminders(user.id).length, 1); assert.equal(agreement.due, due);
      return { bubbles: [reply], quotes: [], voice: false, reminderText: arrival };
    } }, transport: { text: async (_id, text) => sent.push(text) } });
    try {
      await bot.accept(packet('agreement-request', request));
      assert.equal(modelCalls, 1); assert.equal(store.reminders(user.id).length, 1); assert.deepEqual(sent, [reply]);
      const reminder = store.reminders(user.id)[0]; assert.ok(reminder); assert.equal(reminder.due, due); assert.equal(reminder.text, subject);
      assert.equal(store.messages(user.id, { context: true }).at(-1).kind, 'agreement');
      store.updateConfig({ totalBudget: 0, fixedReserve: 0, safetyReserve: 0 });
      now = reminder.due - 1; await bot.tick(); assert.deepEqual(sent, [reply]);
      now = reminder.due; await bot.tick(); assert.equal(store.reminders(user.id)[0].status, 'sent'); assert.equal(sent.at(-1), arrival); assert.equal(modelCalls, 1);
    } finally { store.close(); }
  }
});

test('explicit dates, dayparts, Chinese numbers and relative reminders resolve in Beijing time', () => {
  for (const [input, expected, content] of [
    ['今天早上8点叫我吃饭', '2026-11-13T08:00:00+08:00', '吃饭'],
    ['明天早上八点半提醒我吃饭', '2026-11-14T08:30:00+08:00', '吃饭'],
    ['请提醒我明天下午两点十五分喝水', '2026-11-14T14:15:00+08:00', '喝水'],
    ['今晚八点叫我出门', '2026-11-13T20:00:00+08:00', '出门'],
    ['后天 08:00 喊我起床', '2026-11-15T08:00:00+08:00', '起床'],
    ['/提醒 今天下午3点 开会', '2026-11-13T15:00:00+08:00', '开会'],
    ['五分钟后叫我喝水', '2026-11-13T00:35:00+08:00', '喝水'],
    ['半小时后提醒我休息', '2026-11-13T01:00:00+08:00', '休息'],
    ['提醒我五分钟后喝水', '2026-11-13T00:35:00+08:00', '喝水'],
  ]) assert.deepEqual(reminderInput(input, epoch), { due: Date.parse(expected), text: content }, input);
  assert.equal(reminderInput('今天8点叫我吃饭', epoch).needsConfirmation, true);
  assert.equal(reminderInput('早上8点叫我吃饭', Date.parse('2026-11-13T09:00:00+08:00')).due, Date.parse('2026-11-14T08:00:00+08:00'));
  assert.throws(() => reminderInput('今天早上25点叫我吃饭', epoch), /时间/);
});

test('ambiguous reminder confirmation is isolated, cancellable, expires and never silently rolls a past date forward', async () => {
  let now = epoch;
  const store = new Store(':memory:', { now: () => now }); const alice = store.addUser('test-user'), bob = store.addUser('other-user');
  const bot = new Bot({ store, sleep: async () => {}, model: { respond: async () => ({ bubbles: ['普通聊天'], quotes: [], voice: false }) }, transport: { text: async () => {} } });
  try {
    bot.command(alice.id, '今天8点叫我吃饭'); bot.command(bob.id, '明天晚上8点叫我散步');
    assert.equal(store.reminders(alice.id).length, 0); assert.equal(store.reminders(bob.id).length, 1);
    bot.command(alice.id, '早上'); assert.equal(store.reminders(alice.id)[0].due, Date.parse('2026-11-13T08:00:00+08:00'));
    bot.command(alice.id, '9点叫我散步'); bot.command(alice.id, '取消'); bot.command(alice.id, '明天'); assert.equal(store.reminders(alice.id).length, 1);
    bot.command(alice.id, '9点叫我散步'); now += 16 * 60000; bot.command(alice.id, '早上'); assert.equal(store.reminders(alice.id).length, 1);
    assert.throws(() => bot.command(alice.id, '今天凌晨0点叫我吃饭'), /未来/); assert.equal(store.reminders(alice.id).length, 1);
    for (const input of ['不要今天早上8点叫我吃饭', '每天早上8点叫我吃饭']) { assert.match(bot.command(alice.id, input), /没有创建|这一次/); assert.equal(store.reminders(alice.id).length, 1); }
    assert.equal(bot.command(alice.id, '以后叫我小明'), null);
  } finally { store.close(); }
});

test('AI failure still gives a natural truthful confirmation and repeat requests do not duplicate the agreement', async () => {
  const store = new Store(':memory:', { now: () => epoch }), user = store.addUser('test-user'), sent = [];
  const bot = new Bot({ store, sleep: async () => {}, model: { respond: async () => { throw new Error('network unavailable'); } }, transport: { text: async (_id, text) => sent.push(text) } });
  try {
    await bot.accept(packet('first', '早上8点叫我吃饭')); await bot.accept(packet('repeat', '早上8点叫我吃饭'));
    assert.equal(store.reminders(user.id).length, 1); assert.match(sent[0], /叫你/); assert.doesNotMatch(sent[0], /今天|明天|点|分|编号|已安排|卡住/);
    await bot.accept(packet('cancel', '不用叫我吃饭了')); assert.equal(store.reminders(user.id)[0].status, 'cancelled'); assert.match(sent.at(-1), /不叫你吃饭/);
  } finally { store.close(); }
});

test('forgetting a source clears the future wording that used it, without resurrecting it at delivery', async () => {
  let now = epoch; const store = new Store(':memory:', { now: () => now }), user = store.addUser('test-user'), sent = [];
  try {
    const source = store.message(user.id, 'user', '我喜欢秘密昵称'), memory = store.remember(user.id, '秘密昵称', [source]);
    const id = store.reminder(user.id, '吃饭', epoch + 60000);
    store.prepareReminderDelivery(user.id, id, '秘密昵称，吃饭啦', { sources: [source], memories: [memory] });
    store.forget(user.id, { memoryId: memory });
    const bot = new Bot({ store, transport: { text: async (_id, text) => sent.push(text) } });
    now += 60000; await bot.tick(); assert.match(sent[0], /吃饭/); assert.doesNotMatch(sent[0], /秘密昵称/);
  } finally { store.close(); }
});

test('ongoing chat knows only its user’s actual agreements and forgetting one removes derived replies', async () => {
  const store = new Store(':memory:', { now: () => epoch }), alice = store.addUser('alice'), bob = store.addUser('bob'); let request;
  try {
    const id = store.reminder(alice.id, '吃饭', epoch + 60000); store.reminder(bob.id, '乙的私密约定', epoch + 60000);
    store.message(alice.id, 'user', '你还记得我们的约定吗？');
    const model = new CompanionModel({ store, secrets: { values: () => ({ deepseekKey: 'test-key' }) }, fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body); return Response.json({ choices: [{ message: { content: JSON.stringify({ bubbles: ['记着呢，会来找你的～'] }) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    } });
    const response = await model.respond(alice.id); assert.match(JSON.stringify(request), /吃饭/); assert.doesNotMatch(JSON.stringify(request), /乙的私密约定/); assert.ok(response.sources.includes(`reminder:${id}`));
    store.message(alice.id, 'assistant', response.bubbles[0], { sources: response.sources });
    store.forget(alice.id, { keyword: '吃饭' });
    assert.equal(store.upcomingReminders(alice.id).length, 0); assert.equal(store.upcomingReminders(bob.id).length, 1);
    assert.ok(!store.messages(alice.id).some(m => m.role === 'assistant'));
  } finally { store.close(); }
});

test('existing agreements survive schema migration and prepared wording survives restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fatfish-agreement-')); let store; let now = epoch; const sent = [];
  try {
    const path = join(dir, 'test.sqlite'); store = new Store(path, { now: () => now }); const user = store.addUser('alice');
    const id = store.reminder(user.id, '喝水', epoch + 60000);
    for (const column of ['delivery_text', 'delivery_sources', 'delivery_memories', 'source_ids']) store.db.exec(`ALTER TABLE reminders DROP COLUMN ${column}`);
    store.close(); store = new Store(path, { now: () => now });
    assert.equal(store.reminders(user.id)[0].id, id); assert.equal(store.reminders(user.id)[0].due, epoch + 60000);
    store.prepareReminderDelivery(user.id, id, '我来啦～说好的喝水时间到了'); store.close();
    store = new Store(path, { now: () => now }); store.updateConfig({ totalBudget: 0, fixedReserve: 0, safetyReserve: 0 });
    const bot = new Bot({ store, transport: { text: async (_id, text) => sent.push(text) } }); now += 60000; await bot.tick();
    assert.deepEqual(sent, ['我来啦～说好的喝水时间到了']);
  } finally { store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a wording forgotten while another reminder is sending is not reused from an old queue snapshot', async () => {
  let now = epoch; const store = new Store(':memory:', { now: () => now }), user = store.addUser('alice'), sent = [];
  try {
    const memory = store.remember(user.id, '秘密昵称'); store.reminder(user.id, '喝水', epoch + 60000);
    const next = store.reminder(user.id, '吃饭', epoch + 60001); store.prepareReminderDelivery(user.id, next, '秘密昵称，吃饭啦', { memories: [memory] });
    const bot = new Bot({ store, transport: { text: async (_id, text) => { sent.push(text); if (sent.length === 1) store.forget(user.id, { memoryId: memory }); } } });
    now += 120000; await bot.tick(); assert.equal(sent.length, 2); assert.match(sent[1], /吃饭/); assert.doesNotMatch(sent[1], /秘密昵称/);
  } finally { store.close(); }
});
