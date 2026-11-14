import { setTimeout as delay } from 'node:timers/promises';

// Gateway lifecycle only. User binding and message delivery belong to the caller.
export async function runQqGateway({ api, signal, onDispatch = async () => {}, onState = async () => {},
  socketFactory = url => new WebSocket(url), retryDelayMs = 1000, maxReconnects = 5,
  handshakeTimeoutMs = 20_000, stableAfterMs = 60_000 }) {
  let sessionId = null;
  let seq = null;
  let failures = 0;
  let observedSince = null;

  async function connect(token, url) {
    const socket = socketFactory(url);
    let heartbeat;
    let startup;
    let settled = false;
    let ack = true;
    let ready = false;
    let connectedAt = null;
    let queue = Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (result, error) => {
        if (settled) return;
        settled = true;
        clearInterval(heartbeat);
        clearTimeout(startup);
        signal.removeEventListener('abort', abort);
        try { socket.close(1000); } catch {}
        if (error) reject(error);
        else resolve({ ...result, connectedAt });
      };
      const abort = () => finish({ stopped: true });
      const send = packet => socket.send(JSON.stringify(packet));
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      startup = setTimeout(() => finish({ reason: 'handshake_timeout' }), handshakeTimeoutMs);
      socket.addEventListener('message', ({ data }) => {
        queue = queue.then(async () => {
          if (settled) return;
          const packet = JSON.parse(String(data));
          if (packet.op === 10) {
            const interval = Number(packet.d?.heartbeat_interval);
            if (!(interval > 0 && interval <= 300_000)) throw new Error('网关心跳周期无效。');
            send(sessionId && seq !== null
              ? { op: 6, d: { token: `QQBot ${token}`, session_id: sessionId, seq } }
              : { op: 2, d: { token: `QQBot ${token}`, intents: 1 << 25, shard: [0, 1] } });
            clearInterval(heartbeat);
            heartbeat = setInterval(() => {
              if (settled) return;
              if (!ack) { finish({ reason: 'heartbeat_timeout' }); return; }
              ack = false;
              try { send({ op: 1, d: seq }); }
              catch { finish({ reason: 'heartbeat_send_failed' }); }
            }, interval);
          } else if (packet.op === 7) {
            finish({ reason: 'server_reconnect' });
          } else if (packet.op === 9) {
            if (!packet.d) { sessionId = null; seq = null; api.token = null; }
            finish({ reason: 'invalid_session' });
          } else if (packet.op === 11) {
            ack = true;
            if (ready) await onState({ type: 'heartbeat', observedSince });
          } else if (packet.op === 1) {
            send({ op: 1, d: seq });
          } else if (packet.op === 0) {
            if (packet.t === 'READY') {
              if (typeof packet.d?.session_id !== 'string' || !packet.d.session_id) throw new Error('网关 READY 缺少会话标识。');
              sessionId = packet.d.session_id;
              observedSince = new Date().toISOString();
            }
            await onDispatch(packet);
            if (settled) return;
            if (packet.s != null) seq = packet.s;
            if (packet.t === 'READY' || packet.t === 'RESUMED') {
              ready = true;
              connectedAt = Date.now();
              clearTimeout(startup);
              await onState({ type: packet.t.toLowerCase(), observedSince });
            }
          }
        }).catch(error => finish(null, error));
      });
      socket.addEventListener('error', () => finish({ reason: 'socket_error' }));
      socket.addEventListener('close', event => {
        if (settled) return;
        if ([4914, 4915].includes(event.code)) {
          finish(null, new Error(`网关拒绝连接（code=${event.code}），停止自动重连。`));
          return;
        }
        if ([4004, 4006, 4007, 4009].includes(event.code)) {
          sessionId = null;
          seq = null;
          if (event.code === 4004) api.token = null;
        }
        finish({ reason: 'socket_closed', code: event.code });
      });
    }).finally(() => queue);
  }

  try {
    while (!signal.aborted) {
      let outcome;
      let token, url;
      try { token = await api.accessToken(); url = await api.gateway(); }
      catch { outcome = { reason: 'connection_setup_failed', connectedAt: null }; }
      if (signal.aborted) break;
      // Local persistence/dispatch errors must not be disguised as network retries.
      if (!outcome) outcome = await connect(token, url);
      if (outcome.stopped || signal.aborted) break;
      if (outcome.connectedAt !== null && Date.now() - outcome.connectedAt >= stableAfterMs) failures = 0;
      failures++;
      if (failures > maxReconnects) throw new Error('网关连续恢复失败，已停止自动重连。');
      await onState({ type: 'reconnecting', reason: outcome.reason, code: outcome.code, attempt: failures, observedSince });
      try { await delay(Math.min(retryDelayMs * 2 ** (failures - 1), 30_000), undefined, { signal }); }
      catch (error) { if (signal.aborted) break; throw error; }
    }
  } finally {
    await onState({ type: 'stopped', observedSince });
  }
}
