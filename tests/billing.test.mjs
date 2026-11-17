import test from 'node:test';
import assert from 'node:assert/strict';
import { Billing, signBillingRpc } from '../src/billing.mjs';

const epoch = Date.parse('2026-11-17T12:00:00Z');
const creds = { billingAccessKeyId: 'fixture-id', billingAccessKeySecret: 'fixture-secret', billingSecurityToken: 'fixture-sts' };
const balance = (cash = '12.34') => ({ AvailableCashAmount: cash, AvailableAmount: '15.00', Currency: 'CNY', AccountId: 'private-account-id', Contact: 'private-contact' });
const packageItem = (patch = {}) => ({ RemainingAmount: '100.000', TotalAmount: '1000.000', RemainingAmountUnit: 'GB', TotalAmountUnit: 'GB', Status: 'Available', ExpiryTime: '2026-12-01T00:00:00Z', CommodityCode: 'oss', PackageType: 'ossbag', Region: 'cn-beijing', ApplicableProducts: { Product: ['oss'] }, InstanceId: 'private-instance-id', Remark: 'private-note', ...patch });
const packages = (items = [packageItem()], total = items.length) => ({ Instances: { Instance: items }, TotalCount: String(total) });
const success = data => Response.json({ Success: true, Code: 'Success', Data: data });
function fixture(handler, initial = creds) {
  let now = epoch, values = { ...initial }; const calls = [];
  const billing = new Billing({ secrets: { values: () => values }, now: () => now,
    fetchImpl: async (url, options) => {
      const fields = Object.fromEntries(new URLSearchParams(options.body));
      calls.push({ url, options, fields });
      return handler ? handler(fields, calls) : success(fields.Action === 'QueryAccountBalance' ? balance() : packages());
    } });
  return { billing, calls, advance: amount => { now += amount; }, setSecrets: next => { values = next; } };
}

test('RPC签名匹配阿里云公开GET测试向量且不把Signature重复签入', () => {
  // https://help.aliyun.com/zh/dsc/database-audit/developer-reference/signature
  const fields = { AccessKeyId: 'testid', Action: 'DescribeRegions', Format: 'XML', SignatureMethod: 'HMAC-SHA1', SignatureNonce: '3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf', SignatureVersion: '1.0', Timestamp: '2016-02-23T12:46:24Z', Version: '2014-05-26', Signature: 'ignored' };
  assert.equal(signBillingRpc(fields, 'testsecret', 'GET'), 'OLeaidS1JvxuMvnyHOwuJ+uX5qY=');
  assert.notEqual(signBillingRpc(fields, 'testsecret'), signBillingRpc(fields, 'testsecret', 'GET'));
});

test('未配置云凭据时不使用现有百炼key请求，余额保持未知', async () => {
  const { billing, calls } = fixture(null, { bailianKey: 'existing-model-key' });
  const result = await billing.snapshot();
  assert.equal(calls.length, 0); assert.equal(result.configured, false);
  assert.equal(result.balance.status, 'not_configured'); assert.equal(result.balance.cashAmount, null);
  assert.equal(result.resourcePackages.total, null); assert.equal(result.freeQuota.status, 'console_only');
  assert.equal(result.freeQuota.remaining, null);
});

test('真实字段白名单，POST固定endpoint并对STS签名，禁止重定向泄漏', async () => {
  const { billing, calls } = fixture(); const result = await billing.snapshot();
  assert.equal(result.balance.status, 'ready'); assert.equal(result.balance.cashAmount, '12.34'); assert.equal(result.balance.currency, 'CNY');
  assert.equal(result.resourcePackages.total, 1); assert.equal(result.resourcePackages.items[0].commodityCode, 'oss');
  assert.equal(result.resourcePackages.scope, 'aliyun_account'); assert.equal(result.resourcePackages.truncated, false);
  assert.doesNotMatch(JSON.stringify(result), /private-|fixture-|Signature|SecurityToken|AccountId|Contact|InstanceId|Remark/);
  for (const call of calls) {
    assert.equal(call.url, 'https://business.aliyuncs.com/'); assert.equal(call.options.method, 'POST'); assert.equal(call.options.redirect, 'error');
    assert.equal(call.fields.SecurityToken, creds.billingSecurityToken); assert.equal(call.fields.Version, '2017-12-14');
    assert.equal(call.fields.Timestamp, '2026-11-17T12:00:00Z');
    assert.equal(call.fields.Signature, signBillingRpc(call.fields, creds.billingAccessKeySecret));
    const withoutSts = { ...call.fields }; delete withoutSts.SecurityToken;
    assert.notEqual(call.fields.Signature, signBillingRpc(withoutSts, creds.billingAccessKeySecret));
  }
  assert.notEqual(calls[0].fields.SignatureNonce, calls[1].fields.SignatureNonce);
});

