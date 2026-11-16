import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { isIP } from 'node:net';

function clientAddress(req, trustProxy) {
  const peer = req.socket.remoteAddress;
  const ipv4Peer = peer?.startsWith('::ffff:') ? peer.slice(7) : peer;
  const loopback = peer === '::1' || (typeof ipv4Peer === 'string' && isIP(ipv4Peer) === 4 && ipv4Peer.startsWith('127.'));
  const forwarded = req.headers['x-real-ip'];
  return trustProxy === true && loopback && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : peer;
}

export function createAdminServer({ store, secrets, bot, voice, runtime, publicDir, publicOrigin, trustProxy = false }) {
  const sessions = new Map(), attempts = new Map();
  let voiceBusy = false;
  const safeUsers = () => store.users().map(({ openid, ...user }) => user);
  const fail = (message, status = 400) => Object.assign(new Error(message), { status });
  return createServer(async (req, res) => {
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
    const json = (status, value, extra = {}) => { res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra }); res.end(JSON.stringify(value)); };
    try {
      const localHosts = [`127.0.0.1:${res.socket.localPort}`, `localhost:${res.socket.localPort}`];
      const publicUrl = publicOrigin ? new URL(publicOrigin) : null;
      const allowed = publicUrl ? [publicUrl.host, ...localHosts] : localHosts;
      if (!allowed.includes(req.headers.host)) throw fail('访问地址不被允许。', 403);
      const url = new URL(req.url, `http://${req.headers.host}`);
      const mutation = !['GET', 'HEAD'].includes(req.method);
      if (mutation) {
        if (![...localHosts.map(host => `http://${host}`), ...(publicOrigin ? [publicOrigin] : [])].includes(req.headers.origin)) throw fail('请求来源无效。', 403);
        if (!req.headers['content-type']?.startsWith('application/json')) throw fail('请使用 JSON 请求。', 415);
      }
      let body = {};
      if (mutation) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 65536) throw fail('请求过大。', 413); chunks.push(chunk); } try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw fail('请求格式无效。'); } }
      const cookies = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('fatfish_session='))?.slice(16);
      const session = sessions.get(cookies);
      const authenticated = session && session.expires > Date.now();
      const cookie = value => `fatfish_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${value ? 43200 : 0}${publicUrl?.protocol === 'https:' && req.headers.host === publicUrl.host ? '; Secure' : ''}`;
      if (url.pathname === '/api/login' && req.method === 'POST') {
        const remote = clientAddress(req, trustProxy), previous = attempts.get(remote);
        const entry = previous && previous.until > Date.now() ? previous : { count: 0, until: Date.now() + 15 * 60000 };
        if (entry.count >= 5) throw fail('尝试次数较多，请 15 分钟后重试。', 429);
        if (!secrets.verify(body.password)) { entry.count++; attempts.set(remote, entry); throw fail('密码不正确，或尚未完成本机配置。', 401); }
        attempts.delete(remote); for (const [id, value] of sessions) if (value.expires < Date.now()) sessions.delete(id);
        const id = randomBytes(32).toString('hex'); sessions.set(id, { expires: Date.now() + 12 * 3600000 });
        json(200, { ok: true }, { 'Set-Cookie': cookie(id) }); return;
      }
      if (url.pathname === '/api/session' && req.method === 'GET') { json(200, { authenticated: Boolean(authenticated), configured: secrets.status().adminConfigured }); return; }
      if (url.pathname === '/api/health' && req.method === 'GET') {
        const ok = ['ready', 'resumed'].includes(runtime.gateway);
        json(ok ? 200 : 503, { ok, release: runtime.release ?? 'local' }); return;
      }
      if (url.pathname.startsWith('/api/')) {
        if (!authenticated) throw fail('请先登录。', 401);
        if (url.pathname === '/api/logout' && req.method === 'POST') { sessions.delete(cookies); json(200, { ok: true }, { 'Set-Cookie': cookie('') }); return; }
        if (url.pathname === '/api/state' && req.method === 'GET') { json(200, { config: store.config(), users: safeUsers(), usage: store.usage(), secrets: secrets.status(), reminders: store.reminders(), runtime }); return; }
        if (url.pathname === '/api/config' && req.method === 'PUT') { const config = store.updateConfig(body); bot.stop(); store.prune(); json(200, config); return; }
        if (url.pathname === '/api/secrets' && req.method === 'PUT') { const status = secrets.update(body); if (body.adminPassword) sessions.clear(); json(200, status); return; }
        if (['/api/voice/preview', '/api/voice/design'].includes(url.pathname) && req.method === 'POST') {
          if (!voice?.bailian) throw fail('百炼语音尚未接入。', 503);
          if (voiceBusy) throw fail('上一段语音仍在生成，请稍等。', 409);
          voiceBusy = true;
          try {
            const result = url.pathname.endsWith('/design') ? await voice.bailian.design({ prompt: body.prompt, text: body.text }) : await voice.bailian.synthesize(body.text, { instruction: body.instruction, manual: true });
            json(200, { audio: result.bytes.toString('base64'), mime: 'audio/wav', ...(result.voiceId ? { voiceId: result.voiceId, model: result.model } : {}) });
          } finally { voiceBusy = false; }
          return;
        }
        if (url.pathname === '/api/invites' && req.method === 'POST') { json(200, { code: store.invite(), expiresHours: 24 }); return; }
        const match = url.pathname.match(/^\/api\/users\/([a-f0-9-]+)(?:\/(messages|memories|reminders)(?:\/([a-f0-9-]+))?)?$/);
        if (match) {
          const [, id, resource, itemId] = match;
          if (!store.user(id)) throw fail('成员不存在。', 404);
          if (!resource && req.method === 'PUT') { bot.cancel(id); const { openid, ...user } = store.updateUser(id, body); json(200, user); return; }
          if (resource === 'messages' && req.method === 'GET') { const offset = Math.max(0, Math.min(1000000, Number(url.searchParams.get('offset')) || 0)); json(200, store.messages(id, { limit: 100, offset })); return; }
          if (resource === 'memories' && req.method === 'GET') { json(200, store.memories(id)); return; }
          if (resource === 'memories' && itemId && ['PUT', 'DELETE'].includes(req.method)) { if (req.method === 'PUT' && (typeof body.text !== 'string' || !body.text.trim())) throw fail('请输入记忆正文。'); bot.cancel(id); json(200, store.forget(id, { memoryId: itemId, replacement: req.method === 'PUT' ? body.text : undefined })); return; }
          if (resource === 'memories' && !itemId && req.method === 'POST') { if (typeof body.text !== 'string' || !body.text.trim()) throw fail('请输入记忆正文。'); bot.cancel(id); store.updateUser(id, {}); json(200, { id: store.remember(id, body.text) }); return; }
          if (resource === 'messages' && itemId && req.method === 'DELETE') { bot.cancel(id); json(200, store.forget(id, { messageId: itemId })); return; }
          if (resource === 'reminders' && itemId && req.method === 'DELETE') { json(200, { cancelled: Boolean(store.cancelReminder(id, itemId)) }); return; }
        }
        throw fail('没有这个操作。', 404);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw fail('不支持此操作。', 405);
      const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
      const target = files[url.pathname]; if (!target) throw fail('页面不存在。', 404);
      const contents = await readFile(resolve(publicDir, target[0])); res.writeHead(200, { ...headers, 'Content-Type': target[1] }); res.end(req.method === 'HEAD' ? undefined : contents);
    } catch (error) { json(error.status ?? 400, { error: error.status || !/SQLITE|database|ENOENT/i.test(error.message) ? error.message : '操作未完成，请稍后重试。' }); }
  });
}
