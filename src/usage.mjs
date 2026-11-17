const voiceKinds = new Set(['voice', 'voice-design']);
const providers = new Set(['bailian', 'http', 'system', 'unknown']);
const outcomes = new Set(['pending', 'succeeded', 'audio_failed', 'rejected', 'uncertain', 'failed', 'unknown']);
const countedCharacters = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

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

export function usageDetails(db, month) {
  const join = 'FROM usage LEFT JOIN usage_details ON usage_details.usage_id=usage.id';
  const rows = db.prepare(`SELECT usage.*,usage_details.provider,usage_details.model,usage_details.estimated_characters,
    usage_details.billed_characters,usage_details.price_per_10k,usage_details.outcome ${join} WHERE usage.month=?`).all(month).map(entry);
  const voice = rows.filter(row => voiceKinds.has(row.kind));
  const recent = db.prepare(`SELECT usage.*,usage_details.provider,usage_details.model,usage_details.estimated_characters,
    usage_details.billed_characters,usage_details.price_per_10k,usage_details.outcome ${join}
    WHERE usage.kind IN ('voice','voice-design') ORDER BY usage.at DESC,usage.rowid DESC LIMIT 20`).all().map(entry);
  return { breakdown: group(rows, 'kind'), voice: { ...total(voice), byKind: group(voice, 'kind'), byProvider: group(voice, 'provider'), recent } };
}
