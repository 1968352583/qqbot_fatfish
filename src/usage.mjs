const voiceKinds = new Set(['voice', 'voice-design']);
const providers = new Set(['bailian', 'http', 'system', 'unknown']);
const outcomes = new Set(['pending', 'succeeded', 'audio_failed', 'rejected', 'uncertain', 'failed', 'unknown']);
const countedCharacters = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const modelPurposes = new Set(['conversation', 'proactive', 'recovery', 'agreement', 'memory']);
const modelOutcomes = new Set(['pending', 'succeeded', 'rejected', 'uncertain', 'failed', 'unknown']);
const tokenColumns = {
  promptTokens: 'prompt_tokens', completionTokens: 'completion_tokens', totalTokens: 'total_tokens',
  cacheHitTokens: 'cache_hit_tokens', cacheMissTokens: 'cache_miss_tokens', reasoningTokens: 'reasoning_tokens',
};
const modelName = value => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,120}$/.test(value) ? value : '';
const beijingDay = at => new Date(at + 8 * 3600000).toISOString().slice(0, 10);

// DeepSeek Chat Completions usage. Cache/reasoning counts are subsets, not
// additional tokens. Do not infer absent subfields or derive tokens from money.
// https://api-docs.deepseek.com/api/create-chat-completion/
export function modelTokenUsage(usage) {
  const tokens = {
    promptTokens: countedCharacters(usage?.prompt_tokens), completionTokens: countedCharacters(usage?.completion_tokens),
    totalTokens: countedCharacters(usage?.total_tokens),
    cacheHitTokens: countedCharacters(usage?.prompt_cache_hit_tokens) ?? countedCharacters(usage?.prompt_tokens_details?.cached_tokens),
    cacheMissTokens: countedCharacters(usage?.prompt_cache_miss_tokens),
    reasoningTokens: countedCharacters(usage?.completion_tokens_details?.reasoning_tokens),
  };
  if (tokens.totalTokens === null && tokens.promptTokens !== null && tokens.completionTokens !== null) {
    tokens.totalTokens = countedCharacters(tokens.promptTokens + tokens.completionTokens);
  }
  return tokens;
}

export function writeModelUsageDetails(db, id, patch, now) {
  if (!patch || typeof patch !== 'object' || !db.prepare('SELECT 1 FROM usage WHERE id=?').get(id)) return;
  const old = db.prepare('SELECT * FROM model_usage_details WHERE usage_id=?').get(id) ?? {};
  const model = patch.model === undefined ? old.model ?? '' : modelName(patch.model);
  const purpose = patch.purpose === undefined ? old.purpose ?? 'conversation' : modelPurposes.has(patch.purpose) ? patch.purpose : 'conversation';
  const outcome = patch.outcome === undefined ? old.outcome ?? 'unknown' : modelOutcomes.has(patch.outcome) ? patch.outcome : 'unknown';
  const tokens = Object.entries(tokenColumns).map(([key, column]) => countedCharacters(patch[key] === undefined ? old[column] : patch[key]));
  db.prepare(`INSERT INTO model_usage_details(usage_id,model,purpose,outcome,prompt_tokens,completion_tokens,total_tokens,
    cache_hit_tokens,cache_miss_tokens,reasoning_tokens,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(usage_id) DO UPDATE SET model=excluded.model,purpose=excluded.purpose,outcome=excluded.outcome,
    prompt_tokens=excluded.prompt_tokens,completion_tokens=excluded.completion_tokens,total_tokens=excluded.total_tokens,
    cache_hit_tokens=excluded.cache_hit_tokens,cache_miss_tokens=excluded.cache_miss_tokens,
    reasoning_tokens=excluded.reasoning_tokens,updated_at=excluded.updated_at`).run(id, model, purpose, outcome, ...tokens, now);
}

function modelEntry(row) {
  const tokens = Object.fromEntries(Object.entries(tokenColumns).map(([key, column]) => [key, countedCharacters(row[column])]));
  return {
    id: row.id, kind: row.kind, at: row.at, model: row.model ?? '', amount: row.amount, status: row.status,
    outcome: row.outcome ?? (row.status === 'reserved' ? 'pending' : row.status === 'rejected' ? 'rejected' : 'unknown'),
    ...tokens, tokenBasis: Object.values(tokens).some(value => value !== null) ? 'provider' : 'unknown',
    purpose: row.purpose ?? (row.kind === 'proactive' ? 'proactive' : 'conversation'),
  };
}

