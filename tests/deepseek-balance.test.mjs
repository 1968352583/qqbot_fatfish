import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekBalance } from '../src/deepseek-balance.mjs';

const epoch = Date.parse('2026-11-18T00:00:00Z');
const row = (patch = {}) => ({ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00', private_field: 'private-account-data', ...patch });
const body = (patch = {}) => ({ is_available: true, balance_infos: [row()], private_account: 'private-account-id', ...patch });
function fixture(handler, options = {}) {
  let now = epoch, key = options.key ?? 'private-deepseek-key', base = options.base ?? 'https://api.deepseek.com';
  const calls = [];
  const balance = new DeepSeekBalance({ secrets: { values: () => ({ deepseekKey: key }) }, store: { config: () => ({ modelBaseUrl: base }) }, now: () => now,
    fetchImpl: async (url, request) => { calls.push({ url, request }); return handler ? handler(calls) : Response.json(body()); } });
  return { balance, calls, advance: ms => { now += ms; }, setKey: value => { key = value; }, setBase: value => { base = value; } };
}

test('官方余额示例映射，固定GET地址与Bearer鉴权，不回显供应商额外字段', async () => {
  const { balance, calls } = fixture(); const result = await balance.snapshot();
  assert.equal(result.status, 'ready'); assert.equal(result.configured, true); assert.equal(result.isAvailable, true);
  assert.deepEqual(result.balances, [{ currency: 'CNY', total: '110.00', granted: '10.00', toppedUp: '100.00' }]);
  assert.equal(result.checkedAt, new Date(epoch).toISOString()); assert.equal(result.updatedAt, result.checkedAt); assert.equal(result.stale, false);
  assert.equal(calls[0].url, 'https://api.deepseek.com/user/balance'); assert.equal(calls[0].request.method, 'GET');
  assert.equal(calls[0].request.headers.Authorization, 'Bearer private-deepseek-key'); assert.equal(calls[0].request.redirect, 'error');
  assert.ok(calls[0].request.signal instanceof AbortSignal); assert.doesNotMatch(JSON.stringify(result), /private-|Authorization|Bearer/);
});

test('多币种分别保留，真实零余额和false可用状态不被当作缺失', async () => {
  const f = fixture(() => Response.json(body({ is_available: false, balance_infos: [row({ total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' }), row({ currency: 'USD', total_balance: '0.000001', granted_balance: '0.000000', topped_up_balance: '0.000001' })] })));
  const result = await f.balance.snapshot(); assert.equal(result.status, 'ready'); assert.equal(result.isAvailable, false);
  assert.equal(result.balances[0].total, '0.00'); assert.equal(result.balances[1].total, '0.000001');
});

test('未配置立即返回未知余额，不发起请求', async () => {
  const { balance, calls } = fixture(null, { key: '' }); const result = await balance.snapshot();
  assert.equal(result.status, 'not_configured'); assert.equal(result.configured, false); assert.equal(result.isAvailable, null);
  assert.deepEqual(result.balances, []); assert.equal(calls.length, 0); assert.equal(result.checkedAt, null);
});

test('官方根地址和v1均使用固定余额入口，不将第三方或混淆地址的key发送出去', async () => {
  for (const base of ['https://api.deepseek.com', 'https://api.deepseek.com/', 'https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/']) {
    const f = fixture(null, { base }); assert.equal((await f.balance.snapshot()).status, 'ready'); assert.equal(f.calls[0].url, 'https://api.deepseek.com/user/balance');
  }
  for (const base of ['https://gateway.example/v1', 'http://api.deepseek.com', 'https://api.deepseek.com.evil.test', 'https://api.deepseek.com:8443', 'https://private-user@api.deepseek.com', 'https://api.deepseek.com?private-query', 'https://api.deepseek.com/#private-fragment', 'https://api.deepseek.com/other', 'not-a-url', '']) {
    const f = fixture(null, { base }); const result = await f.balance.snapshot();
    assert.equal(result.status, 'unsupported'); assert.equal(result.configured, true); assert.equal(f.calls.length, 0); assert.deepEqual(result.balances, []);
    assert.doesNotMatch(JSON.stringify(result), /private-|gateway.example/);
  }
});

test('401/403清除旧余额，包括非JSON拒绝；原始错误信息不回显', async () => {
  for (const status of [401, 403]) {
    let denied = false; const f = fixture(() => denied ? new Response('private-provider-denial', { status }) : Response.json(body()));
    await f.balance.snapshot(); denied = true;
    const result = await f.balance.snapshot({ refresh: true });
    assert.equal(result.status, 'forbidden'); assert.equal(result.isAvailable, null); assert.equal(result.stale, false); assert.deepEqual(result.balances, []);
    assert.doesNotMatch(JSON.stringify(result), /private-/);
  }
});

test('网络/非成功HTTP/无效JSON/字段缺失均明确失败，不伪造零余额', async () => {
  const handlers = [() => { throw new Error('private-network-detail'); }, () => new Response('private-provider-error', { status: 429 }), () => new Response('private-invalid-json'), () => Response.json({ error: 'private-business-error' }), () => Response.json(body({ is_available: 'true' })), () => Response.json(body({ balance_infos: [] })), () => Response.json(body({ balance_infos: [row({ total_balance: 110 })] })), () => Response.json(body({ balance_infos: [row({ currency: 'EUR' })] })), () => Response.json(body({ balance_infos: [row(), row()] }))];
  for (const handler of handlers) {
    const f = fixture(handler); const result = await f.balance.snapshot();
    assert.equal(result.status, 'error'); assert.equal(result.isAvailable, null); assert.deepEqual(result.balances, []); assert.equal(result.stale, false);
    assert.doesNotMatch(JSON.stringify(result), /private-/);
  }
});

test('5分钟缓存与手动刷新，返回对象修改不污染服务缓存', async () => {
  const f = fixture(); const first = await f.balance.snapshot(); first.balances[0].total = 'tampered';
  assert.equal((await f.balance.snapshot()).balances[0].total, '110.00'); assert.equal(f.calls.length, 1);
  f.advance(5 * 60_000); await f.balance.snapshot(); assert.equal(f.calls.length, 2);
  await f.balance.snapshot({ refresh: true }); assert.equal(f.calls.length, 3);
});

test('暂时失败可显示30分钟内明确陈旧的结果，缓存不会延长该期限', async () => {
  let fail = false; const f = fixture(() => { if (fail) throw new Error('private-fail'); return Response.json(body()); });
  const first = await f.balance.snapshot(); f.advance(29 * 60_000); fail = true;
  let result = await f.balance.snapshot(); assert.equal(result.status, 'error'); assert.equal(result.stale, true); assert.equal(result.balances[0].total, '110.00');
  assert.equal(result.updatedAt, first.updatedAt); assert.notEqual(result.checkedAt, first.checkedAt);
  f.advance(2 * 60_000); result = await f.balance.snapshot(); assert.equal(result.stale, false); assert.equal(result.updatedAt, null); assert.deepEqual(result.balances, []);
});

test('轮换key清缓存，清空配置不再请求', async () => {
  let fail = false; const f = fixture(() => { if (fail) throw new Error('private-fail'); return Response.json(body()); });
  await f.balance.snapshot(); f.setKey('private-rotated-key'); fail = true;
  const next = await f.balance.snapshot(); assert.equal(next.status, 'error'); assert.equal(next.stale, false); assert.deepEqual(next.balances, []);
  f.setKey(''); assert.equal((await f.balance.snapshot()).status, 'not_configured'); assert.equal(f.calls.length, 2);
});

test('模型base改变隔离缓存，改到第三方立即unsupported且不联网', async () => {
  let fail = false; const f = fixture(() => { if (fail) throw new Error('private-fail'); return Response.json(body()); });
  await f.balance.snapshot(); f.setBase('https://api.deepseek.com/v1'); fail = true;
  const changed = await f.balance.snapshot(); assert.equal(changed.stale, false); assert.deepEqual(changed.balances, []);
  f.setBase('https://gateway.example/v1'); assert.equal((await f.balance.snapshot()).status, 'unsupported'); assert.equal(f.calls.length, 2);
});

test('并发刷新去重，查询期间换key或base不发布先前账户的结果', async () => {
  for (const change of [f => f.setKey('another-private-key'), f => f.setBase('https://gateway.example/v1')]) {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const f = fixture(async () => { await gate; return Response.json(body()); });
    const first = f.balance.snapshot(), second = f.balance.snapshot({ refresh: true }); assert.equal(f.calls.length, 1);
    change(f); release();
    for (const result of await Promise.all([first, second])) { assert.equal(result.status, 'error'); assert.deepEqual(result.balances, []); assert.equal(result.isAvailable, null); }
  }
});