test('只有成功的真实零余额和空资源包才显示零，金额保留小数精度及负值', async () => {
  for (const amount of ['0.00', '-2.15', '1,234.567890']) {
    const { billing } = fixture(fields => success(fields.Action === 'QueryAccountBalance' ? balance(amount) : packages([])));
    const result = await billing.snapshot();
    assert.equal(result.balance.cashAmount, amount.replaceAll(',', '')); assert.equal(result.balance.status, 'ready');
    assert.equal(result.resourcePackages.total, 0); assert.equal(result.resourcePackages.status, 'ready');
  }
});

test('兼容中英文官方示例的资源包金额与Product包装，同时保留服务适用性', async () => {
  // Official examples: /en/ and /zh/user-center/developer-reference/api-bssopenapi-2017-12-14-queryresourcepackageinstances
  const variants = [
    { RemainingAmount: 40, TotalAmount: 40, ApplicableProducts: { Product: [{ Product: ['oss'] }] }, expected: '40' },
    { RemainingAmount: '40.000', TotalAmount: '40.000', ApplicableProducts: { Product: ['{"Product":["oss"]}'] }, expected: '40.000' },
  ];
  for (const { expected, ...patch } of variants) {
    const { billing } = fixture(fields => success(fields.Action === 'QueryAccountBalance' ? balance() : packages([packageItem(patch)])));
    const result = await billing.snapshot();
    assert.equal(result.resourcePackages.status, 'ready');
    assert.equal(result.resourcePackages.items[0].remaining, expected); assert.equal(result.resourcePackages.items[0].total, expected);
    assert.deepEqual(result.resourcePackages.items[0].applicableProducts, ['oss']);
  }
});

test('金额只接受安全有限数字，字符串小数精度不经浮点转换', async () => {
  for (const [amount, expected] of [[0, '0'], [0.125, '0.125'], [1e-7, '0.0000001'], [Number.MAX_SAFE_INTEGER, '9007199254740991'], ['9007199254740993.123456789', '9007199254740993.123456789'], [Number.MAX_SAFE_INTEGER + 1, null], [Infinity, null], [NaN, null], [true, null]]) {
    const { billing } = fixture(fields => success(fields.Action === 'QueryAccountBalance' ? balance() : packages([packageItem({ RemainingAmount: amount })])));
    const result = await billing.snapshot();
    assert.equal(result.resourcePackages.status, expected === null ? 'error' : 'ready');
    if (expected !== null) assert.equal(result.resourcePackages.items[0].remaining, expected);
    else assert.deepEqual(result.resourcePackages.items, []);
  }
});

test('产品包装只读取Product并去重，未知格式及超限明确失败而非静默丢适用性', async () => {
  const { billing } = fixture(fields => success(fields.Action === 'QueryAccountBalance' ? balance() : packages([packageItem({ ApplicableProducts: { Product: ['oss', { Product: ['oss', 'sfm'], Contact: 'private-contact' }] } })])));
  const result = await billing.snapshot();
  assert.deepEqual(result.resourcePackages.items[0].applicableProducts, ['oss', 'sfm']);
  assert.doesNotMatch(JSON.stringify(result), /private-contact/);
  let tooDeep = { Product: ['oss'] }; for (let i = 0; i < 5; i++) tooDeep = { Product: [tooDeep] };
  for (const wrapped of [{ Product: [{ Other: ['oss'] }] }, { Product: ['{"Product":'] }, { Product: ['<invalid-code>'] }, { Product: Array.from({ length: 31 }, () => 'oss') }, tooDeep]) {
    const f = fixture(fields => success(fields.Action === 'QueryAccountBalance' ? balance() : packages([packageItem({ ApplicableProducts: wrapped })])));
    const failed = await f.billing.snapshot();
    assert.equal(failed.resourcePackages.status, 'error'); assert.deepEqual(failed.resourcePackages.items, []);
  }
});

