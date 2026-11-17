import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { CompanionModel } from '../src/model.mjs';
import { modelTokenUsage } from '../src/usage.mjs';

const epoch = Date.parse('2026-11-17T18:00:00+08:00');
const fullUsage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 70, prompt_cache_miss_tokens: 30, completion_tokens_details: { reasoning_tokens: 8 } };
const response = (usage = fullUsage, content = '{"bubbles":["你好呀"]}', extra = {}) => Response.json({ usage, model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { content } }], ...extra });
const almost = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
function fixture(fetchImpl) {
  let at = epoch;
  const store = new Store(':memory:', { now: () => at });
  const user = store.addUser('private-openid', 'private-name');
  store.message(user.id, 'user', 'private-chat-body');
  const model = new CompanionModel({ store, secrets: { values: () => ({ deepseekKey: 'private-key' }) }, fetchImpl });
  return { store, user, model, time: value => { at = value; } };
}

test('每次模型调用先预留，供应商返回后分别保存总量和子集，不重复计费', async () => {
  let resolve, entered;
  const waiting = new Promise(done => { resolve = done; }), started = new Promise(done => { entered = done; });
  const { store, user, model } = fixture(async () => { entered(); return waiting; });
  try {
    const task = model.respond(user.id); await started;
    const pending = store.usage().model;
    assert.equal(pending.calls, 1); assert.equal(pending.pendingCalls, 1); assert.ok(pending.reservedAmount > 0);
    assert.equal(pending.totalTokens, null); assert.equal(pending.recent[0].purpose, 'conversation');
    assert.equal(pending.recent[0].tokenBasis, 'unknown'); assert.equal(pending.recent[0].outcome, 'pending');
    resolve(response()); await task;
    const used = store.usage().model;
    assert.equal(used.promptTokens, 100); assert.equal(used.completionTokens, 20); assert.equal(used.totalTokens, 120);
    assert.equal(used.cacheHitTokens, 70); assert.equal(used.cacheMissTokens, 30); assert.equal(used.reasoningTokens, 8);
    assert.equal(used.reportedTokenCalls, 1); assert.equal(used.unknownTokenCalls, 0); assert.equal(used.pendingCalls, 0);
    almost(used.amount, 0.00036); almost(used.settledAmount, 0.00036);
    assert.equal(used.byModel[0].model, 'deepseek-flash'); assert.equal(used.byKind[0].kind, 'conversation');
    store.updateConfig({ inputPrice: 99, outputPrice: 999 }); almost(store.usage().model.amount, 0.00036);
    assert.equal(store.usage().voice.calls, 0, 'model accounting must not pollute voice accounting');
  } finally { store.close(); }
});

test('零 token 有效，缺失和无效值不伪造；仅由已知输入输出补全总量', () => {
  assert.deepEqual(modelTokenUsage({ prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0, completion_tokens_details: { reasoning_tokens: 0 } }), {
    promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0,
  });
  for (const invalid of [-1, 1.5, '10', null, undefined, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, true]) {
    assert.deepEqual(modelTokenUsage({ prompt_tokens: invalid, completion_tokens: invalid, total_tokens: invalid, prompt_cache_hit_tokens: invalid, prompt_cache_miss_tokens: invalid, completion_tokens_details: { reasoning_tokens: invalid } }), {
      promptTokens: null, completionTokens: null, totalTokens: null, cacheHitTokens: null, cacheMissTokens: null, reasoningTokens: null,
    });
  }
  const partial = modelTokenUsage({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } });
  assert.equal(partial.totalTokens, 15); assert.equal(partial.cacheHitTokens, 2); assert.equal(partial.cacheMissTokens, null); assert.equal(partial.reasoningTokens, null);
  assert.equal(modelTokenUsage({ prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 }).totalTokens, null);
});

