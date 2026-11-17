const $ = selector => document.querySelector(selector);
const node = (tag, text, className) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; };
const button = (text, fn, cls = 'secondary') => { const e = node('button', text, cls); e.type = 'button'; e.onclick = () => Promise.resolve(fn()).catch(error => toast(error.message)); return e; };
let state, selectedUser, page = 'overview', older = 0, toastTimer, usageView = 'model';
const audioUrls = new Set();
function toast(text) { $('#toast').textContent = text; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4500); }
async function api(path, method = 'GET', data) { const response = await fetch(`/api${path}`, { method, headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }); const value = await response.json(); if (!response.ok) { if (response.status === 401) showLogin(); throw new Error(value.error ?? '操作失败'); } return value; }
function showLogin() { $('#login').classList.remove('hidden'); $('#shell').classList.add('hidden'); }
function showApp() { $('#login').classList.add('hidden'); $('#shell').classList.remove('hidden'); }
const pageGroups = [
  ['日常管理', [['overview', '◷', '总览', '看看今天的陪伴与运行近况。'], ['chats', '☷', '聊天与记忆', '那些慢慢积累的小事，都在这里。'], ['members', '♧', '成员管理', '邀请朋友，管理每个人的偏好。'], ['reminders', '◴', '约定提醒', '查看已经记下的约定与赴约状态。']]],
  ['陪伴设置', [['character', '◇', '角色与表达', '让它保持熟悉的样子。'], ['proactive', '↗', '主动聊天', '找到舒服的联系频率与时段。'], ['voice', '♫', '语音与音色', '调整声音、语气与语音回复习惯。']]],
  ['运行与费用', [['usage', '▥', '用量统计', '查看本项目的模型 Token、语音字符与费用估算。'], ['accounts', '◎', '账户余额', '分别查询 DeepSeek 与阿里云的账户信息。'], ['models', '◉', '模型与预算', '管理连接、密钥、单价与预算保护。']]],
];
const pages = pageGroups.flatMap(([, entries]) => entries);
const pageFromHash = () => { const hash = location.hash.slice(1), id = ({ interaction: 'proactive' })[hash] ?? hash; return pages.some(p => p[0] === id) ? id : 'overview'; };
for (const [group, entries] of pageGroups) {
  const section = node('section', undefined, 'nav-group'); section.append(node('div', group, 'nav-label'));
  for (const [id, icon, label] of entries) { const b = button('', () => { location.hash = id; }, ''); b.append(node('span', icon), node('b', label)); b.dataset.page = id; section.append(b); }
  $('#nav').append(section);
}
window.addEventListener('hashchange', () => { page = pageFromHash(); render().catch(e => toast(e.message)); });
$('#login-form').onsubmit = async event => { event.preventDefault(); const b = event.submitter; b.disabled = true; try { await api('/login', 'POST', { password: $('#password').value }); $('#password').value = ''; page = pageFromHash(); await refresh(); showApp(); } catch (error) { toast(error.message); } finally { b.disabled = false; } };
$('#logout').onclick = async () => { await api('/logout', 'POST', {}); showLogin(); };
$('#refresh').onclick = () => refresh().catch(e => toast(e.message));
async function refresh() { state = await api('/state'); if (!state.users.some(u => u.id === selectedUser)) selectedUser = state.users[0]?.id; const online = ['ready', 'resumed'].includes(state.runtime.gateway); $('#connection').textContent = online ? 'QQ 已连接' : 'QQ 未连接'; $('#connection-dot').classList.toggle('online', online); await render(); }
function card(title, subtitle) { const e = node('section', undefined, 'card form-section'); e.append(node('h2', title)); if (subtitle) e.append(node('p', subtitle, 'muted')); return e; }
const time = timestamp => new Date(timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function openDialog({ title, description = '', value, confirm = '保存', success = '已保存', danger = false, onSave }) {
  $('#dialog-title').textContent = title; $('#dialog-description').textContent = description;
  $('#dialog-value').classList.toggle('hidden', value === undefined); $('#dialog-value').value = value ?? ''; $('#dialog-submit').textContent = confirm;
  $('#dialog-submit').className = danger ? 'danger' : 'primary';
  $('#dialog-cancel').onclick = () => $('#dialog').close();
  $('#dialog-form').onsubmit = async event => { event.preventDefault(); event.submitter.disabled = true; let saved = false; try { await onSave($('#dialog-value').value); saved = true; $('#dialog').close(); toast(success); await refresh(); } catch (e) { toast(saved ? `${success}，但刷新未完成：${e.message}` : e.message); } finally { event.submitter.disabled = false; } };
  $('#dialog').showModal();
}
const labels = {
  enabled: '机器人总开关', proactiveEnabled: '允许主动聊天', autoMemory: '自动积累共同经历与相处习惯', proactiveAllowCasual: '允许轻松开新话题', proactiveRetryHours: '未开场时再次考虑的间隔（小时）', character: '基础角色卡', model: '模型名称', modelBaseUrl: '模型地址',
  maxBubbles: '每次最多几个气泡', replyGapMs: '气泡间隔（毫秒）', contextMessages: '近期上下文消息数', retentionDays: '聊天记录保留（天）',
  proactiveDaily: '每日主动开场上限', startHour: '开始时段（北京时间）', endHour: '结束时段（北京时间）', intervalHours: '主动最小间隔（小时）',
  busyHours: '表示忙碌后暂停（小时）', unansweredLimit: '连续未回复次数', unansweredPauseHours: '未回复后暂停（小时）', reminderGraceMinutes: '提醒补发窗口（分钟）',
  autoVoice: '允许偶尔自动发语音', autoVoiceChance: '适合语音时选用概率（0～1）', voiceWithText: '语音同时附文字', voiceProvider: '语音方式', voiceName: '音色名称', voiceModel: '云端语音模型', voiceEndpoint: '云端语音完整地址', voiceRate: '本机语速',
  bailianWorkspace: '北京地域业务空间 ID', bailianVoice: '百炼音色 ID', voiceInstruction: '默认语气与表达习惯', voiceEmotionEnabled: '根据聊天内容自动调整情绪', voiceSpeed: '语速（0.5～2）', voicePitch: '音调（0.5～2）', voiceVolume: '音量（0～100）', bailianPricePer10k: '百炼估算价（元／万计费字符）',
  totalBudget: '总预算目标（元／月）', fixedReserve: '预留固定开支（元／月）', safetyReserve: '费用余量（元／月）', warnPercent: '预警阈值（%）', reducePercent: '降级阈值（%）', inputPrice: '输入估算价（元／百万 token）', outputPrice: '输出估算价（元／百万 token）', voicePricePer10k: '语音估算价（元／万字符）',
};
function settingsForm(title, subtitle, keys) {
  const section = card(title, subtitle), form = node('form'), grid = node('div', undefined, 'form-grid');
  for (const key of keys) {
    const label = node('label', labels[key]); let input;
    if (typeof state.config[key] === 'boolean') { label.className = 'toggle-field'; input = node('input'); input.type = 'checkbox'; input.checked = state.config[key]; }
    else if (['character', 'voiceInstruction'].includes(key)) { input = node('textarea'); input.rows = key === 'character' ? 9 : 3; input.maxLength = key === 'character' ? 12000 : 500; label.className = 'wide'; input.value = state.config[key]; }
    else if (key === 'voiceProvider') { input = node('select'); for (const [value, title] of [['bailian', '阿里云百炼'], ['system', '本机普通话（macOS）'], ['http', '通用云端语音接口'], ['disabled', '暂不使用语音']]) { const option = node('option', title); option.value = value; input.append(option); } input.value = state.config[key]; }
    else { input = node('input'); input.type = typeof state.config[key] === 'number' ? 'number' : 'text'; input.step = 'any'; input.value = state.config[key]; }
    input.name = key; label.append(input); grid.append(label);
  }
  const actions = node('div', undefined, 'actions'), save = node('button', '保存设置', 'primary'); save.type = 'submit'; actions.append(save); form.append(grid, actions);
  form.onsubmit = async event => { event.preventDefault(); save.disabled = true; try { const patch = {}; for (const key of keys) { const field = form.elements.namedItem(key); patch[key] = typeof state.config[key] === 'boolean' ? field.checked : typeof state.config[key] === 'number' ? Number(field.value) : field.value; } await api('/config', 'PUT', patch); toast('设置已保存'); await refresh(); } catch (e) { toast(e.message); } finally { save.disabled = false; } };
  section.append(form); return section;
}
function overview(container) {
  const hero = node('div', undefined, 'hero'), copy = node('div'); copy.append(node('span', 'A LITTLE COMPANY, EVERY DAY', 'eyebrow'), node('h2', '让陪伴自然发生。'), node('p', '在这里查看对话、整理记忆，或调整大肥鱼的表达方式。每个用户拥有独立的相处记录。')); hero.append(copy, node('div', '◕ ᴗ ◕', 'hero-symbol')); container.append(hero);
  if (state.usage.level !== 'normal') container.append(node('div', `本月预算状态：${{ warning: '已达预警线', reduced: '已暂停主动聊天与自动语音', stopped: '已暂停新付费请求' }[state.usage.level]}。后台与已有文字提醒仍可使用。`, 'notice'));
  const kpis = node('div', undefined, 'kpis');
  for (const [label, value, note] of [['正在相伴', `${state.users.filter(u => u.enabled).length} 位`, '受邀成员'], ['本月调用估算', `¥ ${state.usage.spent.toFixed(3)}`, `可变额度 ¥ ${state.usage.limit.toFixed(2)}`], ['等待中的提醒', state.reminders.filter(r => r.status === 'pending').length, '与主动闲聊分别管理'], ['聊天保留', `${state.config.retentionDays} 天`, '长期记忆持续保留，可随时删除']]) { const k = node('div', undefined, 'card'); k.append(node('div', label, 'kpi-label'), node('div', String(value), 'kpi-value'), node('div', note, 'kpi-note')); kpis.append(k); } container.append(kpis);
  const grid = node('div', undefined, 'grid-two'), budget = card('留一点余量', '费用是按配置单价估算的，最终以供应商账单为准。');
  const progress = node('div', undefined, 'progress'), bar = node('div'); bar.style.width = `${Math.min(100, state.usage.percent)}%`; progress.append(bar); budget.append(progress, node('p', `总预算 ¥${state.config.totalBudget} · 固定开支预留 ¥${state.config.fixedReserve} · 费用余量 ¥${state.config.safetyReserve}`, 'muted small'), node('p', `其中语音 ${money(state.usage.voice?.amount)} · ${count(state.usage.voice?.calls)} 次调用`, 'muted small'), button('查看用量统计 ↗', () => { location.hash = 'usage'; }), button('查看账户余额', () => { location.hash = 'accounts'; }));
  const activity = card('运行近况', '仅记录连接和运行状态，不在这里展示聊天正文。'); if (!state.runtime.events.length) activity.append(node('p', '还没有运行事件。', 'empty')); for (const event of state.runtime.events.slice(0, 5)) { const row = node('div', undefined, 'event'); row.append(node('time', time(event.at)), node('span', event.message)); activity.append(row); } grid.append(budget, activity); container.append(grid);
}
async function chats(container) {
  if (!state.users.length) { container.append(node('p', '还没有成员。在「成员管理」创建邀请码，让朋友从 QQ 加入。', 'empty')); return; }
  const toolbar = node('div', undefined, 'conversation-toolbar'), select = node('select'); select.setAttribute('aria-label', '选择用户');
  for (const user of state.users) { const option = node('option', user.name); option.value = user.id; select.append(option); } select.value = selectedUser; select.onchange = () => { selectedUser = select.value; older = 0; render(); };
  toolbar.append(select, button('个人偏好', () => preferenceDialog(selectedUser)), node('span', '仅管理员可查看所有成员的保留正文', 'muted small')); container.append(toolbar);
  const [messages, memories] = await Promise.all([api(`/users/${selectedUser}/messages?offset=${older}`), api(`/users/${selectedUser}/memories`)]);
  if (page !== 'chats' || !container.isConnected) return;
  const grid = node('div', undefined, 'chat-grid'), history = card('聊天记录', '保存真实收发正文，仅支持查看与删除。'), list = node('div', undefined, 'chat-list');
  if (!messages.length) list.append(node('p', '还没有聊天记录。试着在 QQ 里打声招呼吧。', 'empty'));
  for (const message of messages) { const row = node('div', undefined, `bubble-row ${message.role}`), meta = node('div', undefined, 'bubble-meta'); meta.append(node('span', `${message.role === 'user' ? '用户' : '大肥鱼'} · ${time(message.at)}${message.kind === 'voice' ? ' · 语音' : ''}`), button('删除', () => openDialog({ title: '删除这条记录？', description: '会同步清理以它为来源的记忆与后续关联内容，避免重新提取。', confirm: '删除', onSave: () => api(`/users/${selectedUser}/messages/${message.id}`, 'DELETE', {}) }), 'text-button')); row.append(node('div', message.content, 'bubble'), meta); list.append(row); }
  history.append(list); const paging = node('div', undefined, 'actions'); if (older) paging.append(button('较新的记录', () => { older = Math.max(0, older - 100); render(); })); if (messages.length === 100) paging.append(button('更早的记录', () => { older += 100; render(); })); history.append(paging);
  const memoryCard = card('长期记忆', '更正或遗忘时，同步清理关联旧记录。'); memoryCard.append(button('＋ 添加记忆', () => openDialog({ title: '添加长期记忆', value: '', onSave: text => api(`/users/${selectedUser}/memories`, 'POST', { text }) })));
  if (!memories.length) memoryCard.append(node('p', '记忆从每一次认真倾听开始。', 'empty'));
  for (const memory of memories) { const item = node('div', undefined, 'memory'), actions = node('div', undefined, 'memory-actions'); actions.append(button('更正', () => openDialog({ title: '更正长期记忆', description: '关联旧记录会同步清理，避免旧事实再次出现。', value: memory.text, onSave: text => api(`/users/${selectedUser}/memories/${memory.id}`, 'PUT', { text }) }), 'text-button'), button('忘记', () => openDialog({ title: '忘记这条信息？', description: '这会删除记忆及关联旧记录。', confirm: '忘记', onSave: () => api(`/users/${selectedUser}/memories/${memory.id}`, 'DELETE', {}) }), 'text-button')); item.append(node('div', `${({ fact: '资料', experience: '共同经历', habit: '相处习惯' })[memory.kind] ?? '资料'} · ${time(memory.at)}`, 'muted small'), node('p', memory.text), actions); memoryCard.append(item); }
  grid.append(history, memoryCard); container.append(grid); list.scrollTop = list.scrollHeight;
}
function preferenceDialog(id) {
  const user = state.users.find(u => u.id === id);
  const keys = ['proactiveEnabled', 'proactiveDaily', 'startHour', 'endHour', 'intervalHours', 'busyHours', 'unansweredLimit', 'unansweredPauseHours', 'autoVoice', 'voiceWithText'];
  $('#dialog-title').textContent = `${user.name}的个人偏好`; $('#dialog-description').textContent = '空白或选择「继承默认」会使用全局设置。全局停用与预算限制始终生效。'; $('#dialog-value').classList.add('hidden');
  const grid = node('div', undefined, 'form-grid'); grid.id = 'personal-fields';
  for (const key of keys) { const label = node('label', labels[key]); let field; if (typeof state.config[key] === 'boolean') { field = node('select'); for (const [value, text] of [['', '继承默认'], ['true', '开'], ['false', '关']]) { const option = node('option', text); option.value = value; field.append(option); } } else { field = node('input'); field.type = 'number'; field.step = 'any'; field.placeholder = `默认 ${state.config[key]}`; } field.name = key; field.value = user.prefs[key] === undefined ? '' : String(user.prefs[key]); label.append(field); grid.append(label); }
  $('#dialog-form').insertBefore(grid, $('#dialog-form .actions')); $('#dialog-submit').textContent = '保存'; $('#dialog-submit').className = 'primary';
  const cleanup = () => grid.remove(); $('#dialog').addEventListener('close', cleanup, { once: true }); $('#dialog-cancel').onclick = () => $('#dialog').close();
  $('#dialog-form').onsubmit = async event => { event.preventDefault(); event.submitter.disabled = true; try { const prefs = {}; for (const key of keys) { const value = grid.querySelector(`[name="${key}"]`).value; if (value !== '') prefs[key] = typeof state.config[key] === 'boolean' ? value === 'true' : Number(value); } await api(`/users/${id}`, 'PUT', { prefs }); $('#dialog').close(); toast('个人偏好已保存'); await refresh(); } catch (e) { toast(e.message); } finally { event.submitter.disabled = false; } };
  $('#dialog').showModal();
}
function members(container) {
  const memberCard = card('一起养鱼的朋友', '邀请制。新成员在 QQ 单聊中发送邀请码即可加入。');
  memberCard.append(button('＋ 创建邀请码', async () => { const value = await api('/invites', 'POST', {}); const old = memberCard.querySelector('.invite-result'); old?.remove(); memberCard.append(node('div', `/加入 ${value.code}  （24 小时内有效，仅用一次）`, 'invite-result')); }));
  for (const user of state.users) {
    const row = node('div', undefined, 'user-row'), name = node('div', user.name, 'user-name'), actions = node('div', undefined, 'member-actions');
    name.append(node('small', user.enabled ? '已启用 · 独立记忆' : '已停用'));
    actions.append(button('偏好', () => preferenceDialog(user.id)), button('改名', () => openDialog({ title: '修改成员名称', value: user.name, onSave: name => api(`/users/${user.id}`, 'PUT', { name }) })), button(user.enabled ? '停用' : '启用', async () => { await api(`/users/${user.id}`, 'PUT', { enabled: !user.enabled }); await refresh(); }, 'text-button'), button('删除', () => openDialog({
      title: `删除成员「${user.name}」？`,
      description: '将永久删除这位成员及其全部聊天、记忆、个人偏好和提醒，无法在后台撤销。已发送到 QQ 的消息不会撤回，历史费用仍保留。再次加入需要新的有效邀请码。',
      confirm: '永久删除', success: '成员及关联数据已删除', danger: true,
      onSave: async () => { await api(`/users/${user.id}`, 'DELETE', {}); state.users = state.users.filter(member => member.id !== user.id); state.reminders = state.reminders.filter(reminder => reminder.user_id !== user.id); if (selectedUser === user.id) { selectedUser = state.users[0]?.id; older = 0; } await render(); },
    }), 'danger'));
    row.append(node('div', user.name.slice(0, 1), 'avatar'), name, actions); memberCard.append(row);
  }
  if (!state.users.length) memberCard.append(node('p', '还没有成员，可以先创建邀请码。', 'empty'));
  container.append(memberCard);
}
function reminders(container) {
  const list = node('div'); let requestVersion = 0;
  const cancel = async reminder => {
    const version = ++requestVersion;
    const result = await api(`/users/${reminder.user_id}/reminders/${reminder.id}`, 'DELETE', {});
    if (result.cancelled) {
      state.reminders = state.reminders.map(row => row.id === reminder.id ? { ...row, status: 'cancelled' } : row);
      if (list.isConnected) renderReminderList(list, cancel);
    }
    try {
      const updated = await api('/state');
      if (version !== requestVersion || !list.isConnected) return;
      state.reminders = updated.reminders; renderReminderList(list, cancel);
    } catch (error) { throw new Error(`${result.cancelled ? '提醒已取消，但列表刷新未完成' : '列表刷新未完成'}：${error.message}`); }
  };
  container.append(list, settingsForm('迟到补发', '超过补发窗口的约定标为已错过，不再自动发送。约定不计入主动聊天次数。', ['reminderGraceMinutes']));
  renderReminderList(list, cancel);
}
function renderReminderList(container, cancel) {
  const reminderCard = card('一次性提醒', '超过补发窗口标记为已错过；发送结果不确定时保留核对状态，不重复发送。'), wrap = node('div', undefined, 'table-wrap'), table = node('table'), head = node('tr'); for (const title of ['成员', '时间', '内容', '状态', '']) head.append(node('th', title)); table.append(head);
  const names = { pending: '等待', sent: '已发送', missed: '已错过', cancelled: '已取消', uncertain: '待核对', sending: '发送中' };
  for (const reminder of state.reminders) { const row = node('tr'); for (const text of [state.users.find(u => u.id === reminder.user_id)?.name ?? '', time(reminder.due), reminder.text, `${names[reminder.status] ?? reminder.status}${reminder.note ? ` · ${reminder.note}` : ''}`]) row.append(node('td', text)); const action = node('td'); if (reminder.status === 'pending') action.append(button('取消', () => cancel(reminder), 'text-button')); row.append(action); table.append(row); } wrap.append(table); reminderCard.append(wrap); if (!state.reminders.length) reminderCard.append(node('p', '在 QQ 中说「五分钟后叫我喝水」，开始第一条约定。', 'empty')); container.replaceChildren(reminderCard);
}
const money = value => value != null && Number.isFinite(Number(value)) ? `¥ ${Number(value).toFixed(4)}` : '未知';
const count = value => value != null && Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-CN') : '未知';
const usageKind = kind => ({ conversation: '对话', proactive: '主动聊天', voice: '语音合成', 'voice-design': '音色设计' })[kind] ?? kind;
const usageStatus = status => ({ reserved: '处理中 · 已预留', settled: '已结算到项目账本', estimated: '估算 · 待核对', rejected: '明确拒绝 · 未计费' })[status] ?? status;
function metricCards(entries) {
  const metrics = node('div', undefined, 'kpis usage-metrics');
  for (const [label, value, note] of entries) { const metric = node('div', undefined, 'card'); metric.append(node('div', label, 'kpi-label'), node('div', value, 'kpi-value'), node('div', note, 'kpi-note')); metrics.append(metric); }
  return metrics;
}
function usageTable(titles, rows) {
  const wrap = node('div', undefined, 'table-wrap'), table = node('table'), head = node('tr');
  for (const title of titles) head.append(node('th', title)); table.append(head);
  for (const cells of rows) { const row = node('tr'); for (const value of cells) row.append(value instanceof Node ? value : node('td', String(value))); table.append(row); }
  wrap.append(table); return wrap;
}
const tokenValue = (summary, field) => summary.calls === 0 ? '0' : count(summary[field]);
const tokenNote = (summary, field) => {
  if (summary.calls === 0) return '本期暂无调用';
  if (summary[field] == null) return '尚未回报，不能视为 0';
  const unknown = summary.tokenCoverage?.[field]?.unknownCalls;
  return unknown > 0 ? `已知合计 · ${count(unknown)} 次未回报` : '供应商回报的已知合计';
};
const purposeName = row => ({ conversation: '普通对话', proactive: '主动聊天', recovery: '回复恢复', agreement: '约定接话', memory: '记忆确认' })[row.purpose] ?? usageKind(row.kind);
function tokenCell(summary, field) {
  const cell = node('td', tokenValue(summary, field), 'usage-detail');
  if (summary.tokenCoverage?.[field]?.unknownCalls > 0 && summary[field] != null) cell.append(node('div', '部分未知', 'muted small'));
  return cell;
}
function renderModelUsage(container) {
  const model = state.usage.model;
  if (!model) { container.append(node('p', '尚未取得模型用量记录，请刷新后重试。', 'notice')); return; }
  container.append(metricCards([
    ['本月模型费用估算', money(model.amount), `${count(model.calls)} 次调用 · 预留 ${money(model.reservedAmount)}`],
    ['总 Token', tokenValue(model, 'totalTokens'), tokenNote(model, 'totalTokens')],
    ['输入 Token', tokenValue(model, 'promptTokens'), tokenNote(model, 'promptTokens')],
    ['输出 Token', tokenValue(model, 'completionTokens'), tokenNote(model, 'completionTokens')],
  ]));
  const details = card('计量明细', '缓存命中与未命中属于输入明细；推理 Token 属于输出明细，均不再次加进总 Token。历史缺失不会通过费用反推。');
  const detailGrid = node('div', undefined, 'token-details');
  for (const [label, field] of [['缓存命中', 'cacheHitTokens'], ['缓存未命中', 'cacheMissTokens'], ['推理 Token', 'reasoningTokens']]) { const item = node('div'); item.append(node('div', label, 'kpi-label'), node('strong', tokenValue(model, field), 'token-value'), node('p', tokenNote(model, field), 'muted small')); detailGrid.append(item); }
  details.append(detailGrid, node('p', `${count(model.reportedTokenCalls)} 次完整回报输入、输出与总量；${count(model.unknownTokenCalls)} 次计量缺失或不完整。处理中 ${count(model.pendingCalls)} 次，明确拒绝 ${count(model.rejectedCalls)} 次，结果不明 ${count(model.uncertainCalls)} 次。`, 'muted small'));
  container.append(details);
  const grid = node('div', undefined, 'grid-two usage-tables'), daily = card('近 14 天', '按北京时间统计，可跨月份；未完整回报的用量单独标记。'), models = card('本月按模型', '金额为项目账本估算，不含供应商赠金、折扣或账户其他调用。');
  daily.append(usageTable(['日期', '调用', '总 Token', '费用估算'], (model.daily ?? []).map(row => [row.day, count(row.calls), tokenCell(row, 'totalTokens'), money(row.amount)])));
  models.append(usageTable(['模型', '调用', '总 Token', '费用估算'], (model.byModel ?? []).map(row => [row.model || '历史模型未知', count(row.calls), tokenCell(row, 'totalTokens'), money(row.amount)])));
  if (!model.byModel?.length) models.append(node('p', '本月还没有模型调用。', 'empty'));
  grid.append(daily, models); container.append(grid);
  const recent = card('最近 20 次模型调用', '可跨月份查看。缺失字段显示未知；恢复回复、约定接话与记忆确认分别记录，不把一次聊天当作一次调用。');
  const rows = (model.recent ?? []).map(row => {
    const service = node('td', purposeName(row)); service.append(node('div', row.model || '历史模型未知', 'muted small'));
    const cache = node('td', `${count(row.cacheHitTokens)} / ${count(row.cacheMissTokens)}`, 'usage-detail');
    const status = node('td', usageStatus(row.status));
    const outcome = ({ failed: '回复处理失败', uncertain: '调用结果不明', unknown: '历史结果未知' })[row.outcome]; if (outcome) status.append(node('div', outcome, 'muted small'));
    const output = node('td', count(row.completionTokens), 'usage-detail'); if (row.reasoningTokens != null) output.append(node('div', `其中推理 ${count(row.reasoningTokens)}`, 'muted small'));
    return [time(row.at), service, count(row.promptTokens), output, count(row.totalTokens), cache, money(row.amount), status];
  });
  recent.append(usageTable(['时间', '用途 / 模型', '输入', '输出', '总 Token', '缓存命中 / 未命中', '费用估算', '状态'], rows));
  if (!rows.length) recent.append(node('p', '还没有模型调用记录。', 'empty'));
  container.append(recent);
}
function renderVoiceUsage(container) {
  const voice = state.usage.voice ?? {};
  container.append(metricCards([
    ['本月语音费用估算', money(voice.amount), `含预留 ${money(voice.reservedAmount)}、估算 ${money(voice.estimatedAmount)}`],
    ['本月语音服务调用', `${count(voice.calls)} 次`, `含试听和音色设计 · ${count(voice.rejectedCalls)} 次明确拒绝`],
    ['已回报计费字符', count(voice.reportedCharacters), '来自供应商响应；不是模型 Token 或语音秒数'],
    ['未回报字符的估算', count(voice.estimatedCharacters), `${count(voice.unknownCharacterCalls)} 次无字符记录，未计入字符合计`],
  ]));
  const recent = card('最近 20 次语音服务调用', '包含跨月份记录。仅记录用量，不在这里保存台词或音频；历史未采集的字符数显示为未知。');
  const rows = (voice.recent ?? []).map(row => {
    const service = node('td', `${({ bailian: '百炼', http: '通用接口', system: '本机' })[row.provider] ?? '历史记录'} · ${usageKind(row.kind)}`);
    if (row.model) service.append(node('div', row.model, 'muted small'));
    const characters = row.status === 'rejected' ? '未计费' : row.characterBasis === 'not_applicable' ? '不适用（本机）' : row.reportedCharacters != null ? `${count(row.reportedCharacters)} · 已回报` : row.estimatedCharacters != null ? `${count(row.estimatedCharacters)} · 预估` : '未知';
    const status = node('td', usageStatus(row.status));
    if (row.outcome === 'audio_failed') status.append(node('div', '生成已完成，音频获取或校验失败', 'muted small'));
    if (row.outcome === 'failed') status.append(node('div', '生成失败', 'muted small'));
    return [time(row.at), service, money(row.amount), characters, status];
  });
  recent.append(usageTable(['时间', '服务', '费用估算', '计费字符', '状态'], rows));
  if (!rows.length) recent.append(node('p', '还没有语音调用记录。', 'empty'));
  container.append(recent);
}
function renderUsageData(container) {
  const usage = state.usage;
  container.replaceChildren();
  const summary = card(`${usage.month} · 本项目账本`, '按北京时间月份统计。以下费用按配置单价估算；真实账户余额在「账户余额」中分别查询。');
  const totals = node('div', undefined, 'budget-summary');
  for (const [label, value] of [['全部调用估算', usage.spent], ['可变预算', usage.limit], ['预算剩余', Math.max(0, usage.limit - usage.spent)]]) { const item = node('div'); item.append(node('span', label, 'kpi-label'), node('strong', money(value))); totals.append(item); }
  summary.append(totals);
  const breakdown = node('details', undefined, 'usage-breakdown'); breakdown.append(node('summary', '查看费用分类'));
  breakdown.append(usageTable(['类型', '调用次数', '费用估算', '其中预留', '待核对估算'], (usage.breakdown ?? []).map(row => [usageKind(row.kind), count(row.calls), money(row.amount), money(row.reservedAmount), money(row.estimatedAmount)])));
  summary.append(breakdown); container.append(summary);
  const tabs = node('div', undefined, 'usage-tabs'); tabs.setAttribute('aria-label', '用量类型');
  for (const [id, label] of [['model', '模型 Token'], ['voice', '语音字符']]) { const tab = button(label, () => { usageView = id; renderUsageData(container); }, usageView === id ? 'primary' : 'secondary'); tab.setAttribute('aria-pressed', String(usageView === id)); tabs.append(tab); }
  tabs.append(node('span', '每 30 秒更新 · 页面隐藏时暂停', 'muted small')); container.append(tabs);
  if (usageView === 'model') renderModelUsage(container); else renderVoiceUsage(container);
}
function usagePage(container) {
  const data = node('div'); data.id = 'usage-data'; container.append(data); renderUsageData(data);
}
function renderDeepseekBalance(container, snapshot) {
  container.replaceChildren();
  if (snapshot.status === 'ready' || snapshot.stale) {
    const balances = node('div', undefined, 'account-balances');
    for (const row of snapshot.balances ?? []) {
      const item = node('div', undefined, 'account-balance');
      item.append(node('div', '总可用余额', 'kpi-label'), node('div', `${row.currency ?? '币种未知'} ${row.total ?? '未知'}`, 'kpi-value'), node('p', `赠送余额 ${row.granted ?? '未知'} · 充值余额 ${row.toppedUp ?? '未知'}`, 'muted small'));
      balances.append(item);
    }
    if (!snapshot.balances?.length) balances.append(node('p', '没有取得余额明细，不能视为 0。', 'notice'));
    container.append(balances);
    if (typeof snapshot.isAvailable === 'boolean') container.append(node('p', snapshot.isAvailable ? '供应商返回：账户余额可用' : '供应商返回：账户余额不可用', snapshot.isAvailable ? 'muted small' : 'notice'));
  }
  if (snapshot.status !== 'ready') container.append(node('p', snapshot.message || '尚未取得 DeepSeek 余额。', 'notice'));
  if (snapshot.stale) container.append(node('p', '查询失败，以上为上次成功结果，请勿视为实时余额。', 'notice'));
  if (snapshot.updatedAt) container.append(node('p', `数据时间：${time(snapshot.updatedAt)}`, 'muted small'));
}
async function accountsPage(container) {
  container.append(node('p', '账户信息包含供应商账户的其他使用；项目 Token 与费用估算请到「用量统计」查看。查询失败不会影响聊天。', 'page-intro'));
  const deepseek = card('DeepSeek 账户余额', '使用「模型与预算」中已保存的 DeepSeek API Key，只查询官方账户余额。'), deepseekResult = node('div', '正在查询 DeepSeek 账户…', 'account-state'), deepseekActions = node('div', undefined, 'usage-actions');
  let deepseekRefresh, deepseekVersion = 0;
  const reloadDeepseek = async force => {
    const version = ++deepseekVersion;
    deepseekRefresh.disabled = true;
    try { const snapshot = await api(force ? '/deepseek-balance/refresh' : '/deepseek-balance', force ? 'POST' : 'GET', force ? {} : undefined); if (version === deepseekVersion && deepseek.isConnected) renderDeepseekBalance(deepseekResult, snapshot); }
    catch (error) { if (version === deepseekVersion && deepseek.isConnected) deepseekResult.replaceChildren(node('p', `DeepSeek 余额暂时不可用：${error.message}`, 'notice')); }
    finally { if (version === deepseekVersion) deepseekRefresh.disabled = false; }
  };
  deepseekRefresh = button('刷新 DeepSeek 余额', () => reloadDeepseek(true));
  deepseekActions.append(deepseekRefresh, button('管理模型密钥', () => { location.hash = 'models'; }, 'text-button'));
  deepseek.append(deepseekResult, deepseekActions); container.append(deepseek);
  const account = card('阿里云账户与百炼额度', '现金余额、资源包与模型免费额度分别展示，使用独立的只读查询凭据。');
  const result = node('div', '正在查询阿里云账户…', 'account-state'), actions = node('div', undefined, 'usage-actions');
  let refreshButton, billingVersion = 0;
  const reload = async force => {
    const version = ++billingVersion;
    refreshButton.disabled = true;
    try { const snapshot = await api(force ? '/billing/refresh' : '/billing', force ? 'POST' : 'GET', force ? {} : undefined); if (version === billingVersion && account.isConnected) renderBilling(result, snapshot); }
    catch (error) { if (version === billingVersion && account.isConnected) result.replaceChildren(node('p', `阿里云账户查询暂时不可用：${error.message}`, 'notice')); }
    finally { if (version === billingVersion) refreshButton.disabled = false; }
  };
  refreshButton = button('刷新阿里云额度', () => reload(true)); actions.append(refreshButton);
  account.append(result, actions, billingCredentials(reload)); container.append(account);
  await Promise.all([reloadDeepseek(false), reload(false)]);
}

function externalLink(text, url) { const link = node('a', text); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link; }
function renderBilling(container, snapshot) {
  container.replaceChildren();
  const balance = snapshot.balance, packages = snapshot.resourcePackages, free = snapshot.freeQuota;
  const balanceCard = card('云账户余额', '账户级金额，可用于多种阿里云服务，不是这一个语音模型的专用额度。');
  if (balance.status === 'ready' || balance.stale) {
    balanceCard.append(node('div', `${balance.currency ?? '币种未知'} ${balance.cashAmount ?? '未知'}`, 'kpi-value'), node('p', '可用现金余额', 'kpi-note'));
    if (balance.availableAmount != null) balanceCard.append(node('p', `总可用额度 ${balance.currency ?? ''} ${balance.availableAmount}（可能包含授信等非现金项）`, 'muted small'));
  }
  if (balance.status !== 'ready') balanceCard.append(node('p', balance.message || '未取得余额，不能视为 0。', 'notice'));
  if (balance.stale) balanceCard.append(node('p', '查询失败，以上为上次成功结果，请勿视为当前实时余额。', 'notice'));
  if (balance.updatedAt) balanceCard.append(node('p', `数据时间：${time(balance.updatedAt)}`, 'muted small'));
  const freeCard = card('百炼模型免费额度', '免费额度按模型和有效期区分，与现金余额、已购买资源包分别管理。');
  freeCard.append(node('p', free.message, 'muted'), externalLink('打开百炼控制台核对 ↗', free.consoleUrl));
  const columns = node('div', undefined, 'grid-two'); columns.append(balanceCard, freeCard); container.append(columns);
  const packCard = card('已购买资源包', '以下来自整个阿里云账户，可能属于其他服务。请核对适用产品、地域、单位和到期时间；不同包的余量不能直接相加。');
  if (packages.status !== 'ready') packCard.append(node('p', packages.message || '暂未取得资源包信息。', 'notice'));
  if (packages.stale) packCard.append(node('p', '以下为缓存结果，当前查询未成功。', 'notice'));
  if (packages.items?.length) {
    const wrap = node('div', undefined, 'table-wrap'), table = node('table'), head = node('tr');
    for (const title of ['商品 / 适用产品', '剩余额度', '总量', '到期 / 状态']) head.append(node('th', title)); table.append(head);
    for (const item of packages.items) {
      const tr = node('tr'), product = node('td', item.commodityCode ?? '未返回商品代码');
      if (item.applicableProducts?.length) product.append(node('div', item.applicableProducts.join('、'), 'muted small'));
      if (item.region) product.append(node('div', item.region, 'muted small'));
      tr.append(product, node('td', `${item.remaining ?? '未知'} ${item.remainingUnit ?? ''}`, 'usage-detail'), node('td', `${item.total ?? '未知'} ${item.totalUnit ?? ''}`, 'usage-detail'), node('td', `${item.expiresAt ? time(item.expiresAt) : '到期时间未知'} · ${{ Available: '有效', Expired: '已过期' }[item.status] ?? '状态未知'}`)); table.append(tr);
    }
    wrap.append(table); packCard.append(wrap);
  } else if (packages.status === 'ready') packCard.append(node('p', '本次查询没有返回资源包；不代表模型免费额度为零。', 'muted'));
  if (packages.truncated) packCard.append(node('p', '资源包较多，此处只显示部分结果，请在费用中心查看全部。', 'notice'));
  if (packages.updatedAt) packCard.append(node('p', `数据时间：${time(packages.updatedAt)}`, 'muted small'));
  packCard.append(externalLink('打开费用中心 ↗', 'https://usercenter2.aliyun.com/')); container.append(packCard);
}
function billingCredentials(reload) {
  const details = node('details'), summary = node('summary', '配置只读账户查询'); details.append(summary);
  details.append(node('p', '需要专用 RAM 用户的只读余额与资源包权限，百炼 API Key 不能用于此查询。密钥只保存到运行服务器，不会回显。', 'muted small'));
  const form = node('form'), grid = node('div', undefined, 'form-grid');
  for (const [key, label] of [['billingAccessKeyId', 'RAM AccessKey ID'], ['billingAccessKeySecret', 'RAM AccessKey Secret'], ['billingSecurityToken', 'SecurityToken（仅临时凭据需要）']]) {
    const field = node('label', label), input = node('input'); input.name = key; input.type = 'password'; input.autocomplete = 'new-password'; input.maxLength = 2048;
    input.required = key !== 'billingSecurityToken'; input.placeholder = key === 'billingSecurityToken' ? '普通 RAM 密钥留空' : state.secrets.billingConfigured ? '已配置 · 替换时填写完整密钥对' : '尚未配置'; field.append(input); grid.append(field);
  }
  const actions = node('div', undefined, 'actions'), save = node('button', '保存并查询', 'primary'); save.type = 'submit';
  actions.append(button('清除查询凭据', () => openDialog({ title: '关闭账户查询？', description: '将移除余额查询使用的专用凭据。聊天、语音和项目用量记录继续可用。', confirm: '清除', success: '账户查询凭据已清除', onSave: () => api('/secrets', 'PUT', { billingAccessKeyId: '', billingAccessKeySecret: '', billingSecurityToken: '' }) })), save);
  form.append(grid, actions); form.onsubmit = async event => {
    event.preventDefault(); save.disabled = true;
    try { const patch = {}; for (const key of ['billingAccessKeyId', 'billingAccessKeySecret', 'billingSecurityToken']) patch[key] = form.elements[key].value.trim(); state.secrets = await api('/secrets', 'PUT', patch); form.reset(); toast('查询凭据已保存'); await reload(true); }
    catch (error) { toast(error.message); } finally { save.disabled = false; }
  };
  details.append(form); return details;
}
function credentials() {
  const section = card('凭据', '密钥与密码保存在机器人运行环境中，不会在页面回显。留空表示不修改。'); const form = node('form'), grid = node('div', undefined, 'form-grid');
  for (const [key, title, configured] of [['deepseekKey', 'DeepSeek API Key', state.secrets.deepseekConfigured], ['bailianKey', '百炼北京地域 API Key', state.secrets.bailianConfigured], ['ttsKey', '通用语音接口 API Key', state.secrets.ttsConfigured], ['adminPassword', '新的管理员密码（至少 12 位）', true]]) { const label = node('label', title), input = node('input'); input.type = 'password'; input.name = key; input.autocomplete = 'new-password'; input.placeholder = configured ? '已配置 · 留空保留' : '尚未配置'; label.append(input); grid.append(label); }
  const actions = node('div', undefined, 'actions'), save = node('button', '保存凭据', 'primary'); actions.append(save); form.append(grid, actions); form.onsubmit = async event => { event.preventDefault(); save.disabled = true; try { const patch = {}; for (const key of ['deepseekKey', 'bailianKey', 'ttsKey', 'adminPassword']) if (form.elements[key].value) patch[key] = form.elements[key].value; await api('/secrets', 'PUT', patch); form.reset(); toast('凭据已保存'); if (patch.adminPassword) showLogin(); else await refresh(); } catch (e) { toast(e.message); } finally { save.disabled = false; } }; section.append(form); return section;
}
function voiceStudio() {
  const section = card('试听与设计专属声音', '使用百炼 Qwen-Audio-3.1-TTS-Plus。先保存上方设置；试听计入月度语音预算，仅在后台播放。');
  const form = node('form'), grid = node('div', undefined, 'form-grid');
  const field = (title, value, maxLength, rows = 2) => { const label = node('label', title, 'wide'), input = node('textarea'); input.value = value; input.maxLength = maxLength; input.rows = rows; label.append(input); grid.append(label); return input; };
  const text = field('试听的话（最多 100 字）', '你回来啦，我刚刚还在想你呢。先坐一会儿，跟我讲讲今天怎么样？', 100);
  const instruction = field('这句的语气（可选）', '见到熟悉的朋友时，轻快又带一点小开心，像平时聊天。', 160);
  const prompt = field('想设计怎样的声音', '年轻成年女性的声音，清澈柔和，带一点俏皮，亲近自然。普通话，适合朋友之间轻松聊天，不用播音腔。', 500, 3);
  const result = node('div', undefined, 'voice-result'), actions = node('div', undefined, 'actions'); let audioUrl;
  const play = data => {
    if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrls.delete(audioUrl); }
    const bytes = Uint8Array.from(atob(data.audio), c => c.charCodeAt(0)); audioUrl = URL.createObjectURL(new Blob([bytes], { type: data.mime })); audioUrls.add(audioUrl);
    const audio = node('audio'); audio.controls = true; audio.src = audioUrl; result.replaceChildren(audio);
    if (data.voiceId) { result.append(node('p', `新音色：${data.voiceId}`, 'muted small'), button('使用这个音色', async () => { await api('/config', 'PUT', { bailianVoice: data.voiceId }); toast('已保存新音色'); await refresh(); }, 'primary')); }
  };
  const run = async design => {
    preview.disabled = create.disabled = true; result.replaceChildren(node('p', design ? '正在设计声音，请稍候…' : '正在合成试听，请稍候…', 'muted'));
    try { const data = await api(design ? '/voice/design' : '/voice/preview', 'POST', { text: text.value, ...(design ? { prompt: prompt.value } : { instruction: instruction.value }) }); if (section.isConnected) play(data); }
    catch (error) { if (section.isConnected) result.replaceChildren(node('p', error.message, 'notice')); }
    finally { preview.disabled = create.disabled = false; }
  };
  const preview = button('试听当前音色', () => run(false), 'primary'), create = button('生成新音色并试听', () => run(true));
  actions.append(preview, create); form.onsubmit = event => event.preventDefault(); form.append(grid, actions); section.append(form, result, node('p', '设计描述决定声音特征；语气指导调整每次表达。生成后需点击「使用这个音色」才会替换，支持填入该模型对应的自定义音色 ID。', 'muted small')); return section;
}
async function render() {
  if (!state) return;
  const current = pages.find(p => p[0] === page);
  $('#page-title').textContent = current?.[2] ?? ''; $('#page-description').textContent = current?.[3] ?? '';
  $('#page-group').textContent = pageGroups.find(([, entries]) => entries.some(p => p[0] === page))?.[0] ?? '';
  for (const b of $('#nav').querySelectorAll('[data-page]')) { b.classList.toggle('active', b.dataset.page === page); if (b.dataset.page === page) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
  for (const url of audioUrls) URL.revokeObjectURL(url); audioUrls.clear();
  const container = node('div'); $('#content').replaceChildren(container);
  if (page === 'overview') overview(container);
  if (page === 'chats') await chats(container);
  if (page === 'character') container.append(settingsForm('人设与说话方式', '共享基础角色，各自积累相处习惯。自动记忆保留原话依据，可在聊天与记忆中更正或遗忘。', ['enabled', 'character', 'autoMemory', 'maxBubbles', 'replyGapMs', 'contextMessages', 'retentionDays']));
  if (page === 'proactive') container.append(settingsForm('主动聊天', '次数是上限。没有合适内容可以不发，也不计未回复；关闭轻松开新话题后只回访有依据的旧话题。用户回来聊天会提前结束忙碌暂停。', ['proactiveEnabled', 'proactiveAllowCasual', 'proactiveDaily', 'startHour', 'endHour', 'intervalHours', 'proactiveRetryHours', 'busyHours', 'unansweredLimit', 'unansweredPauseHours']));
  if (page === 'voice') {
    container.append(settingsForm('语音回复习惯', '语音合成失败时自动使用对应文字回复。修改语音方式后保存，可查看相应设置。', ['autoVoice', 'autoVoiceChance', 'voiceWithText', 'voiceProvider']));
    if (state.config.voiceProvider === 'bailian') container.append(settingsForm('百炼声音设置', '选择声音、调整日常语气。开启自动情绪后，会根据当前角色和聊天内容轻微调整表达。API Key 在「模型与预算」中管理。', ['bailianWorkspace', 'bailianVoice', 'voiceInstruction', 'voiceEmotionEnabled', 'voiceSpeed', 'voicePitch', 'voiceVolume']), voiceStudio());
    if (state.config.voiceProvider === 'system') container.append(settingsForm('本机声音设置', '只适用于 macOS。', ['voiceName', 'voiceRate']));
    if (state.config.voiceProvider === 'http') container.append(settingsForm('通用接口设置', '接口需接受兼容的合成请求并返回 WAV 音频。', ['voiceName', 'voiceModel', 'voiceEndpoint']));
  }
  if (page === 'members') members(container);
  if (page === 'reminders') reminders(container);
  if (page === 'usage') usagePage(container);
  if (page === 'accounts') accountsPage(container).catch(error => toast(error.message));
  if (page === 'models') container.append(settingsForm('模型连接', '当前首期使用 DeepSeek Flash，支持文字与普通图片。修改模型后需要重新核对能力与价格。', ['model', 'modelBaseUrl']), credentials(), settingsForm('月度预算与保护', '估算采用配置单价，不等于供应商最终账单。百炼每个汉字按 2 个计费字符计算。达到降级线暂停主动聊天和自动语音，额度耗尽停止新付费请求。', ['totalBudget', 'fixedReserve', 'safetyReserve', 'warnPercent', 'reducePercent', 'inputPrice', 'outputPrice', 'voicePricePer10k', 'bailianPricePer10k']));
}
setInterval(async () => {
  const container = $('#usage-data');
  if (page !== 'usage' || !container || document.hidden || $('#shell').classList.contains('hidden') || $('#dialog').open) return;
  try { const usage = await api('/usage'); if (container.isConnected && page === 'usage') { state.usage = usage; renderUsageData(container); } } catch (error) { toast(error.message); }
}, 30000);
try { const session = await api('/session'); if (session.authenticated) { page = pageFromHash(); await refresh(); showApp(); } else { showLogin(); if (!session.configured) { $('#login-note').textContent = '尚未设置管理员密码，请先运行本机配置向导。'; $('#login-note').classList.remove('hidden'); } } } catch (error) { showLogin(); toast(error.message); }
