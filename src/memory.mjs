const MAX_RECENT = 24;
const MAX_QUOTE = 200;
const MAX_MEMORY = 500;
const KINDS = new Set(['fact', 'experience', 'habit']);
const speculative = /如果|假如|假设|假装|要是|也许|可能|或许|大概|似乎|听说|猜(?:测|想|一下)?/u;
const question = /[?？]|(?:吗|么|呢)[。！!\s]*$|是不是|会不会|有没有|能不能|是否|为什么|怎么办|怎么样/u;
const memoryControl = /忘记|忘掉|忘了|删掉|删除|清除|别.{0,3}(?:记|叫|提)|不要.{0,3}(?:记|叫|提)|更正|纠正|改叫|改成|修改为|记错|记反/u;
const reported = /(?:他|她|他们|她们|朋友|别人|有人|同事|同学|小说|电影|台词).{0,4}(?:说|写)|(?:举例|比如|这句话)/u;
const requestPrefix = /^(?:(?:但是|不过|对了|但|以后|今后|从现在起|从现在开始|从今以后|从今起|现在|大肥鱼|请帮我|请|麻烦你|麻烦|帮我|拜托|你能不能|你能否|你可以|你能|能不能|能否|可以)[\s，,]*)+/u;

function sentences(raw) {
  return raw.match(/[^。！？!?\n]+[。！？!?]?/gu) ?? [];
}

function exactQuote(raw, value, { minLength = 3, assertion = true } = {}) {
  if (typeof value !== 'string') return null;
  const quote = value.trim();
  if (quote.length < minLength || quote.length > MAX_QUOTE || !/[\p{L}\p{N}]/u.test(quote) || !raw.includes(quote)) return null;
  // Inspect the surrounding sentence, too: extracting just the assertion from
  // “可能喜欢…” or “喜欢…吗？” must not turn a guess into a remembered fact.
  if (assertion && !sentences(raw).some(sentence => sentence.includes(quote) && !speculative.test(sentence) && !question.test(sentence))) return null;
  return quote;
}

function evidenceClauses(raw, quote, enclosingQuote = false) {
  const result = [];
  for (const sentence of sentences(raw)) {
    if (quote && !sentence.includes(quote)) continue;
    let prefix = '';
    for (const part of sentence.split(/[，,；;：:]/u)) {
      const clause = part.trim();
      // Reported speech and conditional antecedents retain their scope over a
      // following comma. A separate negative request does not veto its sibling.
      const scoped = reported.test(prefix) || /如果|假如|假设|假装|要是/u.test(prefix);
      if (clause && (!quote || clause.includes(quote) || (enclosingQuote && quote.includes(clause)))
        && !scoped && !speculative.test(clause) && !reported.test(clause)) result.push(clause);
      prefix += `${clause}，`;
    }
  }
  return result;
}

function editIntent(raw, quote) {
  for (const clause of evidenceClauses(raw, quote, true)) {
    if (/不要忘|别忘|(?<!能)不能忘|不会忘|没有忘|不想忘|没让.{0,3}忘|不(?:要|用|必).{0,3}(?:删|清除|更正|纠正)/u.test(clause)) continue;
    if (question.test(clause) && !/(?:你)?(?:能不能|能否|可以|能).*(?:忘记|忘掉|删掉|删除|清除|更正|纠正)/u.test(clause)) continue;
    // Require a request, not a report like “你忘记了我的生日”.
    const request = clause.replace(requestPrefix, '').replace(/^你(?=把|别|不要|不用|更正|纠正|改)/u, '');
    if (/^(?:把.{1,120})?(?:忘记|忘掉|删掉|删除|清除).+/u.test(request)
      || /^把.{1,120}(?:忘记|忘掉|删掉|删除|清除)(?:吧|了|掉|一下)?[。！!？?\s]*$/u.test(request)
      || /^(?:别|不要|不用)(?:再)?(?:记住|记着|记|提起|提|叫).+/u.test(request)) return { action: 'forget', request };
    if (/^(?:更正|纠正|改叫|改成|修改为|你记错|你记反|刚才.{0,12}说错)/u.test(request)) return { action: 'correct', request };
  }
  return null;
}

