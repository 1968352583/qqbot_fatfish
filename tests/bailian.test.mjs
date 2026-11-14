import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BailianVoice, BAILIAN_MODEL, bailianAudioUrl } from '../src/bailian.mjs';
import { Voice } from '../src/voice.mjs';
import { Store } from '../src/store.mjs';
import { Secrets } from '../src/secrets.mjs';
import { Bot } from '../src/bot.mjs';
import { CompanionModel } from '../src/model.mjs';
import { createAdminServer } from '../src/server.mjs';

const audio = Buffer.alloc(24044); audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(24000, 24); audio.writeUInt32LE(48000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
const audioUrl = 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/preview.wav?Signature=fixture';
const output = (url = audioUrl) => Response.json({ output: { audio: { url } }, usage: { characters: 20 } });
function setup(fetchImpl) {
  const store = new Store(':memory:'); store.updateConfig({ voiceProvider: 'bailian', bailianWorkspace: 'llm-fixture', bailianPricePer10k: 1.4 });
  const secrets = { values: () => ({ bailianKey: 'fixture.private.key' }) };
  return { store, voice: new Voice({ store, secrets, fetchImpl }) };
}

test('百炼语音使用专属域名与表达参数，下载不携带密钥，按返回用量结算', async () => {
  const requests = [], { store, voice } = setup(async (url, options) => { requests.push({ url, ...options }); return options.method === 'POST' ? output() : new Response(audio); });
  try {
    store.updateConfig({ voiceInstruction: '自然亲近', voiceSpeed: 1.1, voicePitch: 0.9, voiceVolume: 60 });
    const result = await voice.synthesize('你回来啦！', { instruction: '开心一点' });
    assert.deepEqual(result.bytes, audio);
    assert.equal(requests[0].url, 'https://llm-fixture.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer');
    const body = JSON.parse(requests[0].body);
    assert.equal(body.model, BAILIAN_MODEL); assert.equal(body.input.format, 'wav'); assert.equal(body.input.sample_rate, 24000);
    assert.equal(body.input.instruction, '自然亲近\n本句表达：开心一点'); assert.equal(body.input.rate, 1.1); assert.equal(body.input.pitch, 0.9); assert.equal(body.input.volume, 60);
    assert.equal(requests[1].url, audioUrl.replace('http:', 'https:')); assert.equal(requests[1].headers, undefined); assert.equal(requests[1].redirect, 'error');
    assert.ok(Math.abs(store.usage().spent - 0.0028) < 1e-10);
  } finally { store.close(); }
});

test('百炼真实响应的流式占位时长修正为实际长度，PCM 内容保持原样', async () => {
  const streamed = Buffer.from(audio); streamed.writeUInt32LE(0x7fffffbf, 4); streamed.writeUInt32LE(0x7fffff9b, 40);
  const { store, voice } = setup(async (_url, options) => {
    if (JSON.parse(options.body ?? '{}').model === 'voice-enrollment') return Response.json({ output: { voice_id: `${BAILIAN_MODEL}-vd-fatfish-fixture`, target_model: BAILIAN_MODEL, preview_audio: { data: streamed.toString('base64') } } });
    return options.method === 'POST' ? output() : new Response(streamed);
  });
  try {
    const synthesized = await voice.synthesize('你好呀');
    const designed = await voice.bailian.design({ prompt: '清亮自然的声音', text: '你回来啦，今天有什么好玩的，快讲给我听。' });
    for (const result of [synthesized, designed]) assert.deepEqual(result.bytes, audio);
    assert.equal(streamed.readUInt32LE(40), 0x7fffff9b);
  } finally { store.close(); }
});

test('关闭自动情绪后忽略模型语气，管理员单句试听仍能指定语气', async () => {
  const instructions = [], { store, voice } = setup(async (_url, options) => { if (options.method === 'POST') { instructions.push(JSON.parse(options.body).input.instruction); return output(); } return new Response(audio); });
  try {
    store.updateConfig({ voiceEmotionEnabled: false, voiceInstruction: '保持平静' });
    await voice.synthesize('你好呀', { instruction: '很兴奋' });
    await voice.bailian.synthesize('你好呀', { instruction: '很兴奋', manual: true });
    assert.deepEqual(instructions, ['保持平静', '保持平静\n本句表达：很兴奋']);
  } finally { store.close(); }
});

test('百炼明确拒绝不计费，网络结果不明保留估算，下载失败保留已生成的费用', async () => {
  for (const mode of ['rejected', 'timeout', 'download']) {
    const { store, voice } = setup(async (_url, options) => {
      if (mode === 'rejected') return new Response('private provider details', { status: 401 });
      if (mode === 'timeout') throw new Error('network error with private key and signed URL');
      return options.method === 'POST' ? output() : new Response('', { status: 502 });
    });
    try {
      await assert.rejects(voice.synthesize('你好'), error => { assert.doesNotMatch(error.message, /private|signed/); return true; });
      const expected = mode === 'rejected' ? 0 : mode === 'timeout' ? 4 / 10000 * 1.4 : 20 / 10000 * 1.4;
      assert.ok(Math.abs(store.usage().spent - expected) < 1e-10);
    } finally { store.close(); }
  }
});

test('百炼下载拒绝非 OSS 地址、非 WAV 内容与超限响应', async () => {
  for (const url of ['https://127.0.0.1/private', 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com.evil.example/audio', 'https://user:pass@dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio', 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com:8080/audio']) assert.throws(() => bailianAudioUrl(url));
  for (const body of [Buffer.alloc(2000), Buffer.alloc(1024 * 1024 + 1)]) {
    const { store, voice } = setup(async (_url, options) => options.method === 'POST' ? output() : new Response(body));
    try { await assert.rejects(voice.synthesize('你好'), /百炼/); assert.ok(store.usage().spent > 0); } finally { store.close(); }
  }
});

test('预算、空文本与缺失配置在百炼请求前拦截', async () => {
  const { store, voice } = setup(() => assert.fail('must not reach API'));
  try {
    await assert.rejects(voice.bailian.synthesize(''), /1～100/);
    await assert.rejects(voice.bailian.design({ prompt: '温柔', text: '太短' }), /15～100/);
    store.updateConfig({ totalBudget: 0, fixedReserve: 0, safetyReserve: 0 });
    await assert.rejects(voice.synthesize('你好'), /预算/);
    await assert.rejects(voice.bailian.design({ prompt: '温柔', text: '你好呀，今天过得怎么样，想听你讲讲。' }), /预算/);
    store.updateConfig({ bailianWorkspace: '' }); await assert.rejects(voice.synthesize('你好'), /业务空间/);
  } finally { store.close(); }
});

test('音色设计返回试听和模型一致的音色 ID，未经选择不替换当前声音', async () => {
  let request;
  const voiceId = `${BAILIAN_MODEL}-vd-fatfish-fixture`;
  const { store, voice } = setup(async (_url, options) => { request = JSON.parse(options.body); return Response.json({ output: { target_model: BAILIAN_MODEL, voice_id: voiceId, preview_audio: { data: audio.toString('base64') } } }); });
  try {
    const before = store.config().bailianVoice;
    const result = await voice.bailian.design({ prompt: '自然亲近的成年女性', text: '你回来啦，今天怎么样，快来讲给我听吧。' });
    assert.equal(result.voiceId, voiceId); assert.deepEqual(result.bytes, audio);
    assert.equal(request.input.target_model, BAILIAN_MODEL); assert.equal(request.model, 'voice-enrollment'); assert.equal(request.input.action, 'create_voice');
    assert.equal(store.config().bailianVoice, before); assert.equal(store.usage().spent, 0);
  } finally { store.close(); }
});

test('模型语气只传给合成器，QQ 聊天正文和记忆不包含语气说明', async () => {
  const { store } = setup(); const user = store.addUser('fixture-user'); let prompt, spoken, options; const sent = [];
  try {
    const model = new CompanionModel({ store, secrets: { values: () => ({ deepseekKey: 'fixture' }) }, fetchImpl: async (_url, request) => { prompt = JSON.parse(request.body); return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ bubbles: ['你回来啦！'], voice: true, voiceInstruction: '带一点小开心', memories: [] }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }); } });
    const bot = new Bot({ store, model, sleep: async () => {}, voice: { synthesize: async (text, opts) => { spoken = text; options = opts; return { bytes: audio, filename: 'voice.wav' }; } }, transport: { audio: async () => sent.push('audio'), text: async (_id, value) => sent.push(value) } });
    await bot.accept({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { id: 'voice-guidance', content: '用语音回复我', timestamp: new Date().toISOString(), author: { user_openid: 'fixture-user' } } });
    assert.match(JSON.stringify(prompt), /voiceInstruction/); assert.equal(spoken, '你回来啦！'); assert.equal(options.instruction, '带一点小开心');
    assert.deepEqual(sent, ['audio']); assert.doesNotMatch(JSON.stringify(store.messages(user.id)), /小开心|voiceInstruction/);
  } finally { store.close(); }
});