function modelTotal(rows) {
  const tokenFields = Object.keys(tokenColumns);
  const summary = {
    calls: 0, amount: 0, settledAmount: 0, reservedAmount: 0, estimatedAmount: 0,
    ...Object.fromEntries(tokenFields.map(key => [key, 0])),
    reportedTokenCalls: 0, unknownTokenCalls: 0, pendingCalls: 0, rejectedCalls: 0, uncertainCalls: 0, failedCalls: 0,
    tokenCoverage: Object.fromEntries(tokenFields.map(key => [key, { reportedCalls: 0, unknownCalls: 0 }])),
  };
  for (const row of rows) {
    summary.calls++; summary.amount += row.amount;
    if (row.status === 'settled') summary.settledAmount += row.amount;
    if (row.status === 'reserved') { summary.reservedAmount += row.amount; summary.pendingCalls++; }
    if (row.status === 'estimated') summary.estimatedAmount += row.amount;
    if (row.outcome === 'rejected' || row.status === 'rejected') summary.rejectedCalls++;
    if (row.outcome === 'uncertain') summary.uncertainCalls++;
    if (row.outcome === 'failed') summary.failedCalls++;
    if (['promptTokens', 'completionTokens', 'totalTokens'].every(key => row[key] !== null)) summary.reportedTokenCalls++;
    else summary.unknownTokenCalls++;
    for (const key of tokenFields) {
      if (row[key] !== null) { summary[key] += row[key]; summary.tokenCoverage[key].reportedCalls++; }
      else summary.tokenCoverage[key].unknownCalls++;
    }
  }
  for (const key of tokenFields) if (summary.calls && !summary.tokenCoverage[key].reportedCalls) summary[key] = null;
  return summary;
}

function modelGroup(rows, field) {
  return [...new Set(rows.map(row => row[field]))].sort().map(key => ({ [field]: key, ...modelTotal(rows.filter(row => row[field] === key)) }));
}

function modelUsageDetails(db, month, now) {
  const select = `SELECT usage.*,model_usage_details.model,model_usage_details.purpose,model_usage_details.outcome,
    model_usage_details.prompt_tokens,model_usage_details.completion_tokens,model_usage_details.total_tokens,
    model_usage_details.cache_hit_tokens,model_usage_details.cache_miss_tokens,model_usage_details.reasoning_tokens
    FROM usage LEFT JOIN model_usage_details ON model_usage_details.usage_id=usage.id
    WHERE (usage.kind IN ('conversation','proactive') OR model_usage_details.usage_id IS NOT NULL)`;
  const rows = db.prepare(`${select} AND usage.month=?`).all(month).map(modelEntry);
  const recent = db.prepare(`${select} ORDER BY usage.at DESC,usage.rowid DESC LIMIT 20`).all().map(modelEntry);
  const end = Date.parse(`${beijingDay(now)}T00:00:00+08:00`) + 86400000, start = end - 14 * 86400000;
  const dailyRows = db.prepare(`${select} AND usage.at>=? AND usage.at<?`).all(start, end).map(modelEntry);
  const daily = Array.from({ length: 14 }, (_, i) => {
    const day = beijingDay(start + i * 86400000);
    return { day, ...modelTotal(dailyRows.filter(row => beijingDay(row.at) === day)) };
  });
  return { ...modelTotal(rows), byKind: modelGroup(rows, 'kind'), byModel: modelGroup(rows, 'model'), daily, recent };
}

// Only numeric accounting metadata and fixed classifications are persisted.
// Text, instructions, URLs, audio, request headers and credentials have no slot.
export function writeUsageDetails(db, id, patch, now) {
  if (!patch || typeof patch !== 'object' || !db.prepare('SELECT 1 FROM usage WHERE id=?').get(id)) return;
  const old = db.prepare('SELECT * FROM usage_details WHERE usage_id=?').get(id) ?? {};
  const provider = patch.provider === undefined ? old.provider ?? 'unknown' : providers.has(patch.provider) ? patch.provider : 'unknown';
  const model = patch.model === undefined ? old.model ?? '' : typeof patch.model === 'string' && /^[a-zA-Z0-9_.:/-]{1,120}$/.test(patch.model) ? patch.model : '';
  const estimated = patch.estimatedCharacters === undefined ? old.estimated_characters ?? null : countedCharacters(patch.estimatedCharacters);
  const reported = patch.reportedCharacters === undefined ? old.billed_characters ?? null : countedCharacters(patch.reportedCharacters);
  const price = patch.pricePer10k === undefined ? old.price_per_10k ?? null : Number.isFinite(patch.pricePer10k) && patch.pricePer10k >= 0 ? patch.pricePer10k : null;
  const outcome = patch.outcome === undefined ? old.outcome ?? 'unknown' : outcomes.has(patch.outcome) ? patch.outcome : 'unknown';
  db.prepare(`INSERT INTO usage_details(usage_id,provider,model,estimated_characters,billed_characters,price_per_10k,outcome,updated_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(usage_id) DO UPDATE SET provider=excluded.provider,model=excluded.model,
    estimated_characters=excluded.estimated_characters,billed_characters=excluded.billed_characters,
    price_per_10k=excluded.price_per_10k,outcome=excluded.outcome,updated_at=excluded.updated_at`).run(id, provider, model, estimated, reported, price, outcome, now);
}