function replacementClause(raw, quote, intent, { explicitOnly = false } = {}) {
  if (!quote && !explicitOnly) return null;
  for (const clause of evidenceClauses(raw, quote)) {
    if (question.test(clause)) continue;
    // Keep the whole source clause: saving only “上海” after deleting “我住北京”
    // would lose what Shanghai means. No inferred attribute is added here.
    const value = clause.replace(/[。！!]+$/u, '').trim();
    const request = value.replace(requestPrefix, '');
    if (value.length > MAX_QUOTE || /忘记|忘掉|忘了|删掉|删除|清除|(?:别|不要|不用)(?:再)?(?:记|叫|提)|不是|并非|不(?:再)?(?:叫|住|喜欢)/u.test(value)) continue;
    if ((intent.action === 'correct' && !explicitOnly) || /^(?:叫我|称呼我|改叫|改成|改为|修改为|更正为|纠正为|我现在(?:叫|住|喜欢|在|是))/u.test(request)) return value;
  }
  return null;
}

const attributes = [
  /名字|昵称|称呼|叫我|我叫/u,
  /地址|住址|住在|我住|我现在住|居住|家在/u,
  /生日|出生|生于/u,
  /喜欢|讨厌|偏好|爱吃/u,
];

function targetMatches(memory, intent, replacement, recent, currentId) {
  const { request } = intent;
  const object = request.replace(/^(?:把)?(?:别|不要|不用)?(?:再)?(?:忘记|忘掉|删掉|删除|清除|记住|记着|提起|叫我|称呼我|称呼|叫|提|记)?(?:我的)?/u, '')
    .replace(/(?:忘记|忘掉|删掉|删除|清除)?(?:了|啦|吧|一下)?[。！!？?\s]*$/u, '');
  // “旧地址在河边这件事” names a concrete fact despite ending in “这件事”.
  // Only a bare pointer such as “这个名字” needs contextual disambiguation.
  const referential = /^(?:这个|那个|这件|那件|这条|那条)(?:(?:旧|新)?(?:名字|昵称|称呼|事情|事|记忆|内容|地址))?$/u.test(object);
  const explicitName = request.match(/^(?:别|不要|不用)(?:再)?(?:叫我|叫|称呼我|称呼)(.+?)(?:了|啦|吧|[。！!？?]|$)/u)?.[1]
    ?? request.match(/(?:忘记|忘掉|删掉|删除|清除)(.+?)(?:这个|那个)(?:名字|昵称|称呼)/u)?.[1];
  if (explicitName && !/这个|那个|名字|昵称|称呼/u.test(explicitName)) return memory.text.includes(explicitName);
  if (referential) {
    if (!['habit', 'experience'].includes(memory.kind)) return false;
    const name = memory.text.match(/(?:叫我|我叫|称呼我|名字是|昵称是)([^\s，,。！？!?\n]{1,16})/u)?.[1]?.replace(/(?:就好|就行|好了|吧|啦|了)$/u, '');
    const located = recent.some(row => row.id !== currentId && row.kind === 'text' && ['user', 'assistant'].includes(row.role)
      && (memory.sources.includes(row.id) || (name && row.memories?.includes(memory.id) && row.content.includes(name))));
    if (!located) return false;
  }
  const target = intent.action === 'correct' ? `${request} ${replacement ?? ''}` : request;
  const requestedAttributes = attributes.filter(pattern => pattern.test(target));
  if (requestedAttributes.length) return requestedAttributes.some(pattern => pattern.test(memory.text));
  const content = target.replace(/(?:更正|纠正|一下|忘记|忘掉|删掉|删除|清除|别再|不要|不用|记住|记着|这个|那个|这件|那件|这条|那条|事情|记忆|内容|请|把|了|吧)/gu, '').replace(/[^\p{L}\p{N}]/gu, '');
  for (let index = 0; index < content.length - 1; index++) if (memory.text.includes(content.slice(index, index + 2))) return true;
  return referential && memory.kind === 'experience';
}

function readableMemory(quote, contexts) {
  if (!contexts.length) return quote;
  return [...contexts.map(row => `${row.role === 'user' ? '用户' : '大肥鱼'}：${row.content}`), `用户：${quote}`].join('\n');
}

