// Minimal QQ C2C transport for the explicitly operated smoke test.
export const API_ORIGIN = 'https://api.bot.qq.com';

export class QqApiError extends Error {
  constructor(status, code) {
    super(`QQ API 调用失败：HTTP ${status}，code=${code ?? 'unknown'}`);
    this.status = status;
    this.code = code;
  }
}

export class QqApi {
  constructor({ appId, appSecret, fetchImpl = globalThis.fetch }) {
    if (!/^\d+$/.test(appId ?? '') || !appSecret) {
      throw new Error('请先在 .env.local 配置 QQ_APP_ID 和 QQ_APP_SECRET。');
    }
    this.appId = appId;
    this.appSecret = appSecret;
    this.fetch = fetchImpl;
    this.token = null;
    this.expiresAt = 0;
  }

  async request(path, { body, token } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `QQBot ${token}`;
    let response;
    try {
      response = await this.fetch(`${API_ORIGIN}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error('QQ 请求未完成，请检查网络、代理和平台 IP 白名单。');
    }
    let data;
    try { data = await response.json(); }
    catch { throw new QqApiError(response.status, 'invalid_json'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new QqApiError(response.status, 'invalid_body');
    // QQ may return an application error with HTTP 200. Do not log raw bodies.
    if (!response.ok || (data.code !== undefined && Number(data.code) !== 0)) {
      const code = /^[a-zA-Z0-9_-]{1,64}$/.test(String(data.code)) ? data.code : 'unknown';
      throw new QqApiError(response.status, code);
    }
    return data;
  }

  async accessToken() {
    if (this.token && Date.now() < this.expiresAt - 60_000) return this.token;
    const data = await this.request('/app/getAppAccessToken', {
      body: { appId: this.appId, clientSecret: this.appSecret },
    });
    if (typeof data.access_token !== 'string' || !data.access_token || !(Number(data.expires_in) > 0)) {
      throw new Error('QQ 凭证响应缺少有效的 token 或有效期。');
    }
    this.token = data.access_token;
    this.expiresAt = Date.now() + Number(data.expires_in) * 1000;
    return this.token;
  }

  async call(path, body) {
    return this.request(path, { body, token: await this.accessToken() });
  }

  async gateway() {
    const data = await this.call('/gateway');
    const url = new URL(data.url);
    if (url.protocol !== 'wss:' || !url.hostname.endsWith('.qq.com') || url.username || url.password) {
      throw new Error('QQ 返回了不符合预期的网关地址。');
    }
    return url.href;
  }

  async text(openid, content, reply) {
    const body = { msg_type: 0, content };
    if (reply) Object.assign(body, { msg_id: reply.id, msg_seq: reply.seq });
    return this.call(`/v2/users/${encodeURIComponent(openid)}/messages`, body);
  }

  async audio(openid, { bytes, filename }, reply) {
    // Keep the entire Base64 request comfortably below the documented 5M limit.
    if (!bytes.length || bytes.length > 1024 * 1024) throw new Error('联调音频须为 1 MB 以内的非空文件。');
    const upload = await this.call(`/v2/users/${encodeURIComponent(openid)}/files`, {
      file_type: 3,
      file_name: filename,
      file_data: bytes.toString('base64'),
      srv_send_msg: false,
    });
    if (typeof upload.file_info !== 'string' || !upload.file_info) throw new Error('QQ 上传响应缺少 file_info。');
    const body = {
      msg_type: 7,
      media: { file_info: upload.file_info },
    };
    if (reply) Object.assign(body, { msg_id: reply.id, msg_seq: reply.seq });
    return this.call(`/v2/users/${encodeURIComponent(openid)}/messages`, body);
  }
}

export function matchTestMessage(event, challenge, boundOpenid) {
  if (event.op !== 0 || event.t !== 'C2C_MESSAGE_CREATE') return null;
  const message = event.d;
  const openid = message?.author?.user_openid;
  if (typeof openid !== 'string' || !openid || typeof message?.id !== 'string') return null;
  if (boundOpenid ? openid !== boundOpenid : message.content?.trim() !== `/验证 ${challenge}`) return null;
  return {
    openid,
    messageId: message.id,
    receivedAt: new Date().toISOString(),
    // Use platform time for window checks; receiving a replay does not make it new.
    messageAt: message.timestamp,
    attachments: (Array.isArray(message.attachments) ? message.attachments : []).map(item => ({
      contentType: item.content_type,
      hasAsr: Boolean(item.asr_refer_text),
      hasVoiceUrl: Boolean(item.voice_wav_url),
    })),
  };
}

export function messageAgeMs(session, now = Date.now()) {
  const time = Date.parse(session.messageAt);
  if (!Number.isFinite(time) || time > now + 60_000) throw new Error('入站消息时间无效，请重新发送测试消息。');
  return Math.max(0, now - time);
}
