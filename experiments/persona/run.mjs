import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { Store } from '../../src/store.mjs';
import { CompanionModel } from '../../src/model.mjs';
import { Secrets } from '../../src/secrets.mjs';
import { cases, now } from './cases.mjs';
import { renderReport } from './report.mjs';

// Default is an offline rehearsal. --live explicitly enables billed DeepSeek calls.
// Uses the production model/prompt implementation but only isolated in-memory stores.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const live = args.includes('--live');
const characterName = args.find(x => x.startsWith('--character='))?.slice(12) ?? 'v1';
assert.match(characterName, /^v[0-9]+$/);
const runName = args.find(x => x.startsWith('--name='))?.slice(7) ?? (live ? 'v1' : 'dry-run');
assert.match(runName, /^[a-z0-9-]+$/);
assert(args.every(x => x === '--live' || x.startsWith('--name=') || x.startsWith('--character=')), 'Unknown argument');
const outDir = resolve(root, '.local/persona-eval', runName);
const outFile = resolve(outDir, 'results.json');
assert(!live || !existsSync(outFile), 'Choose a new --name to preserve the previous live run');
mkdirSync(outDir, { recursive: true, mode: 0o700 });
const baseline = JSON.parse(readFileSync(resolve(root, 'experiments/persona/baseline.json'), 'utf8'));
const candidate = readFileSync(resolve(root, `experiments/persona/character-${characterName}.txt`), 'utf8').trim();
const configs = { baseline: baseline.config, candidate: { ...baseline.config, character: candidate } };
const { character: ignoredBaseline, ...baseRest } = configs.baseline;
const { character: ignoredCandidate, ...candidateRest } = configs.candidate;
assert.deepEqual(baseRest, candidateRest, 'Only character may change');
assert(candidate.length < 12000 && candidate.length > 0);
assert.equal(configs.baseline.modelBaseUrl, 'https://api.deepseek.com');
let key = '';
if (live) {
  key = new Secrets(resolve(root, '.local/app/secrets.json')).values().deepseekKey;
  assert(key, 'DeepSeek key is not configured locally');
}
const MAX_CALLS = 48, MAX_ESTIMATED_CNY = 2;
const stats = { calls: 0, promptTokens: 0, completionTokens: 0, estimatedCny: 0, reservedCny: 0 };
const reservations = new Map();
const result = {
  createdAt: new Date().toISOString(), live, model: baseline.config.model, candidateVersion: characterName,
  conditions: { onlyCharacterChanges: true, fixedTime: new Date(now).toISOString(), syntheticDataOnly: true, realMessageSending: false, productionWrites: false, samplesPerVariant: 1, maxCalls: MAX_CALLS, maxEstimatedCny: MAX_ESTIMATED_CNY, note: '配置费率估算，非供应商账单；测试账本与生产账本隔离。合成资料的使用不等于自动长期记忆已实现。' },
  characters: { baseline: ignoredBaseline, candidate: ignoredCandidate },
  characterHashes: Object.fromEntries(Object.entries(configs).map(([v,c]) => [v, createHash('sha256').update(c.character).digest('hex')])),
  stats, cases: [],
};
function save() {
  writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(resolve(outDir, 'comparison.html'), renderReport(result), { mode: 0o600 });
}
for (const [caseIndex, scenario] of cases.entries()) {
  const item = { id: scenario.id, title: scenario.title, note: scenario.note ?? '', initialHistory: scenario.history ?? [], variants: {} };
  result.cases.push(item);
  // Alternate execution order to reduce a systematic time/order confound.
  for (const variant of caseIndex % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
    let clock = scenario.at ? Date.parse(scenario.at) : now;
    const store = new Store(':memory:', { now: () => clock });
    store.updateConfig({ ...configs[variant], totalBudget: 2, fixedReserve: 0, safetyReserve: 0 });
    const user = store.addUser(`synthetic-${scenario.id}-${variant}`);
    for (const [i, [role, content]] of (scenario.history ?? []).entries()) {
      const source = store.message(user.id, role, content);
      if (scenario.memoryIndexes?.includes(i)) store.remember(user.id, content, [source]);
    }
    const realReserve = store.reserve.bind(store), realSettle = store.settle.bind(store);
    store.reserve = (kind, amount, optional) => {
      assert(stats.estimatedCny + stats.reservedCny + amount <= MAX_ESTIMATED_CNY, 'Evaluation budget exhausted');
      const id = realReserve(kind, amount, optional);
      reservations.set(id, amount); stats.reservedCny += amount;
      return id;
    };
    store.settle = (id, amount, status) => {
      const reserved = reservations.get(id) ?? 0;
      stats.reservedCny = Math.max(0, stats.reservedCny - reserved);
      stats.estimatedCny += Number.isFinite(amount) ? amount : reserved;
      reservations.delete(id);
      realSettle(id, amount, status);
    };
    let turnCalls = [];
    const model = new CompanionModel({ store, secrets: { values: () => ({ deepseekKey: live ? key : 'dry-run-placeholder' }) }, fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.deepseek.com/chat/completions');
      assert(++stats.calls <= MAX_CALLS, 'Evaluation call cap exceeded');
      const request = JSON.parse(options.body);
      // Never persist headers, keys, environment, or secret values.
      const started = Date.now();
      const response = live ? await fetch(url, options) : new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ bubbles: ['离线占位回复'], voice: false, memories: [], reminderText: '', voiceInstruction: '' }) } }], usage: { prompt_tokens: 0, completion_tokens: 0 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (response.ok) {
        const data = await response.clone().json();
        stats.promptTokens += data.usage?.prompt_tokens ?? 0;
        stats.completionTokens += data.usage?.completion_tokens ?? 0;
        turnCalls.push({ request, response: data, elapsedMs: Date.now() - started });
      } else turnCalls.push({ request, httpStatus: response.status, elapsedMs: Date.now() - started });
      return response;
    } });
    const transcript = [];
    item.variants[variant] = transcript;
    try {
      for (const spec of scenario.turns) {
        const turn = typeof spec === 'string' ? { text: spec } : spec;
        clock += 1000;
        const source = turn.text ? store.message(user.id, 'user', turn.text) : null;
        let agreement;
        if (turn.saveReminder) {
          // Preserve the fixed 15:10 test time, not evaluation network time.
          const due = now + turn.saveReminder.minutes * 60000;
          const id = store.reminder(user.id, turn.saveReminder.text, due, { sources: [source] });
          agreement = { action: 'saved', when: new Date(due).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }), text: turn.saveReminder.text };
          assert.equal(store.upcomingReminders(user.id)[0].id, id);
        }
        turnCalls = [];
        const row = { user: turn.text ?? null, proactive: Boolean(turn.proactive), agreement: agreement ?? null, output: null, calls: turnCalls };
        transcript.push(row);
        row.output = await model.respond(user.id, { proactive: Boolean(turn.proactive), agreement });
        for (const content of row.output.bubbles) { clock += 1; store.message(user.id, 'assistant', content); }
        save();
        console.log(`${scenario.id} ${variant} ${transcript.length}/${scenario.turns.length} ok`);
      }
    } catch (error) {
      item.error = { variant, message: ['AssertionError', 'TimeoutError'].includes(error.name) ? error.name : 'Model call failed; inspect the captured non-secret HTTP status.' };
      save();
      throw new Error(`Stopped at ${scenario.id}/${variant}; existing outputs preserved.`);
    } finally { store.close(); }
  }
}
result.completedAt = new Date().toISOString();
save();
console.log(JSON.stringify({ live, cases: result.cases.length, stats, output: resolve(outDir, 'comparison.html') }));
