import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Secrets } from '../src/secrets.mjs';
import { Billing } from '../src/billing.mjs';
import { DeepSeekBalance } from '../src/deepseek-balance.mjs';
import { createAdminServer } from '../src/server.mjs';

test('DeepSeek account query is administrator-only, refresh is same-origin, and existing key stays server-side', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fatfish-deepseek-admin-'));
  const store = new Store(':memory:');
  const secrets = new Secrets(join(dir, 'secrets.json'), { ADMIN_PASSWORD: 'fixture-admin-password', DEEPSEEK_API_KEY: 'fixture-deepseek-key' });
  let calls = 0;
  const deepseekBalance = new DeepSeekBalance({ store, secrets, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://api.deepseek.com/user/balance');
    assert.equal(options.headers.Authorization, 'Bearer fixture-deepseek-key');
    return Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.50', granted_balance: '2.50', topped_up_balance: '10.00' }] });
  } });
  const server = createAdminServer({ store, secrets, deepseekBalance, bot: { stop() {} }, runtime: { gateway: 'ready' } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${origin}/api/deepseek-balance`)).status, 401);
    assert.equal((await fetch(`${origin}/api/deepseek-balance/refresh`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal(calls, 0);
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'fixture-admin-password' }) });
    const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: origin, 'Content-Type': 'application/json' };
    const snapshot = await (await fetch(`${origin}/api/deepseek-balance`, { headers })).json();
    assert.equal(snapshot.status, 'ready'); assert.equal(snapshot.balances[0].total, '12.50');
    assert.doesNotMatch(JSON.stringify(snapshot), /fixture-deepseek-key|Authorization|Bearer/);
    assert.equal((await fetch(`${origin}/api/deepseek-balance/refresh`, { method: 'POST', headers: { ...headers, Origin: 'https://other.example' }, body: '{}' })).status, 403);
    assert.equal(calls, 1);
    assert.equal((await fetch(`${origin}/api/deepseek-balance/refresh`, { method: 'POST', headers, body: '{}' })).status, 200);
    assert.equal(calls, 2);
    await fetch(`${origin}/api/config`, { method: 'PUT', headers, body: JSON.stringify({ modelBaseUrl: 'https://gateway.example/v1' }) });
    const unsupported = await (await fetch(`${origin}/api/deepseek-balance`, { headers })).json();
    assert.equal(unsupported.status, 'unsupported'); assert.deepEqual(unsupported.balances, []); assert.equal(calls, 2);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('usage and account routes require admin login; refresh requires same origin; billing credentials never echo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fatfish-admin-usage-'));
  const store = new Store(':memory:');
  const secrets = new Secrets(join(dir, 'secrets.json'), { ADMIN_PASSWORD: 'fixture-admin-password' });
  let snapshots = 0;
  const billing = new Billing({ secrets, fetchImpl: async () => { throw new Error('No provider calls expected'); } });
  const snapshot = billing.snapshot.bind(billing);
  billing.snapshot = options => { snapshots++; return snapshot(options); };
  const server = createAdminServer({ store, secrets, billing, bot: { stop() {} }, runtime: { gateway: 'ready' }, publicDir: join(process.cwd(), 'public') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${origin}/api/usage`)).status, 401);
    assert.equal((await fetch(`${origin}/api/billing`)).status, 401);
    assert.equal(snapshots, 0);
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'fixture-admin-password' }) });
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    const headers = { Cookie, Origin: origin, 'Content-Type': 'application/json' };
    const id = store.reserve('voice', 0.02, false, { provider: 'bailian', estimatedCharacters: 100, outcome: 'pending' });
    store.settle(id, 0.014, 'settled', { reportedCharacters: 100, outcome: 'succeeded' });
    const usage = await (await fetch(`${origin}/api/usage`, { headers })).json();
    assert.equal(usage.voice.amount, 0.014); assert.equal(usage.voice.reportedCharacters, 100);
    const unconfigured = await (await fetch(`${origin}/api/billing`, { headers })).json();
    assert.equal(unconfigured.balance.status, 'not_configured'); assert.equal(unconfigured.balance.cashAmount, null);
    assert.equal((await fetch(`${origin}/api/billing/refresh`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
    assert.equal(snapshots, 1);
    assert.equal((await fetch(`${origin}/api/billing/refresh`, { method: 'POST', headers, body: '{}' })).status, 200);
    assert.equal(snapshots, 2);
    const saved = await fetch(`${origin}/api/secrets`, { method: 'PUT', headers, body: JSON.stringify({ billingAccessKeyId: 'fixture-access-key', billingAccessKeySecret: 'fixture-billing-secret' }) });
    assert.equal(saved.status, 200); assert.equal((await saved.json()).billingConfigured, true);
    const state = await (await fetch(`${origin}/api/state`, { headers })).text();
    assert.doesNotMatch(state, /fixture-access-key|fixture-billing-secret|fixture-admin-password/);
    await fetch(`${origin}/api/secrets`, { method: 'PUT', headers, body: JSON.stringify({ billingAccessKeyId: '', billingAccessKeySecret: '', billingSecurityToken: '' }) });
    assert.equal((await (await fetch(`${origin}/api/billing`, { headers })).json()).configured, false);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('billing credential replacement and removal keep existing credentials and a private file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fatfish-billing-secrets-'));
  const path = join(dir, 'secrets.json'), secrets = new Secrets(path, {});
  try {
    secrets.update({ adminPassword: 'fixture-admin-password', bailianKey: 'fixture-voice-key' });
    assert.throws(() => secrets.update({ billingAccessKeyId: 'fixture-access-key' }), /同时配置/);
    assert.equal(secrets.status().billingConfigured, false);
    secrets.update({ billingAccessKeyId: 'fixture-access-key', billingAccessKeySecret: 'fixture-billing-secret', billingSecurityToken: 'fixture-sts-token' });
    assert.equal(secrets.status().billingConfigured, true); assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(secrets.values().bailianKey, 'fixture-voice-key'); assert(secrets.verify('fixture-admin-password'));
    secrets.update({ billingAccessKeyId: '', billingAccessKeySecret: '', billingSecurityToken: '' });
    assert.equal(secrets.status().billingConfigured, false); assert.equal(secrets.values().bailianKey, 'fixture-voice-key');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
