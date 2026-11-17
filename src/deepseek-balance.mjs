import { createHash } from 'node:crypto';

const endpoint = 'https://api.deepseek.com/user/balance';
const cacheMs = 5 * 60_000, staleMs = 30 * 60_000;
const decimal = value => typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value) && value.length <= 64 ? value : null;

class BalanceError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const invalid = () => new BalanceError('error', 'DeepSeek 返回的余额数据不完整，请稍后重试。');
const empty = () => ({ isAvailable: null, balances: [] });

function officialBase(base) {
  try {
    const url = new URL(base);
    return url.origin === 'https://api.deepseek.com' && !url.username && !url.password && !url.search && !url.hash &&
      ['/', '/v1', '/v1/'].includes(url.pathname);
  } catch { return false; }
}

// https://api-docs.deepseek.com/api/get-user-balance/
function balanceData(result) {
  if (typeof result?.is_available !== 'boolean' || !Array.isArray(result.balance_infos) || result.balance_infos.length < 1 || result.balance_infos.length > 2) throw invalid();
  const currencies = new Set();
  const balances = result.balance_infos.map(row => {
    const currency = row?.currency, total = decimal(row?.total_balance), granted = decimal(row?.granted_balance), toppedUp = decimal(row?.topped_up_balance);
    if (!['CNY', 'USD'].includes(currency) || currencies.has(currency) || total === null || granted === null || toppedUp === null) throw invalid();
    currencies.add(currency);
    return { currency, total, granted, toppedUp };
  });
  return { isAvailable: result.is_available, balances };
}

export class DeepSeekBalance {
  constructor({ secrets, store, fetchImpl = fetch, now = Date.now }) {
    this.secrets = secrets; this.store = store; this.fetch = fetchImpl; this.now = now;
    this.identity = null; this.cache = null; this.good = null; this.pending = null;
  }

  context() {
    const value = this.secrets.values().deepseekKey, base = this.store.config().modelBaseUrl;
    const key = typeof value === 'string' ? value.trim() : '';
    return { key, base, identity: createHash('sha256').update(JSON.stringify([key, base])).digest('hex') };
  }

  unavailable(status, message, configured = false) {
    return { configured, status, ...empty(), checkedAt: null, updatedAt: null, stale: false, cacheSeconds: cacheMs / 1000, message };
  }

  async snapshot({ refresh = false } = {}) {
    let context;
    try { context = this.context(); }
    catch { return this.unavailable('error', '无法读取 DeepSeek 余额查询配置，请检查服务器设置。'); }
    const { key, base, identity } = context;
    if (identity !== this.identity) {
      this.identity = identity; this.cache = null; this.good = null; this.pending = null;
    }
    if (!key) return this.unavailable('not_configured', '尚未配置 DeepSeek API Key。');
    if (!officialBase(base)) return this.unavailable('unsupported', '当前模型使用的不是受支持的 DeepSeek 官方地址，请在对应服务商查询余额。', true);
    const age = this.cache ? this.now() - this.cache.at : Infinity;
    const staleValid = this.cache && (!this.cache.value.stale || this.now() - Date.parse(this.cache.value.updatedAt) <= staleMs);
    if (!refresh && this.cache && age >= 0 && age < cacheMs && staleValid) return structuredClone(this.cache.value);
    if (this.pending?.identity === identity) return structuredClone(await this.pending.promise);
    const promise = this.load(context);
    this.pending = { identity, promise };
    try { return structuredClone(await promise); }
    finally { if (this.pending?.promise === promise) this.pending = null; }
  }

  async query(key) {
    const response = await this.fetch(endpoint, {
      method: 'GET', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    if (response.status === 401 || response.status === 403) throw new BalanceError('forbidden', 'DeepSeek API Key 无效、已失效或没有查询权限。');
    if (!response.ok) throw new BalanceError('error', 'DeepSeek 余额查询未成功，请稍后重试。');
    let result;
    try {
      const text = await response.text();
      if (text.length > 32_000) throw invalid();
      result = JSON.parse(text);
    } catch { throw invalid(); }
    return balanceData(result);
  }

  async load(context) {
    let data, failure;
    try { data = await this.query(context.key); }
    catch (error) {
      failure = error instanceof BalanceError ? { status: error.status, message: error.message }
        : { status: 'error', message: '暂时无法连接 DeepSeek 余额服务，请稍后重试。' };
    }
    let current;
    try { current = this.context().identity; } catch { current = null; }
    if (context.identity !== this.identity || current !== context.identity) return this.unavailable('error', 'DeepSeek 凭据或模型地址已变更，请刷新后重新查询。');
    const at = this.now(), checkedAt = new Date(at).toISOString();
    let value;
    if (data) {
      this.good = { at, data };
      value = { configured: true, status: 'ready', ...data, checkedAt, updatedAt: checkedAt, stale: false, cacheSeconds: cacheMs / 1000, message: null };
    } else {
      const old = this.good, stale = failure.status === 'error' && old && at - old.at >= 0 && at - old.at <= staleMs;
      if (!stale) this.good = null;
      value = { configured: true, ...failure, ...(stale ? old.data : empty()), checkedAt,
        updatedAt: stale ? new Date(old.at).toISOString() : null, stale: Boolean(stale), cacheSeconds: cacheMs / 1000 };
    }
    this.cache = { at, value };
    return value;
  }
}