function entry(row) {
  const reportedCharacters = countedCharacters(row.billed_characters), estimatedCharacters = countedCharacters(row.estimated_characters);
  return {
    id: row.id, kind: row.kind, month: row.month, at: row.at, provider: row.provider ?? 'unknown', model: row.model ?? '',
    amount: row.amount, status: row.status,
    outcome: row.outcome ?? (row.status === 'reserved' ? 'pending' : row.status === 'rejected' ? 'rejected' : 'unknown'),
    reportedCharacters, estimatedCharacters, pricePer10k: row.price_per_10k ?? null,
    characterBasis: reportedCharacters !== null ? 'provider' : estimatedCharacters !== null ? 'estimated' : row.provider === 'system' ? 'not_applicable' : 'unknown',
  };
}

function total(rows) {
  const summary = {
    calls: 0, amount: 0, settledAmount: 0, reservedAmount: 0, estimatedAmount: 0,
    reportedCharacters: 0, estimatedCharacters: 0, reportedCharacterCalls: 0, estimatedCharacterCalls: 0, unknownCharacterCalls: 0,
    pendingCalls: 0, rejectedCalls: 0, uncertainCalls: 0, failedCalls: 0, unknownOutcomeCalls: 0,
  };
  for (const row of rows) {
    summary.calls++; summary.amount += row.amount;
    if (row.status === 'settled') summary.settledAmount += row.amount;
    if (row.status === 'reserved') { summary.reservedAmount += row.amount; summary.pendingCalls++; }
    if (row.status === 'estimated') summary.estimatedAmount += row.amount;
    if (row.status === 'rejected') summary.rejectedCalls++;
    if (row.outcome === 'uncertain') summary.uncertainCalls++;
    if (['audio_failed', 'failed'].includes(row.outcome)) summary.failedCalls++;
    if (row.outcome === 'unknown') summary.unknownOutcomeCalls++;
    if (row.characterBasis === 'provider') { summary.reportedCharacters += row.reportedCharacters; summary.reportedCharacterCalls++; }
    else if (row.characterBasis === 'estimated' && row.status !== 'rejected') { summary.estimatedCharacters += row.estimatedCharacters; summary.estimatedCharacterCalls++; }
    else if (row.characterBasis === 'unknown') summary.unknownCharacterCalls++;
  }
  return summary;
}

function group(rows, field) {
  return [...new Set(rows.map(row => row[field]))].sort().map(key => ({ [field]: key, ...total(rows.filter(row => row[field] === key)) }));
}

export function usageDetails(db, month, now = Date.now()) {
  const join = `FROM usage LEFT JOIN usage_details ON usage_details.usage_id=usage.id
    LEFT JOIN model_usage_details ON model_usage_details.usage_id=usage.id`;
  const rows = db.prepare(`SELECT usage.*,usage_details.provider,usage_details.model,usage_details.estimated_characters,
    usage_details.billed_characters,usage_details.price_per_10k,COALESCE(usage_details.outcome,model_usage_details.outcome) outcome
    ${join} WHERE usage.month=?`).all(month).map(entry);
  const voice = rows.filter(row => voiceKinds.has(row.kind));
  const recent = db.prepare(`SELECT usage.*,usage_details.provider,usage_details.model,usage_details.estimated_characters,
    usage_details.billed_characters,usage_details.price_per_10k,usage_details.outcome ${join}
    WHERE usage.kind IN ('voice','voice-design') ORDER BY usage.at DESC,usage.rowid DESC LIMIT 20`).all().map(entry);
  return { breakdown: group(rows, 'kind'), voice: { ...total(voice), byKind: group(voice, 'kind'), byProvider: group(voice, 'provider'), recent }, model: modelUsageDetails(db, month, now) };
}