test('HTTP200业务拒绝与401/403都不产生余额，原始错误不回显', async () => {
  for (const [status, errorCode] of [[200, 'NoPermission'], [400, 'NotAuthorized'], [403, 'Forbidden'], [401, 'InvalidSecurityToken.Expired']]) {
    const { billing } = fixture(() => Response.json({ Success: false, Code: errorCode, Message: 'private-provider-details' }, { status }));
    const result = await billing.snapshot();
    assert.equal(result.balance.status, 'forbidden'); assert.equal(result.balance.cashAmount, null); assert.equal(result.resourcePackages.total, null);
    assert.doesNotMatch(JSON.stringify(result), /private-provider-details/);
  }
});

test('网络失败和无效结构不被当作零余额或无资源包', async () => {
  const responses = [() => { throw new Error('private-network-error'); }, () => new Response('private-not-json', { status: 502 }), () => success({}), fields => success(fields.Action === 'QueryAccountBalance' ? balance('NaN') : { Instances: { Instance: [] } })];
  for (const handler of responses) {
    const { billing } = fixture(handler); const result = await billing.snapshot();
    assert.equal(result.balance.status, 'error'); assert.equal(result.balance.cashAmount, null);
    assert.equal(result.resourcePackages.status, 'error'); assert.equal(result.resourcePackages.total, null);
    assert.doesNotMatch(JSON.stringify(result), /private-/);
  }
});

test('两个费用接口独立失败，不能因资源包无权抹去有效现金余额', async () => {
  const { billing } = fixture(fields => fields.Action === 'QueryAccountBalance' ? success(balance()) : Response.json({ Success: false, Code: 'NoPermission' }));
  const result = await billing.snapshot();
  assert.equal(result.balance.status, 'ready'); assert.equal(result.resourcePackages.status, 'forbidden');
});

test('无JSON的HTTP403仍按无权处理，不回退到旧账户缓存', async () => {
  let forbidden = false;
  const { billing } = fixture(fields => forbidden ? new Response('private-access-denied', { status: 403 }) : success(fields.Action === 'QueryAccountBalance' ? balance() : packages()));
  await billing.snapshot(); forbidden = true;
  const result = await billing.snapshot({ refresh: true });
  assert.equal(result.balance.status, 'forbidden'); assert.equal(result.balance.stale, false); assert.equal(result.balance.cashAmount, null);
});

test('5分钟缓存、主动刷新与返回对象隔离', async () => {
  const { billing, calls, advance } = fixture(); const first = await billing.snapshot();
  first.balance.cashAmount = 'tampered'; first.resourcePackages.items[0].remaining = 'tampered';
  const second = await billing.snapshot();
  assert.equal(second.balance.cashAmount, '12.34'); assert.equal(second.resourcePackages.items[0].remaining, '100.000'); assert.equal(calls.length, 2);
  advance(5 * 60_000); await billing.snapshot(); assert.equal(calls.length, 4);
  await billing.snapshot({ refresh: true }); assert.equal(calls.length, 6);
});

