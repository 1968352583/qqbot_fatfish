import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';

export class Secrets {
  constructor(path, env = process.env) { this.path = path; this.env = env; }
  values() { let file = {}; try { file = JSON.parse(readFileSync(this.path, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; } return { deepseekKey: this.env.DEEPSEEK_API_KEY ?? '', ttsKey: this.env.TTS_API_KEY ?? '', bailianKey: this.env.DASHSCOPE_API_KEY ?? '', adminPassword: this.env.ADMIN_PASSWORD ?? '', billingAccessKeyId: this.env.ALIYUN_BILLING_ACCESS_KEY_ID ?? '', billingAccessKeySecret: this.env.ALIYUN_BILLING_ACCESS_KEY_SECRET ?? '', billingSecurityToken: this.env.ALIYUN_BILLING_SECURITY_TOKEN ?? '', ...file }; }
  status() { const v = this.values(); return { deepseekConfigured: Boolean(v.deepseekKey), ttsConfigured: Boolean(v.ttsKey), bailianConfigured: Boolean(v.bailianKey), adminConfigured: v.adminPassword.length >= 12, billingConfigured: Boolean(v.billingAccessKeyId && v.billingAccessKeySecret) }; }
  update(patch) {
    for (const [key, value] of Object.entries(patch)) {
      if (!['deepseekKey', 'ttsKey', 'bailianKey', 'adminPassword', 'billingAccessKeyId', 'billingAccessKeySecret', 'billingSecurityToken'].includes(key) || typeof value !== 'string' || value.length > 2048) throw new Error('凭据设置不正确。');
      if (key === 'adminPassword' && value.length < 12) throw new Error('管理员密码至少 12 位。');
    }
    const merged = { ...this.values(), ...patch };
    if (Boolean(merged.billingAccessKeyId) !== Boolean(merged.billingAccessKeySecret)) throw new Error('请同时配置账户查询的 AccessKey ID 和 Secret。');
    const path = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(path, JSON.stringify(merged), { mode: 0o600 }); renameSync(path, this.path);
    return this.status();
  }
  verify(password) {
    const actual = this.values().adminPassword;
    if (actual.length < 12 || typeof password !== 'string') return false;
    const hash = value => createHash('sha256').update(value).digest();
    return timingSafeEqual(hash(actual), hash(password));
  }
}