test('部分回报逐字段提供覆盖计数，未知 token 不通过费用倒推', async () => {
  const outputs = [response(undefined), response({ prompt_tokens: 100, completion_tokens: 20 }), response({ prompt_tokens: 10 }), response({ prompt_tokens: 0, completion_tokens: 0 })];
  // Explicitly remove usage: response(undefined) uses the helper's default.
  outputs[0] = Response.json({ choices: [{ message: { content: '{"bubbles":["嗯"]}' } }] });
  const { store, user, model } = fixture(async () => outputs.shift());
  try {
    for (let i = 0; i < 4; i++) await model.respond(user.id);
    const used = store.usage().model;
    assert.equal(used.calls, 4); assert.equal(used.reportedTokenCalls, 2); assert.equal(used.unknownTokenCalls, 2);
    assert.equal(used.promptTokens, 110); assert.equal(used.completionTokens, 20); assert.equal(used.totalTokens, 120);
    assert.equal(used.cacheHitTokens, null); assert.equal(used.cacheMissTokens, null); assert.equal(used.reasoningTokens, null);
    assert.deepEqual(used.tokenCoverage.promptTokens, { reportedCalls: 3, unknownCalls: 1 });
    assert.deepEqual(used.tokenCoverage.completionTokens, { reportedCalls: 2, unknownCalls: 2 });
    assert.deepEqual(used.tokenCoverage.reasoningTokens, { reportedCalls: 0, unknownCalls: 4 });
    assert.equal(used.recent[0].totalTokens, 0); assert.equal(used.recent[0].status, 'settled');
    assert.equal(used.recent[1].tokenBasis, 'provider'); assert.equal(used.recent[1].status, 'estimated');
    assert.equal(used.recent[3].tokenBasis, 'unknown'); assert.equal(used.recent[3].totalTokens, null);
    assert.ok(used.estimatedAmount > 0); assert.equal(used.uncertainCalls, 0);
  } finally { store.close(); }
});

test('空白与坏 JSON 的原调用和恢复调用分别保留用量，解析失败不能抹掉计费', async () => {
  for (const content of ['', '{broken-json']) {
    let calls = 0;
    const { store, user, model } = fixture(async () => response(fullUsage, ++calls === 1 ? content : '我在呢。'));
    try {
      assert.deepEqual((await model.respond(user.id)).bubbles, ['我在呢。']);
      const used = store.usage().model;
      assert.equal(calls, 2); assert.equal(used.calls, 2); assert.equal(used.failedCalls, 1);
      assert.equal(used.totalTokens, 240); almost(used.amount, 0.00072);
      assert.deepEqual(used.recent.map(row => [row.purpose, row.outcome]), [['recovery', 'succeeded'], ['conversation', 'failed']]);
      assert.equal(store.usage().breakdown.find(row => row.kind === 'conversation').failedCalls, 1);
    } finally { store.close(); }
  }
});

test('主动跳过、约定、记忆复调记录用途，合法 skip 是成功的模型调用', async () => {
  const { store, user, model } = fixture(async () => response(fullUsage, '{"decision":"skip","bubbles":[]}'));
  try {
    assert.equal((await model.respond(user.id, { proactive: true })).skipped, true);
    model.fetch = async () => response();
    await model.respond(user.id, { agreement: { action: 'cancelled', text: '喝水' } });
    await model.respond(user.id, { memoryOutcome: { action: 'forgotten', count: 1 } });
    const used = store.usage().model;
    assert.deepEqual(used.recent.map(row => row.purpose), ['memory', 'agreement', 'proactive']);
    assert.equal(used.failedCalls, 0); assert.equal(used.byKind.find(row => row.kind === 'proactive').calls, 1);
    model.fetch = async () => response(fullUsage, 'invalid-proactive-format');
    await model.respond(user.id, { proactive: true });
    assert.equal(store.usage().model.failedCalls, 1); assert.equal(store.usage().model.calls, 4);
  } finally { store.close(); }
});

test('明确4xx拒绝归零，408/500/网络中断及损坏HTTP响应保留未知费用估算', async () => {
  for (const mode of [400, 401, 429, 408, 500, 'network', 'abort', 'broken-response']) {
    const { store, user, model } = fixture(async () => {
      if (mode === 'network') throw new Error('private-network-detail');
      if (mode === 'abort') throw new DOMException('private-abort', 'AbortError');
      return new Response('private-invalid-json', { status: mode === 'broken-response' ? 200 : mode });
    });
    try {
      await assert.rejects(model.respond(user.id));
      const used = store.usage().model, row = used.recent[0];
      if ([400, 401, 429].includes(mode)) { assert.equal(used.amount, 0); assert.equal(used.rejectedCalls, 1); assert.equal(row.status, 'rejected'); }
      else { assert.ok(used.amount > 0); assert.equal(used.uncertainCalls, 1); assert.equal(row.status, 'estimated'); }
      assert.equal(used.totalTokens, null); assert.equal(used.unknownTokenCalls, 1); assert.equal(used.calls, 1);
      assert.doesNotMatch(JSON.stringify(used), /private-/);
    } finally { store.close(); }
  }
});

