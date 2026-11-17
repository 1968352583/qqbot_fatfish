import { createHash, createHmac, randomUUID } from 'node:crypto';

const endpoint = 'https://business.aliyuncs.com/';
const cacheMs = 5 * 60_000, staleMs = 30 * 60_000;
const pageSize = 100, maxPages = 5;
const actions = new Set(['QueryAccountBalance', 'QueryResourcePackageInstances']);
const encode = value => encodeURIComponent(String(value)).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const canonical = params => Object.keys(params).filter(key => key !== 'Signature').sort().map(key => `${encode(key)}=${encode(params[key])}`).join('&');

// Alibaba Cloud RPC v1 signing. Exported to verify published signature vectors.
export function signBillingRpc(params, secret, method = 'POST') {
  return createHmac('sha1', `${secret}&`).update(`${method}&%2F&${encode(canonical(params))}`).digest('base64');
}

class BillingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const invalid = () => new BillingError('error', '费用服务返回的数据不完整，请稍后重试。');
function decimal(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) return null;
    value = String(value);
    if (value.includes('e')) {
      const [mantissa, exponent] = value.split('e'), negative = mantissa.startsWith('-');
      const unsigned = negative ? mantissa.slice(1) : mantissa, digits = unsigned.replace('.', '');
      const point = (unsigned.includes('.') ? unsigned.indexOf('.') : unsigned.length) + Number(exponent);
      if (Math.abs(point) > 64) return null;
      value = (negative ? '-' : '') + (point <= 0 ? `0.${'0'.repeat(-point)}${digits}`
        : point >= digits.length ? digits + '0'.repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`);
    }
  }
  return typeof value === 'string' && /^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value) && value.length <= 64 ? value.replaceAll(',', '') : null;
}
const code = value => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,120}$/.test(value) ? value : null;
const unit = value => typeof value === 'string' && /^[\p{L}\p{N}%/_. -]{1,40}$/u.test(value) ? value : null;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const totalCount = value => /^(?:0|[1-9]\d*)$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null;

function balanceData(data) {
  const cashAmount = decimal(data?.AvailableCashAmount), availableAmount = decimal(data?.AvailableAmount);
  const currency = typeof data?.Currency === 'string' && /^[A-Z]{3}$/.test(data.Currency) ? data.Currency : null;
  if (cashAmount === null || currency === null) throw invalid();
  return { cashAmount, availableAmount, currency };
}

function applicableProducts(value) {
  if (value === undefined || value === null) return [];
  const products = new Set(); let visited = 0;
  const read = (item, depth) => {
    if (++visited > 100 || depth > 4) throw invalid();
    if (typeof item === 'string') {
      const product = code(item);
      if (product) { products.add(product); if (products.size > 30) throw invalid(); return; }
      if (item.length > 4096 || !item.trimStart().startsWith('{')) throw invalid();
      let parsed;
      try { parsed = JSON.parse(item); } catch { throw invalid(); }
      return read(parsed, depth + 1);
    }
    // Both official examples wrap codes in Product arrays, once as JSON text.
    // Only unwrap that field; never inspect arbitrary object properties.
    if (!item || typeof item !== 'object' || Array.isArray(item) || !Array.isArray(item.Product) || item.Product.length > 30) throw invalid();
    for (const product of item.Product) read(product, depth + 1);
  };
  read(value, 0);
  return [...products];
}

function packageData(item) {
  if (!item || typeof item !== 'object') throw invalid();
  const remaining = decimal(item.RemainingAmount), total = decimal(item.TotalAmount);
  const remainingUnit = unit(item.RemainingAmountUnit), totalUnit = unit(item.TotalAmountUnit);
  if (remaining === null || total === null || remainingUnit === null || totalUnit === null) throw invalid();
  return {
    remaining, total, remainingUnit, totalUnit, expiresAt: date(item.ExpiryTime),
    status: ['Available', 'Expired'].includes(item.Status) ? item.Status : 'unknown',
    commodityCode: code(item.CommodityCode), packageType: code(item.PackageType), region: code(item.Region),
    applicableProducts: applicableProducts(item.ApplicableProducts),
  };
}

function safeFailure(error) {
  return error instanceof BillingError ? { status: error.status, message: error.message }
    : { status: 'error', message: '暂时无法连接阿里云费用服务，请稍后重试。' };
}

function credentials(secrets) {
  const values = secrets.values();
  const accessKeyId = typeof values.billingAccessKeyId === 'string' ? values.billingAccessKeyId.trim() : '';
  const accessKeySecret = typeof values.billingAccessKeySecret === 'string' ? values.billingAccessKeySecret.trim() : '';
  const securityToken = typeof values.billingSecurityToken === 'string' ? values.billingSecurityToken.trim() : '';
  return { accessKeyId, accessKeySecret, securityToken };
}
const fingerprint = creds => createHash('sha256').update(JSON.stringify(creds)).digest('hex');

const freeQuota = () => ({
  status: 'console_only', model: 'qwen-audio-3.1-tts-plus', remaining: null, total: null,
  consoleUrl: 'https://bailian.console.aliyun.com/',
  docsUrl: 'https://help.aliyun.com/zh/model-studio/cli/usage-quota',
  message: '免费额度可通过百炼官方控制台或 CLI 查询；本项目尚未接入所需的控制台授权。语音 API Key 和账户现金余额不能代替模型免费额度。',
});
const emptyBalance = () => ({ cashAmount: null, availableAmount: null, currency: null });
const emptyPackages = () => ({ items: [], total: null, truncated: false, scope: 'aliyun_account' });
const emptySection = (empty, status, message) => ({ ...empty(), status, message, checkedAt: null, updatedAt: null, stale: false });

export class Billing {
  constructor({ secrets, fetchImpl = fetch, now = Date.now }) {
    this.secrets = secrets; this.fetch = fetchImpl; this.now = now;
    this.identity = null; this.cache = null; this.good = {}; this.pending = null;
  }

  async snapshot({ refresh = false } = {}) {
    let creds;
    try { creds = credentials(this.secrets); }
    catch { return this.unconfigured('error', '无法读取费用查询凭据，请检查服务器配置。'); }
    const key = fingerprint(creds);
    if (key !== this.identity) {
      this.identity = key; this.cache = null; this.good = {}; this.pending = null;
    }
    if (!creds.accessKeyId || !creds.accessKeySecret) return this.unconfigured();
    const cachedStaleValid = this.cache && ['balance', 'resourcePackages'].every(name => !this.cache.value[name].stale || this.now() - Date.parse(this.cache.value[name].updatedAt) <= staleMs);
    if (!refresh && this.cache && cachedStaleValid && this.now() - this.cache.at >= 0 && this.now() - this.cache.at < cacheMs) return structuredClone(this.cache.value);
    if (this.pending?.key === key) return structuredClone(await this.pending.promise);
    const promise = this.load(creds, key);
    this.pending = { key, promise };
    try { return structuredClone(await promise); }
    finally { if (this.pending?.promise === promise) this.pending = null; }
  }

  unconfigured(status = 'not_configured', message = '尚未配置专用的阿里云费用查询凭据。') {
    return { configured: false, checkedAt: null, cacheSeconds: cacheMs / 1000,
      balance: emptySection(emptyBalance, status, message),
      resourcePackages: emptySection(emptyPackages, status, message), freeQuota: freeQuota() };
  }

  async rpc(action, params, creds) {
    if (!actions.has(action)) throw invalid();
    const fields = {
      ...params, Action: action, Format: 'JSON', Version: '2017-12-14',
      AccessKeyId: creds.accessKeyId, SignatureMethod: 'HMAC-SHA1', SignatureVersion: '1.0',
      SignatureNonce: randomUUID(), Timestamp: new Date(this.now()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      ...(creds.securityToken ? { SecurityToken: creds.securityToken } : {}),
    };
    const body = `${canonical(fields)}&Signature=${encode(signBillingRpc(fields, creds.accessKeySecret))}`;
    const response = await this.fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
      signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    if (response.status === 401 || response.status === 403) throw new BillingError('forbidden', '费用查询凭据无效、已过期或没有相应的只读权限。');
    let result;
    try {
      const text = await response.text();
      if (text.length > 1_000_000) throw invalid();
      result = JSON.parse(text);
    } catch { throw invalid(); }
    if (!response.ok || result?.Success !== true) {
      const denied = /^(?:NoPermission|NotAuthorized|Forbidden(?:[.:].*)?|InvalidAccessKeyId(?:[.:].*)?|InvalidSecurityToken(?:[.:].*)?|SecurityTokenExpired|SignatureDoesNotMatch|MissingSecurityToken)$/i.test(String(result?.Code ?? ''));
      throw new BillingError(denied ? 'forbidden' : 'error', denied ? '费用查询凭据无效、已过期或没有相应的只读权限。' : '阿里云费用查询未成功，请稍后重试。');
    }
    if (!result.Data || typeof result.Data !== 'object') throw invalid();
    return result.Data;
  }

  async packages(creds) {
    const items = []; let total = null, complete = false;
    for (let page = 1; page <= maxPages; page++) {
      const data = await this.rpc('QueryResourcePackageInstances', { PageNum: page, PageSize: pageSize }, creds);
      const rows = data.Instances?.Instance;
      const count = totalCount(data.TotalCount);
      if (!Array.isArray(rows) || count === null || rows.length > pageSize || (rows.length === 0 && count > items.length)) throw invalid();
      total = count;
      items.push(...rows.map(packageData));
      if (items.length >= total) { complete = true; break; }
    }
    return { items, total, truncated: !complete, scope: 'aliyun_account' };
  }

  async load(creds, key) {
    const results = await Promise.allSettled([
      this.rpc('QueryAccountBalance', {}, creds).then(balanceData), this.packages(creds),
    ]);
    // Credential rotation must never publish or reuse a prior account's result.
    let current;
    try { current = fingerprint(credentials(this.secrets)); } catch { current = null; }
    if (key !== this.identity || key !== current) return this.unconfigured('error', '费用查询凭据已变更，请刷新后重新查询。');
    const at = this.now(), checkedAt = new Date(at).toISOString();
    const section = (name, result, empty) => {
      if (result.status === 'fulfilled') {
        this.good[name] = { at, data: result.value };
        return { ...result.value, status: 'ready', message: null, checkedAt, updatedAt: checkedAt, stale: false };
      }
      const failure = safeFailure(result.reason), old = this.good[name];
      const stale = failure.status === 'error' && old && at - old.at >= 0 && at - old.at <= staleMs;
      if (!stale) delete this.good[name];
      return { ...(stale ? old.data : empty()), ...failure, checkedAt,
        updatedAt: stale ? new Date(old.at).toISOString() : null, stale: Boolean(stale) };
    };
    const value = { configured: true, checkedAt, cacheSeconds: cacheMs / 1000,
      balance: section('balance', results[0], emptyBalance),
      resourcePackages: section('packages', results[1], emptyPackages), freeQuota: freeQuota() };
    this.cache = { at, value };
    return value;
  }
}