test('百炼试听仅限登录管理员及同源请求，状态不回显百炼密钥', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fatfish-voice-')), { store } = setup(); let previews = 0;
  const secrets = new Secrets(join(dir, 'secrets.json'), { ADMIN_PASSWORD: 'fixture-admin-password', DASHSCOPE_API_KEY: 'fixture.bailian.secret' });
  const voice = { bailian: { synthesize: async (text, options) => { previews++; assert.equal(text, '你好'); assert.equal(options.manual, true); return { bytes: audio }; } } };
  const server = createAdminServer({ store, secrets, voice, bot: {}, runtime: { gateway: 'ready' }, publicDir: join(process.cwd(), 'public') });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, extra = {}, data = {}) => fetch(`${origin}${path}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(data) });
  try {
    assert.equal((await post('/api/voice/preview', {}, { text: '你好' })).status, 401);
    const login = await post('/api/login', {}, { password: 'fixture-admin-password' }), cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await post('/api/voice/preview', { Cookie: cookie, Origin: 'https://evil.example' }, { text: '你好' })).status, 403);
    assert.equal(previews, 0);
    const response = await post('/api/voice/preview', { Cookie: cookie }, { text: '你好' }); assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from((await response.json()).audio, 'base64'), audio); assert.equal(previews, 1);
    const state = await (await fetch(`${origin}/api/state`, { headers: { Cookie: cookie } })).json();
    assert.equal(state.secrets.bailianConfigured, true); assert.doesNotMatch(JSON.stringify(state), /fixture.bailian.secret/);
    assert.match(response.headers.get('content-security-policy'), /media-src 'self' blob:/);
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); store.close(); await rm(dir, { recursive: true, force: true }); }
});
