import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { runQqGateway } from '../scripts/lib/qq-gateway.mjs';

class Socket extends EventTarget {
  sent = [];
  send(data) { this.sent.push(JSON.parse(data)); }
  close() {}
  packet(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  closed(code) { const event = new Event('close'); event.code = code; this.dispatchEvent(event); }
}
async function until(predicate) {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await delay(1); }
  assert.ok(predicate(), 'gateway did not reach expected state');
}
function harness(options = {}) {
  const sockets = [], states = [], packets = [];
  const controller = new AbortController();
  const api = { accessToken: async () => 'test-token', gateway: async () => 'wss://test.qq.com' };
  const running = runQqGateway({ api, signal: controller.signal, retryDelayMs: 0,
    socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; },
    onState: async state => states.push(state), onDispatch: async packet => packets.push(packet), ...options });
  // Retain failures for assertions without allowing an unhandled rejection.
  running.catch(() => {});
  return { sockets, states, packets, controller, running };
}
async function identify(h) {
  await until(() => h.sockets.length === 1);
  const socket = h.sockets[0];
  socket.packet({ op: 10, d: { heartbeat_interval: 10000 } });
  socket.packet({ op: 0, t: 'READY', s: 1, d: { session_id: 'session-one' } });
  socket.packet({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: { id: 'input-one' } });
  await until(() => h.packets.length === 2);
  return socket;
}

test('QQ op=7 reconnects using the last processed sequence and keeps message observation', async () => {
  const h = harness();
  try {
    const first = await identify(h);
    first.packet({ op: 7 });
    await until(() => h.sockets.length === 2 || h.states.some(s => s.type === 'stopped'));
    if (h.sockets.length !== 2) await h.running;
    const second = h.sockets[1];
    second.packet({ op: 10, d: { heartbeat_interval: 10000 } });
    await until(() => second.sent.length === 1);
    assert.deepEqual(second.sent[0], { op: 6, d: { token: 'QQBot test-token', session_id: 'session-one', seq: 2 } });
    first.closed(4009); // A late close on the retired connection must not reset the replacement.
    first.packet({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 99, d: { id: 'stale' } });
    second.packet({ op: 0, t: 'RESUMED', s: 3, d: {} });
    second.packet({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 4, d: { id: 'input-two' } });
    await until(() => h.packets.length === 4);
    assert.deepEqual(h.packets.filter(p => p.t === 'C2C_MESSAGE_CREATE').map(p => p.d.id), ['input-one', 'input-two']);
    assert.equal(h.states.find(s => s.type === 'ready').observedSince, h.states.find(s => s.type === 'resumed').observedSince);
  } finally { h.controller.abort(); await h.running; }
});

test('invalid session reidentifies while fatal permission closure stops retrying', async () => {
  const h = harness();
  try {
    const first = await identify(h);
    first.packet({ op: 9, d: false });
    await until(() => h.sockets.length === 2);
    h.sockets[1].packet({ op: 10, d: { heartbeat_interval: 10000 } });
    await until(() => h.sockets[1].sent.length === 1);
    assert.equal(h.sockets[1].sent[0].op, 2);
    h.sockets[1].closed(4914);
    await assert.rejects(h.running, /4914/);
    assert.equal(h.sockets.length, 2);
  } finally { h.controller.abort(); await h.running.catch(() => {}); }
});

test('unacknowledged heartbeat fails instead of reporting a clean successful stop', async () => {
  const h = harness({ maxReconnects: 0 });
  try {
    await until(() => h.sockets.length === 1);
    h.sockets[0].packet({ op: 10, d: { heartbeat_interval: 5 } });
    h.sockets[0].packet({ op: 0, t: 'READY', s: 1, d: { session_id: 'heartbeat-session' } });
    await assert.rejects(h.running, /连续恢复失败/);
    assert.equal(h.sockets[0].sent.filter(p => p.op === 1).length, 1);
    assert.equal(h.states.at(-1).type, 'stopped');
  } finally { h.controller.abort(); await h.running.catch(() => {}); }
});

test('gateway lookup failures use a bounded retry budget', async () => {
  let attempts = 0;
  const h = harness({ maxReconnects: 2, api: {
    accessToken: async () => 'test-token',
    gateway: async () => { attempts++; throw new Error('fixture network failure'); },
  } });
  await assert.rejects(h.running, /连续恢复失败/);
  assert.equal(attempts, 3);
  assert.equal(h.states.filter(s => s.type === 'reconnecting').length, 2);
});
