export const BAILIAN_MODEL = 'qwen-audio-3.1-tts-plus';
const MAX_AUDIO = 1024 * 1024;
const characters = text => [...text].reduce((n, c) => n + (/\p{Script=Han}/u.test(c) ? 2 : 1), 0);

async function readBounded(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('百炼返回了空响应。');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('百炼响应过大，请缩短试听文本。');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function wav(bytes) {
  if (bytes.length < 1000 || bytes.length > MAX_AUDIO || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('百炼没有返回有效的 WAV 音频。');
  return { bytes, filename: 'voice.wav' };
}

export function bailianAudioUrl(value) {
  const url = new URL(value);
  // The API can return an HTTP OSS URL. Fetch the same signed object over TLS,
  // never send the API key to storage, and never follow redirects.
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || !/^dashscope-[a-z0-9-]+\.oss-cn-(?:beijing|shanghai|hangzhou)\.aliyuncs\.com$/.test(url.hostname)) throw new Error('百炼音频下载地址不受支持。');
  url.protocol = 'https:';
  return url.href;
}

export class BailianVoice {
  constructor({ store, secrets, fetchImpl = fetch }) { Object.assign(this, { store, secrets, fetch: fetchImpl }); }
  connection() {
    const config = this.store.config(), key = this.secrets.values().bailianKey;
    if (!key) throw new Error('请先配置百炼 API Key。');
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(config.bailianWorkspace)) throw new Error('请先配置北京地域的百炼业务空间 ID。');
    return { config, key, base: `https://${config.bailianWorkspace}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts` };
  }
  async request(connection, path, body, signal, limit = MAX_AUDIO) {
    let response;
    try {
      response = await this.fetch(`${connection.base}/${path}`, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${connection.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    } catch {
      if (signal?.aborted) throw new Error('百炼请求已取消或超时，请稍后重试。');
      throw new Error('服务器暂时无法连接百炼，请检查业务空间与网络。');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const message = response.status === 401 ? '百炼密钥无效，请检查北京地域 API Key。' : response.status === 403 ? '百炼访问被拒绝，请检查业务空间和模型权限。' : response.status === 429 ? '百炼请求过于频繁，请稍后重试。' : `百炼请求失败（HTTP ${response.status}），请检查模型开通状态和账户额度。`;
      throw Object.assign(new Error(message), { rejected: response.status >= 400 && response.status < 500 && response.status !== 408 });
    }
    let data;
    try { data = JSON.parse((await readBounded(response, limit)).toString('utf8')); }
    catch { throw new Error('百炼返回了无效响应。'); }
    if (data.code || !data.output) throw Object.assign(new Error('百炼未完成请求，请检查音色、模型权限和账户额度。'), { rejected: true });
    return data;
  }
  async synthesize(text, { signal, optional = false, instruction = '', manual = false } = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 100) throw new Error('语音文本需为 1～100 字。');
    const connection = this.connection(), { config } = connection;
    if (!config.bailianVoice.trim()) throw new Error('请先选择或创建百炼音色。');
    const cost = characters(text) / 10000 * config.bailianPricePer10k;
    const callId = this.store.reserve('voice', cost, optional);
    const timeout = AbortSignal.timeout(60000), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let settled = false;
    try {
      const current = (config.voiceEmotionEnabled || manual) && typeof instruction === 'string' ? instruction.trim().slice(0, 160) : '';
      const data = await this.request(connection, 'SpeechSynthesizer', { model: BAILIAN_MODEL, input: {
        text, voice: config.bailianVoice, format: 'wav', sample_rate: 24000,
        rate: config.voiceSpeed, pitch: config.voicePitch, volume: config.voiceVolume,
        instruction: [config.voiceInstruction, current && `本句表达：${current}`].filter(Boolean).join('\n'),
        language_hints: ['zh'],
      } }, combined);
      const billed = data.usage?.characters;
      this.store.settle(callId, Number.isFinite(billed) && billed >= 0 ? billed / 10000 * config.bailianPricePer10k : cost, Number.isFinite(billed) && billed >= 0 ? 'settled' : 'estimated'); settled = true;
      const url = bailianAudioUrl(data.output.audio?.url);
      const audio = await this.fetch(url, { redirect: 'error', signal: combined });
      if (!audio.ok) { await audio.body?.cancel().catch(() => {}); throw new Error('百炼已生成语音，但音频下载失败。'); }
      return wav(await readBounded(audio, MAX_AUDIO));
    } catch (error) {
      if (!settled) this.store.settle(callId, error.rejected ? 0 : undefined, error.rejected ? 'rejected' : 'estimated');
      if (signal?.aborted) throw signal.reason;
      // Only our fixed messages are exposed; network errors may contain signed URLs.
      throw new Error(/^百炼|^服务器|^请先/.test(error.message) ? error.message : '百炼语音暂时不可用，请稍后重试。');
    }
  }
  async design({ prompt, text, signal } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 500) throw new Error('请用 1～500 字描述希望的声音。');
    if (typeof text !== 'string' || text.trim().length < 15 || text.length > 100) throw new Error('音色试听文本需为 15～100 字。');
    const connection = this.connection();
    const callId = this.store.reserve('voice-design', 0);
    let settled = false;
    try {
      const timeout = AbortSignal.timeout(60000);
      const data = await this.request(connection, 'customization', { model: 'voice-enrollment', input: { action: 'create_voice', target_model: BAILIAN_MODEL, voice_prompt: prompt.trim(), preview_text: text, prefix: 'fatfish', language_hints: ['zh'] }, parameters: { sample_rate: 24000, response_format: 'wav' } }, signal ? AbortSignal.any([signal, timeout]) : timeout, 2 * MAX_AUDIO);
      this.store.settle(callId, 0); settled = true;
      const result = data.output;
      if (typeof result.voice_id !== 'string' || result.voice_id.length > 300 || !result.voice_id.startsWith(`${BAILIAN_MODEL}-vd-`) || (result.target_model && result.target_model !== BAILIAN_MODEL)) throw new Error('百炼音色创建结果与模型不匹配。');
      const encoded = result.preview_audio?.data;
      if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('百炼音色预览无效。');
      return { voiceId: result.voice_id, model: BAILIAN_MODEL, ...wav(Buffer.from(encoded, 'base64')) };
    } catch (error) {
      if (!settled) this.store.settle(callId, error.rejected ? 0 : undefined);
      throw new Error(/^百炼|^服务器|^请先/.test(error.message) ? error.message : '百炼音色设计暂时不可用。');
    }
  }
}
