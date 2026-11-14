import { mkdir, chmod, readFile, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { QqApi } from '../scripts/lib/qq-api.mjs';
import { runQqGateway } from '../scripts/lib/qq-gateway.mjs';
import { Store } from './store.mjs';
import { Secrets } from './secrets.mjs';
import { CompanionModel } from './model.mjs';
import { Voice } from './voice.mjs';
import { Bot } from './bot.mjs';
import { createAdminServer } from './server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.DATA_DIR ?? resolve(root, '.local/app'));
await mkdir(dataDir, { recursive: true, mode: 0o700 });
await chmod(dataDir, 0o700);
const lockPath = resolve(dataDir, 'app.lock');
let lock;
try { lock = await open(lockPath, 'wx', 0o600); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const pid = Number(await readFile(lockPath, 'utf8'));
  let stale = pid === process.pid;
  if (Number.isInteger(pid) && pid > 0 && !stale) { try { process.kill(pid, 0); } catch (e) { stale = e.code === 'ESRCH'; } }
  if (!stale) throw new Error('已有应用实例运行；请先停止原实例。');
  await unlink(lockPath); lock = await open(lockPath, 'wx', 0o600);
}
await lock.writeFile(String(process.pid));
const store = new Store(resolve(dataDir, 'fatfish.sqlite'));
await chmod(resolve(dataDir, 'fatfish.sqlite'), 0o600);
const secrets = new Secrets(resolve(dataDir, 'secrets.json'));
const runtime = { gateway: 'starting', startedAt: new Date().toISOString(), events: [] };
try { runtime.release = (await readFile(resolve(root, 'RELEASE'), 'utf8')).trim(); }
catch (error) { if (error.code !== 'ENOENT') throw error; runtime.release = 'local'; }
const log = (kind, message) => { runtime.events.unshift({ at: new Date().toISOString(), kind, message: String(message).slice(0, 200) }); runtime.events.splice(50); console.log(`[${kind}] ${String(message).slice(0, 200)}`); };
const api = new QqApi({ appId: process.env.QQ_APP_ID, appSecret: process.env.QQ_APP_SECRET });
if (!store.users().length) {
  try { const previous = JSON.parse(await readFile(resolve(root, '.local/qq-session.json'), 'utf8')); if (previous.appId === api.appId && typeof previous.openid === 'string') store.addUser(previous.openid, '管理员'); }
  catch (error) { if (error.code !== 'ENOENT') log('setup', '未自动导入此前测试账号，可使用邀请码加入。'); }
}
const model = new CompanionModel({ store, secrets });
const voice = new Voice({ store, secrets });
const bot = new Bot({ store, model, voice, transport: api, log });
const controller = new AbortController();
const pending = new Set();
const track = promise => { pending.add(promise); promise.catch(() => log('runtime', '操作未完成。')).finally(() => pending.delete(promise)); };
const server = createAdminServer({ store, secrets, bot, voice, runtime, publicDir: resolve(root, 'public'), publicOrigin: process.env.ADMIN_ORIGIN });
const port = Number(process.env.PORT ?? 3210), host = process.env.HOST ?? '127.0.0.1';
await new Promise((done, reject) => { server.once('error', reject); server.listen(port, host, done); });
console.log(`大肥鱼管理员入口：http://${host}:${port}`);
const timer = setInterval(() => { if (['ready', 'resumed'].includes(runtime.gateway)) track(bot.tick()); }, 15000);
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true; clearInterval(timer); bot.stop(); controller.abort(); server.close();
}
process.once('SIGINT', stop); process.once('SIGTERM', stop);
while (!controller.signal.aborted) {
  try {
    await runQqGateway({ api, signal: controller.signal,
      onDispatch: packet => { if (!stopping && packet.t === 'C2C_MESSAGE_CREATE') track(bot.accept(packet)); },
      onState: state => { if (state.type !== 'heartbeat') { runtime.gateway = state.type; log('gateway', ({ ready: 'QQ 已连接', resumed: 'QQ 会话已恢复', reconnecting: 'QQ 正在重连', stopped: 'QQ 连接已停止' })[state.type] ?? state.type); } },
    });
  } catch (error) {
    runtime.gateway = 'failed'; log('gateway', error.message);
    if (/4914|4915/.test(error.message)) break;
    try { await delay(60000, undefined, { signal: controller.signal }); } catch { break; }
  }
}
// Keep the administrator available after terminal gateway failure, so the owner can inspect it.
await new Promise(done => { if (stopping) done(); else { process.once('SIGINT', done); process.once('SIGTERM', done); } });
await stop();
// Allow aborted model/send operations to finish their bookkeeping before closing SQLite.
await Promise.allSettled([...pending]);
store.close(); await lock.close(); await unlink(lockPath);
