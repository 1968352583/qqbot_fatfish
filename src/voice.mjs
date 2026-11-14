import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { BailianVoice } from './bailian.mjs';

export class Voice {
  constructor({ store, secrets, fetchImpl = fetch }) { Object.assign(this, { store, secrets, fetch: fetchImpl }); this.bailian = new BailianVoice({ store, secrets, fetchImpl }); }
  async synthesize(text, { signal, optional = false, instruction = '' } = {}) {
    const config = this.store.config();
    if (config.voiceProvider === 'disabled') throw new Error('语音未启用。');
    if (text.length > 100) throw new Error('本次内容更适合文字。');
    if (config.voiceProvider === 'bailian') return this.bailian.synthesize(text, { signal, optional, instruction });
    if (config.voiceProvider === 'system') {
      if (process.platform !== 'darwin') throw new Error('当前系统需要配置云端语音。');
      const dir = await mkdtemp(join(tmpdir(), 'fatfish-voice-'));
      try {
        const path = join(dir, 'voice.wav');
        await new Promise((done, reject) => {
          const child = spawn('/usr/bin/say', ['-v', config.voiceName, '-r', String(config.voiceRate), '-o', path, '--file-format=WAVE', '--data-format=LEI16@24000', '--', text], { stdio: 'ignore', signal, timeout: 30000 });
          child.on('error', () => reject(new Error('语音合成不可用。')));
          child.on('exit', code => code === 0 ? done() : reject(new Error('语音合成失败。')));
        });
        const bytes = await readFile(path);
        if (bytes.length < 1000 || bytes.length > 1024 * 1024) throw new Error('语音长度不合适。');
        return { bytes, filename: 'voice.wav' };
      } finally { await rm(dir, { recursive: true, force: true }); }
    }
    if (!config.voiceEndpoint || !config.voiceModel || !this.secrets.values().ttsKey) throw new Error('云端语音尚未配置。');
    const cost = [...text].reduce((n, c) => n + (/\p{Script=Han}/u.test(c) ? 2 : 1), 0) / 10000 * config.voicePricePer10k;
    const callId = this.store.reserve('voice', cost, optional);
    try {
      const response = await this.fetch(config.voiceEndpoint, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${this.secrets.values().ttsKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: config.voiceModel, input: text, voice: config.voiceName, response_format: 'wav', sample_rate: 24000 }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
      if (!response.ok) { this.store.settle(callId, 0, 'rejected'); throw new Error('云端语音请求失败。'); }
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 1024 * 1024) { await response.body.cancel().catch(() => {}); throw new Error('语音文件过大。'); } chunks.push(chunk); }
      this.store.settle(callId, cost, 'estimated');
      const bytes = Buffer.concat(chunks); if (bytes.length < 1000) throw new Error('语音响应无效。');
      return { bytes, filename: 'voice.wav' };
    } catch { this.store.settle(callId, undefined); throw new Error('云端语音暂时不可用。'); }
  }
}
