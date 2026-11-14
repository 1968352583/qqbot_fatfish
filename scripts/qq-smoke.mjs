#!/usr/bin/env node
import { mkdir, readFile, writeFile, appendFile, open, unlink, stat, rename } from 'node:fs/promises';
import { resolve, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt, randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { QqApi, matchTestMessage, messageAgeMs } from './lib/qq-api.mjs';
import { runQqGateway } from './lib/qq-gateway.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local = resolve(root, '.local');
const sessionPath = resolve(local, 'qq-session.json');
const counterPath = resolve(local, 'qq-reply-counts.json');
const reportPath = resolve(local, 'qq-smoke-results.jsonl');
const command = process.argv[2] ?? 'help';
const usage = `QQ 官方 C2C 联调（Node.js 24，无第三方依赖）
  bash scripts/qq-smoke.sh check
  bash scripts/qq-smoke.sh listen
  bash scripts/qq-smoke.sh reply
  bash scripts/qq-smoke.sh voice /绝对路径/sample.wav
  bash scripts/qq-smoke.sh proactive
  node scripts/qq-smoke.mjs report

listen 不自动发送消息。按终端口令从测试 QQ 发消息后，只记录该账号的消息 ID、时间及附件类型。
reply 发三条固定文本；voice 发一条语音；proactive 发一条普通主动文本。
语音和主动命令需要 listen 保持运行，以便检查最新用户消息时间。
API 成功只代表接口接受；QQ 实际显示、播放需在客户端核对。`;

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
async function save(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}
async function record(action, details) {
  await appendFile(reportPath, `${JSON.stringify({ at: new Date().toISOString(), action, ...details })}\n`, { mode: 0o600 });
}
function userTag(openid) { return createHash('sha256').update(openid).digest('hex').slice(0, 8); }

async function sessionFor(api) {
  const session = await readJson(sessionPath, null);
  if (!session || session.appId !== api.appId) throw new Error('请先运行 listen，并从测试 QQ 发送终端显示的验证口令。');
  return session;
}

async function withLock(name, callback) {
  const path = resolve(local, `qq-${name}.lock`);
  let lock;
  try { lock = await open(path, 'wx', 0o600); }
  catch { throw new Error(`另一个 ${name} 进程正在运行；若曾强制退出，请确认没有对应进程后再删除 .local/qq-${name}.lock。`); }
  try { return await callback(); }
  finally { await lock.close(); await unlink(path); }
}

async function reserveReplies(session, count) {
  const counts = await readJson(counterPath, {});
  const key = `${session.appId}:${session.openid}:${session.messageId}`;
  const previous = counts[key] ?? 0;
  if (previous + count > 4) throw new Error('本条用户消息的四次回复额度不足，请在 QQ 中再发一条测试消息。');
  counts[key] = previous + count;
  // Reserve before sending: an uncertain network result must not reuse msg_seq.
  await save(counterPath, counts);
  return previous + 1;
}

async function listen(api) {
  await unlink(sessionPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const challenge = String(randomInt(100000, 1000000));
  const listenerId = randomUUID();
  let boundOpenid;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runQqGateway({
      api, signal: controller.signal,
      onState: async state => {
        const connected = ['ready', 'resumed', 'heartbeat'].includes(state.type);
        await save(resolve(local, 'qq-listener.json'), {
          appId: api.appId, listenerId, at: new Date().toISOString(), connected,
          recovering: state.type === 'reconnecting', observedSince: state.observedSince,
        });
        if (state.type === 'heartbeat') return;
        await record('gateway', { result: state.type, reason: state.reason, code: state.code, attempt: state.attempt });
        if (state.type === 'reconnecting') console.log('网关连接中断，正在自动恢复；测试账号保持绑定。');
        if (state.type === 'resumed') console.log('网关会话已恢复，可继续验证。');
        if (state.type === 'ready') {
          console.log(boundOpenid ? '网关重新鉴权成功；连续监听时间重新计算。' : `网关已连接。请用自己的测试 QQ 私聊机器人：/验证 ${challenge}`);
          console.log('保持本终端运行；在另一个终端执行 reply、voice 或 proactive。');
        }
      },
      onDispatch: async packet => {
        const message = matchTestMessage(packet, challenge, boundOpenid);
        if (!message) return;
        boundOpenid = message.openid;
        await save(sessionPath, { appId: api.appId, listenerId, ...message });
        await record('receive', { user: userTag(boundOpenid), attachments: message.attachments });
        console.log(`已收到测试用户消息，标识 ${userTag(boundOpenid)}；附件 ${message.attachments.length} 个。`);
      },
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

async function main() {
  if (command === 'help' || command === '--help') { console.log(usage); return; }
  await mkdir(local, { recursive: true, mode: 0o700 });
  if (command === 'report') {
    try { process.stdout.write(await readFile(reportPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; console.log('尚无联调记录。'); }
    return;
  }
  const api = new QqApi({ appId: process.env.QQ_APP_ID, appSecret: process.env.QQ_APP_SECRET });
  if (command === 'check') {
    await api.accessToken();
    await api.gateway();
    await record('check', { result: 'auth_and_gateway_ok' });
    console.log('凭据和获取网关成功。尚未验证收发或主动消息权限。');
    return;
  }
  if (command === 'listen') return withLock('listen', () => listen(api));
  if (!['reply', 'voice', 'proactive'].includes(command)) throw new Error('未知命令，请运行 help。');
  await withLock('send', async () => {
    const session = await sessionFor(api);
    const health = await readJson(resolve(local, 'qq-listener.json'), null);
    const healthAge = Date.now() - Date.parse(health?.at);
    if (!health?.connected || health.appId !== api.appId || health.listenerId !== session.listenerId || !Number.isFinite(healthAge) || healthAge > 90_000 || healthAge < 0) {
      throw new Error('请保持 listen 在线并重新发送验证口令，再执行发送测试。');
    }
    const age = messageAgeMs(session);
    if (command !== 'proactive' && age > 4 * 60_000) throw new Error('基础被动测试要求四分钟内的新消息，请在 QQ 中再发一条。');
    if (command === 'proactive') {
      const response = await api.text(session.openid, '【QQ 联调】普通主动消息测试。');
      const after = await sessionFor(api);
      const afterHealth = await readJson(resolve(local, 'qq-listener.json'), null);
      const observedMs = Date.now() - Date.parse(health.observedSince);
      const outsideWindow = age >= 61 * 60_000 && observedMs >= 61 * 60_000
        && after.messageId === session.messageId && afterHealth?.connected
        && afterHealth.listenerId === health.listenerId && afterHealth.observedSince === health.observedSince;
      await record(command, { result: 'api_accepted', messageId: response.id, idleMinutes: Math.floor(age / 60_000), outsideWindow });
      console.log(outsideWindow ? '窗口外主动消息已被 API 接受，请在 QQ 核对实际送达。' : '主动请求已被 API 接受；未满足 61 分钟无新消息及连续监听条件，不能据此认定窗口外发送通过。');
      return;
    }
    let audio;
    if (command === 'voice') {
      const path = process.argv[3];
      if (!path || !['.silk', '.wav', '.mp3', '.ogg'].includes(extname(path).toLowerCase())) throw new Error('请指定 SILK/WAV/MP3/OGG 音频文件。');
      if ((await stat(path)).size > 1024 * 1024) throw new Error('联调音频须小于 1 MB。');
      audio = { bytes: await readFile(path), filename: basename(path) };
    }
    const count = command === 'reply' ? 3 : 1;
    const first = await reserveReplies(session, count);
    for (let i = 0; i < count; i++) {
      const latest = await sessionFor(api);
      if (latest.messageId !== session.messageId) {
        await record(command, { result: 'interrupted_by_new_message', sent: i });
        console.log('收到新的用户消息，已暂停尚未发送的测试内容。');
        return;
      }
      const reply = { id: session.messageId, seq: first + i };
      const response = audio
        ? await api.audio(session.openid, audio, reply)
        : await api.text(session.openid, `【QQ 联调】第 ${i + 1}/${count} 条独立文本消息。`, reply);
      await record(command, { result: 'api_accepted', index: i + 1, messageId: response.id });
      if (i + 1 < count) await delay(1000);
    }
    console.log(command === 'voice' ? '语音请求已被 API 接受，请核对是否显示为语音条及能否播放。' : '三条消息已被 API 接受，请核对气泡顺序。');
  });
}

main().catch(async error => {
  console.error(error.message);
  try { await record(command, { result: 'failed', status: error.status, code: error.code }); } catch {}
  process.exitCode = 1;
});
