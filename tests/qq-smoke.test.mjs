import test from 'node:test';
import assert from 'node:assert/strict';
import { QqApi, QqApiError, matchTestMessage, messageAgeMs } from '../scripts/lib/qq-api.mjs';

function fixture(responses) {
  const calls = [];
  const api = new QqApi({
    appId: '123', appSecret: 'fixture-secret',
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options, body: options.body && JSON.parse(options.body) });
      const response = responses.shift();
      assert.ok(response, 'unexpected extra request');
      return new Response(JSON.stringify(response.body), { status: response.status ?? 200 });
    },
  });
  return { api, calls };
}
const token = { body: { access_token: 'fixture-token', expires_in: '7200' } };

test('passive replies increment sequence while ordinary proactive omits reply and wakeup fields', async () => {
  const { api, calls } = fixture([token, { body: { id: 'a' } }, { body: { id: 'b' } }, { body: { id: 'c' } }]);
  await api.text('user/1', 'one', { id: 'input-1', seq: 1 });
  await api.text('user/1', 'two', { id: 'input-1', seq: 2 });
  await api.text('user/1', 'proactive');
  assert.equal(calls[0].url, 'https://api.bot.qq.com/app/getAppAccessToken');
  assert.deepEqual(calls[0].body, { appId: '123', clientSecret: 'fixture-secret' });
  assert.match(calls[1].url, /user%2F1\/messages$/);
  assert.equal(calls[1].body.msg_seq, 1);
  assert.equal(calls[2].body.msg_seq, 2);
  assert.deepEqual(calls[3].body, { msg_type: 0, content: 'proactive' });
  assert.equal(calls[1].headers.Authorization, 'QQBot fixture-token');
  assert.equal(calls[1].redirect, 'error');
});

test('HTTP 200 business failure is not success and does not expose raw error text', async () => {
  const { api } = fixture([{ body: { code: 40034105, message: 'fixture-secret private text' } }]);
  await assert.rejects(() => api.accessToken(), error => {
    assert.ok(error instanceof QqApiError);
    assert.equal(error.code, 40034105);
    assert.doesNotMatch(error.message, /fixture-secret|private text/);
    return true;
  });
});

test('audio uploads without automatic delivery, then sends a single passive media message', async () => {
  const { api, calls } = fixture([token, { body: { file_info: 'file-ticket' } }, { body: { id: 'audio-message' } }]);
  await api.audio('user', { bytes: Buffer.from('audio-bytes'), filename: 'sample.wav' }, { id: 'input', seq: 4 });
  assert.deepEqual(calls[1].body, { file_type: 3, file_name: 'sample.wav', file_data: 'YXVkaW8tYnl0ZXM=', srv_send_msg: false });
  assert.deepEqual(calls[2].body, { msg_type: 7, media: { file_info: 'file-ticket' }, msg_id: 'input', msg_seq: 4 });
});

test('rejects oversized audio before authentication or uploading', async () => {
  const { api, calls } = fixture([]);
  await assert.rejects(() => api.audio('user', { bytes: Buffer.alloc(1024 * 1024 + 1), filename: 'large.wav' }, { id: 'input', seq: 1 }));
  assert.equal(calls.length, 0);
});

test('only C2C challenge sender can bind; other users and raw private contents are excluded', () => {
  const packet = { op: 0, t: 'C2C_MESSAGE_CREATE', d: {
    id: 'input', author: { user_openid: 'alice' }, timestamp: '2026-11-12T10:00:00+08:00',
    content: '/验证 123456', attachments: [{ content_type: 'audio/wav', asr_refer_text: 'private transcript', voice_wav_url: 'private-url' }],
  } };
  assert.equal(matchTestMessage({ ...packet, t: 'GROUP_AT_MESSAGE_CREATE' }, '123456'), null);
  assert.equal(matchTestMessage(packet, 'different'), null);
  assert.equal(matchTestMessage(packet, '123456', 'bob'), null);
  const result = matchTestMessage(packet, '123456');
  assert.equal(result.openid, 'alice');
  assert.equal(result.attachments[0].hasAsr, true);
  assert.doesNotMatch(JSON.stringify(result), /private transcript|private-url|验证/);
});

test('replayed old events retain platform age instead of looking newly received', () => {
  const now = Date.parse('2026-11-12T10:00:00Z');
  assert.equal(messageAgeMs({ messageAt: '2026-11-12T08:59:00Z', receivedAt: new Date(now).toISOString() }, now), 61 * 60_000);
  assert.throws(() => messageAgeMs({ messageAt: 'invalid' }, now));
  assert.throws(() => messageAgeMs({ messageAt: '2027-01-01T00:00:00Z' }, now));
});

test('unexpected gateway host cannot receive credentials', async () => {
  const { api } = fixture([token, { body: { url: 'wss://not-qq.example/socket' } }]);
  await assert.rejects(() => api.gateway(), /网关地址/);
});