test('供应商错误响应仍报告用量时保留消耗，过长和最终无效回复也计入已报告token', async () => {
  for (const mode of ['billed-error', 'length', 'empty-twice']) {
    const { store, user, model } = fixture(async () => {
      if (mode === 'billed-error') return Response.json({ error: { message: 'private-failure' }, usage: fullUsage }, { status: 400 });
      return response(fullUsage, '', mode === 'length' ? { choices: [{ finish_reason: 'length', message: { content: 'partial' } }] } : {});
    });
    try {
      await assert.rejects(model.respond(user.id));
      const used = store.usage().model, calls = mode === 'empty-twice' ? 2 : 1;
      assert.equal(used.calls, calls); assert.equal(used.failedCalls, calls); assert.equal(used.rejectedCalls, 0);
      assert.equal(used.totalTokens, 120 * calls); almost(used.amount, 0.00036 * calls);
      assert.ok(used.recent.every(row => row.status === 'settled'));
    } finally { store.close(); }
  }
});

test('旧六列账本迁移与重启保留匿名金额，未结束调用转未知估算，删除成员不删除账本', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fatfish-model-usage-')); let store;
  try {
    const path = join(directory, 'legacy.sqlite');
    const old = new DatabaseSync(path);
    old.exec('CREATE TABLE usage (id TEXT PRIMARY KEY, month TEXT NOT NULL, kind TEXT NOT NULL, amount REAL NOT NULL, status TEXT NOT NULL, at INTEGER NOT NULL)');
    old.prepare('INSERT INTO usage VALUES (?,?,?,?,?,?)').run('legacy', '2026-11', 'conversation', 0.2, 'settled', epoch);
    old.close();
    store = new Store(path, { now: () => epoch });
    const id = store.reserve('proactive', 0.01, false, { modelUsage: { model: 'deepseek-flash', purpose: 'proactive', outcome: 'pending' } });
    store.close(); store = new Store(path, { now: () => epoch + 1000 });
    const used = store.usage().model;
    assert.equal(used.calls, 2); almost(used.amount, 0.21); assert.equal(used.totalTokens, null);
    assert.equal(used.uncertainCalls, 1); assert.equal(used.pendingCalls, 0);
    assert.equal(used.recent.find(row => row.id === id).status, 'estimated');
    assert.equal(used.recent.find(row => row.id === 'legacy').model, '');
    const user = store.addUser('delete-usage-user'); store.deleteUser(user.id);
    assert.equal(store.usage().model.calls, 2);
    store.db.prepare('INSERT INTO usage VALUES (?,?,?,?,?,?)').run('still-six', '2026-11', 'conversation', 0.1, 'settled', epoch + 2);
    almost(store.usage().model.amount, 0.31);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('按北京时间展示最近14日含空日且跨月，最近调用最多20条，不关联用户或正文', () => {
  const { store, time } = fixture();
  try {
    const final = Date.parse('2026-12-01T00:00:02+08:00');
    for (let i = 0; i < 25; i++) {
      time(final - 30000 + i * 1000);
      const id = store.reserve('conversation', 0.001, false, { modelUsage: { model: 'deepseek-flash', purpose: 'conversation', outcome: 'pending', userId: 'private-user-id', content: 'private-content', key: 'private-key' } });
      store.settle(id, 0.00036, 'settled', { modelUsage: { ...modelTokenUsage(fullUsage), outcome: 'succeeded' } });
    }
    time(final);
    const id = store.reserve('conversation', 0.001, false, { modelUsage: { model: 'deepseek-flash', purpose: 'memory', outcome: 'pending' } });
    store.settle(id, 0.00036, 'settled', { modelUsage: { ...modelTokenUsage(fullUsage), outcome: 'succeeded' } });
    const used = store.usage().model;
    assert.equal(used.calls, 1); assert.equal(used.recent.length, 20);
    assert.equal(used.daily.length, 14); assert.equal(used.daily[0].day, '2026-11-18'); assert.equal(used.daily.at(-1).day, '2026-12-01');
    assert.equal(used.daily.at(-2).calls, 25); assert.equal(used.daily.at(-1).calls, 1);
    assert.equal(used.daily[0].calls, 0); assert.equal(used.daily[0].totalTokens, 0);
    assert.doesNotMatch(JSON.stringify(used), /private-/);
    assert.doesNotMatch(JSON.stringify(store.db.prepare('SELECT * FROM model_usage_details').all()), /private-/);
  } finally { store.close(); }
});