/** Persist only source-backed statements belonging to this user and this turn. */
export function applyMemoryUpdates({ store, userId, input, response }) {
  const unchanged = { changed: false, edited: false };
  if (input?.kind !== 'text' || typeof input.raw !== 'string' || !input.raw.trim() || input.raw.trim().startsWith('/')) return unchanged;
  const raw = input.raw.trim();
  const recent = store.messages(userId, { limit: MAX_RECENT });
  const current = recent.find(row => row.id === input.messageId && row.role === 'user' && row.kind === 'text' && row.content === raw);
  if (!current) return unchanged;

  const edits = Array.isArray(response?.memoryEdits) ? response.memoryEdits.slice(0, 3) : [];
  const originalMemories = new Map(store.memories(userId).map(memory => [memory.id, memory]));
  const handled = new Set(), replacements = [];
  let edited = false, count = 0;
  for (const edit of edits) {
    if (!edit || typeof edit.id !== 'string' || handled.has(edit.id)) continue;
    const memory = originalMemories.get(edit.id);
    if (!memory) continue;
    const quote = exactQuote(raw, edit.quote, { assertion: false });
    const intent = quote && editIntent(raw, quote);
    if (!intent) continue;
    let replacement;
    if (edit.replacementQuote !== undefined && edit.replacementQuote !== null && edit.replacementQuote !== '') {
      const replacementQuote = exactQuote(raw, edit.replacementQuote, { minLength: 1, assertion: false });
      replacement = replacementClause(raw, replacementQuote, intent);
    } else {
      // Models occasionally select the right old memory but omit the new name.
      // Recover only an explicit positive source clause, never a summary.
      replacement = replacementClause(raw, null, intent, { explicitOnly: true });
    }
    if (replacement && attributes.some(pattern => pattern.test(replacement))
      && !attributes.some(pattern => pattern.test(replacement) && pattern.test(memory.text))) replacement = null;
    if (intent.action === 'correct' && !replacement) continue;
    if (!targetMatches(memory, intent, replacement, recent, current.id)) continue;
    // The request itself can repeat the private old value. Remove it as well;
    // the caller regenerates a short acknowledgment from memoryOutcome only.
    // A preceding edit can cascade into another explicitly selected memory.
    // Its replacement is still authorized by the original turn snapshot.
    if (store.memories(userId).some(row => row.id === memory.id)) {
      const result = store.forget(userId, { memoryId: memory.id, messageId: current.id });
      count += result.memories;
    }
    if (replacement) {
      replacements.push({ text: replacement, kind: KINDS.has(memory.kind) ? memory.kind : 'fact' });
    }
    edited = true; handled.add(memory.id);
  }
  if (edited) {
    // Add replacements after every cascade has finished, since they share the
    // now-deleted request as provenance and must not delete one another.
    for (const replacement of replacements) store.remember(userId, replacement.text, [current.id], { kind: replacement.kind });
    return { changed: true, edited: true, memoryOutcome: { action: replacements.length ? 'corrected' : 'forgotten', count } };
  }
  // Never learn a deletion/correction request as a fresh fact, even when a
  // malformed model edit was rejected above.
  if (memoryControl.test(raw) || store.config().autoMemory === false) return unchanged;

  const candidates = Array.isArray(response?.memoryCandidates) ? response.memoryCandidates : (Array.isArray(response?.quotes) ? response.quotes.map(quote => ({ quote, kind: 'fact', contextIds: [] })) : []);
  let changed = false;
  const allowed = new Map(recent.filter(row => row.id !== current.id && row.kind === 'text' && ['user', 'assistant'].includes(row.role)).map(row => [row.id, row]));
  for (const candidate of candidates.slice(0, 3)) {
    if (!candidate) continue;
    const quote = exactQuote(raw, candidate.quote);
    const kind = candidate.kind ?? 'fact';
    if (!quote || !KINDS.has(kind)) continue;
    const contextIds = candidate.contextIds ?? [];
    if (!Array.isArray(contextIds) || contextIds.length > 2 || contextIds.some(id => typeof id !== 'string' || !allowed.has(id))) continue;
    const selected = new Set(contextIds);
    const contexts = recent.filter(row => selected.has(row.id));
    if (contexts.some(row => row.content.length > MAX_QUOTE)) continue;
    const text = readableMemory(quote, contexts);
    if (text.length > MAX_MEMORY) continue;
    const id = store.remember(userId, text, [...contexts.map(row => row.id), current.id], { kind });
    if (id) changed = true;
  }
  return { changed, edited: false };
}