test('短时网络失败可显示明确过期缓存，30分钟后删除旧值，无权则立即删除', async () => {
  let mode = 'ok';
  const { billing, advance } = fixture(fields => {
    if (mode === 'error') throw new Error('private-network-error');
    if (mode === 'forbidden') return Response.json({ Success: false, Code: 'NoPermission' });
    return success(fields.Action === 'QueryAccountBalance' ? balance() : packages());
  });
  const initial = await billing.snapshot(); mode = 'error'; advance(60_000);
  let result = await billing.snapshot({ refresh: true });
  assert.equal(result.balance.status, 'error'); assert.equal(result.balance.stale, true); assert.equal(result.balance.cashAmount, '12.34');
  assert.equal(result.balance.updatedAt, initial.balance.updatedAt); assert.notEqual(result.balance.checkedAt, initial.balance.checkedAt);
  advance(30 * 60_000); result = await billing.snapshot({ refresh: true });
  assert.equal(result.balance.stale, false); assert.equal(result.balance.cashAmount, null);
  mode = 'ok'; await billing.snapshot({ refresh: true }); mode = 'forbidden';
  result = await billing.snapshot({ refresh: true }); assert.equal(result.balance.status, 'forbidden'); assert.equal(result.balance.cashAmount, null);
});

test('凭据变更清除旧账户缓存，清空配置后不再查询', async () => {
  let fail = false;
  const { billing, setSecrets, calls } = fixture(fields => { if (fail) throw new Error('fail'); return success(fields.Action === 'QueryAccountBalance' ? balance() : packages()); });
  await billing.snapshot(); fail = true; setSecrets({ ...creds, billingAccessKeyId: 'another-id' });
  const second = await billing.snapshot(); assert.equal(second.balance.cashAmount, null); assert.equal(second.balance.stale, false);
  setSecrets({}); const third = await billing.snapshot(); assert.equal(third.balance.status, 'not_configured'); assert.equal(calls.length, 4);
});

test('缓存的失败结果也不延长最后成功值的30分钟展示期限', async () => {
  let fail = false;
  const { billing, advance } = fixture(fields => { if (fail) throw new Error('fail'); return success(fields.Action === 'QueryAccountBalance' ? balance() : packages()); });
  await billing.snapshot(); advance(29 * 60_000); fail = true;
  assert.equal((await billing.snapshot()).balance.stale, true);
  advance(2 * 60_000);
  const result = await billing.snapshot(); assert.equal(result.balance.stale, false); assert.equal(result.balance.cashAmount, null);
});

test('并发刷新只调用一次；查询期间换凭据不会发布旧账户余额', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const { billing, calls, setSecrets } = fixture(async fields => { await gate; return success(fields.Action === 'QueryAccountBalance' ? balance() : packages()); });
  const first = billing.snapshot(), second = billing.snapshot({ refresh: true });
  assert.equal(calls.length, 2); setSecrets({ ...creds, billingAccessKeyId: 'new-id' }); release();
  for (const result of await Promise.all([first, second])) { assert.equal(result.balance.status, 'error'); assert.equal(result.balance.cashAmount, null); }
});

test('资源包顺序分页且设置上限，未取完明确标记截断，不假定都是百炼', async () => {
  const { billing, calls } = fixture(fields => success(fields.Action === 'QueryAccountBalance' ? balance() : packages(Array.from({ length: 100 }, () => packageItem()), 600)));
  const result = await billing.snapshot();
  assert.equal(result.resourcePackages.items.length, 500); assert.equal(result.resourcePackages.total, 600); assert.equal(result.resourcePackages.truncated, true);
  assert.deepEqual(calls.filter(call => call.fields.Action === 'QueryResourcePackageInstances').map(call => call.fields.PageNum), ['1', '2', '3', '4', '5']);
  assert.deepEqual(result.resourcePackages.items[0].applicableProducts, ['oss']);
});

test('中途分页失败不把不完整资源包列表伪装成完整结果', async () => {
  const { billing } = fixture(fields => {
    if (fields.Action === 'QueryAccountBalance') return success(balance());
    if (fields.PageNum === '2') throw new Error('private-fail');
    return success(packages(Array.from({ length: 100 }, () => packageItem()), 200));
  });
  const result = await billing.snapshot(); assert.equal(result.resourcePackages.status, 'error'); assert.equal(result.resourcePackages.total, null); assert.deepEqual(result.resourcePackages.items, []);
});
