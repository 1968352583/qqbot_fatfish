const $ = selector => document.querySelector(selector);
const node = (tag, text, className) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; };
const button = (text, fn, cls = 'secondary') => { const e = node('button', text, cls); e.type = 'button'; e.onclick = () => Promise.resolve(fn()).catch(error => toast(error.message)); return e; };
let state, selectedUser, page = 'overview', older = 0, toastTimer;
const audioUrls = new Set();
function toast(text) { $('#toast').textContent = text; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4500); }
async function api(path, method = 'GET', data) { const response = await fetch(`/api${path}`, { method, headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }); const value = await response.json(); if (!response.ok) { if (response.status === 401) showLogin(); throw new Error(value.error ?? '操作失败'); } return value; }
function showLogin() { $('#login').classList.remove('hidden'); $('#shell').classList.add('hidden'); }
function showApp() { $('#login').classList.add('hidden'); $('#shell').classList.remove('hidden'); }
const pages = [['overview', '◷', '总览', '今天，一切都好。'], ['chats', '☷', '聊天与记忆', '那些慢慢积累的小事'], ['character', '◇', '角色与表达', '让它保持熟悉的样子'], ['interaction', '↗', '主动与语音', '找到舒服的相处节奏'], ['members', '♧', '成员与提醒', '每一位朋友，都被记住'], ['models', '◉', '模型与预算', '把用量和花费放在心里']];
for (const [id, icon, label] of pages) { const b = button('', () => { location.hash = id; }, ''); b.append(node('span', icon), node('b', label)); b.dataset.page = id; $('#nav').append(b); }
window.addEventListener('hashchange', () => { page = pages.some(p => p[0] === location.hash.slice(1)) ? location.hash.slice(1) : 'overview'; render(); });
$('#login-form').onsubmit = async event => { event.preventDefault(); const b = event.submitter; b.disabled = true; try { await api('/login', 'POST', { password: $('#password').value }); $('#password').value = ''; page = pages.some(p => p[0] === location.hash.slice(1)) ? location.hash.slice(1) : 'overview'; await refresh(); showApp(); } catch (error) { toast(error.message); } finally { b.disabled = false; } };
$('#logout').onclick = async () => { await api('/logout', 'POST', {}); showLogin(); };
$('#refresh').onclick = () => refresh().catch(e => toast(e.message));
async function refresh() { state = await api('/state'); if (!state.users.some(u => u.id === selectedUser)) selectedUser = state.users[0]?.id; const online = ['ready', 'resumed'].includes(state.runtime.gateway); $('#connection').textContent = online ? 'QQ 已连接' : 'QQ 未连接'; $('#connection-dot').classList.toggle('online', online); await render(); }
function card(title, subtitle) { const e = node('section', undefined, 'card form-section'); e.append(node('h2', title)); if (subtitle) e.append(node('p', subtitle, 'muted')); return e; }
const time = timestamp => new Date(timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function openDialog({ title, description = '', value, confirm = '保存', onSave }) {
  $('#dialog-title').textContent = title; $('#dialog-description').textContent = description;
  $('#dialog-value').classList.toggle('hidden', value === undefined); $('#dialog-value').value = value ?? ''; $('#dialog-submit').textContent = confirm;
  $('#dialog-cancel').onclick = () => $('#dialog').close();
  $('#dialog-form').onsubmit = async event => { event.preventDefault(); event.submitter.disabled = true; try { await onSave($('#dialog-value').value); $('#dialog').close(); toast('已保存'); await refresh(); } catch (e) { toast(e.message); } finally { event.submitter.disabled = false; } };
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
  const progress = node('div', undefined, 'progress'), bar = node('div'); bar.style.width = `${Math.min(100, state.usage.percent)}%`; progress.append(bar); budget.append(progress, node('p', `总预算 ¥${state.config.totalBudget} · 固定开支预留 ¥${state.config.fixedReserve} · 费用余量 ¥${state.config.safetyReserve}`, 'muted small'), button('管理模型与预算 ↗', () => { location.hash = 'models'; }));
  const activity = card('运行近况', '仅记录连接和运行状态，不在这里展示聊天正文。'); if (!state.runtime.events.length) activity.append(node('p', '还没有运行事件。', 'empty')); for (const event of state.runtime.events.slice(0, 5)) { const row = node('div', undefined, 'event'); row.append(node('time', time(event.at)), node('span', event.message)); activity.append(row); } grid.append(budget, activity); container.append(grid);
}
async function chats(container) {
  if (!state.users.length) { container.append(node('p', '还没有成员。在「成员与提醒」创建邀请码，让朋友从 QQ 加入。', 'empty')); return; }
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
  $('#dialog-form').insertBefore(grid, $('#dialog-form .actions')); $('#dialog-submit').textContent = '保存';
  const cleanup = () => grid.remove(); $('#dialog').addEventListener('close', cleanup, { once: true }); $('#dialog-cancel').onclick = () => $('#dialog').close();
  $('#dialog-form').onsubmit = async event => { event.preventDefault(); event.submitter.disabled = true; try { const prefs = {}; for (const key of keys) { const value = grid.querySelector(`[name="${key}"]`).value; if (value !== '') prefs[key] = typeof state.config[key] === 'boolean' ? value === 'true' : Number(value); } await api(`/users/${id}`, 'PUT', { prefs }); $('#dialog').close(); toast('个人偏好已保存'); await refresh(); } catch (e) { toast(e.message); } finally { event.submitter.disabled = false; } };
  $('#dialog').showModal();
}
function members(container) {
  const memberCard = card('一起养鱼的朋友', '邀请制。新成员在 QQ 单聊中发送邀请码即可加入。');
  memberCard.append(button('＋ 创建邀请码', async () => { const value = await api('/invites', 'POST', {}); const old = memberCard.querySelector('.invite-result'); old?.remove(); memberCard.append(node('div', `/加入 ${value.code}  （24 小时内有效，仅用一次）`, 'invite-result')); }));
  for (const user of state.users) { const row = node('div', undefined, 'user-row'), name = node('div', user.name, 'user-name'); name.append(node('small', user.enabled ? '已启用 · 独立记忆' : '已停用')); row.append(node('div', user.name.slice(0, 1), 'avatar'), name, button('偏好', () => preferenceDialog(user.id)), button('改名', () => openDialog({ title: '修改成员名称', value: user.name, onSave: name => api(`/users/${user.id}`, 'PUT', { name }) })), button(user.enabled ? '停用' : '启用', async () => { await api(`/users/${user.id}`, 'PUT', { enabled: !user.enabled }); await refresh(); }, 'text-button')); memberCard.append(row); } container.append(memberCard);
  const reminderCard = card('一次性提醒', '超过补发窗口标记为已错过；发送结果不确定时保留核对状态，不重复发送。'), wrap = node('div', undefined, 'table-wrap'), table = node('table'), head = node('tr'); for (const title of ['成员', '时间', '内容', '状态', '']) head.append(node('th', title)); table.append(head);
  const names = { pending: '等待', sent: '已发送', missed: '已错过', cancelled: '已取消', uncertain: '待核对', sending: '发送中' };
  for (const reminder of state.reminders) { const row = node('tr'); for (const text of [state.users.find(u => u.id === reminder.user_id)?.name ?? '', time(reminder.due), reminder.text, `${names[reminder.status] ?? reminder.status}${reminder.note ? ` · ${reminder.note}` : ''}`]) row.append(node('td', text)); const action = node('td'); if (reminder.status === 'pending') action.append(button('取消', async () => { await api(`/users/${reminder.user_id}/reminders/${reminder.id}`, 'DELETE', {}); await refresh(); }, 'text-button')); row.append(action); table.append(row); } wrap.append(table); reminderCard.append(wrap); if (!state.reminders.length) reminderCard.append(node('p', '在 QQ 中说 /提醒 5分钟后 喝水，开始第一条提醒。', 'empty')); container.append(reminderCard);
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
  if (!state) return; $('#page-title').textContent = pages.find(p => p[0] === page)?.[3] ?? ''; for (const b of $('#nav').children) b.classList.toggle('active', b.dataset.page === page);
  for (const url of audioUrls) URL.revokeObjectURL(url); audioUrls.clear();
  const container = node('div'); $('#content').replaceChildren(container);
  if (page === 'overview') overview(container);
  if (page === 'chats') await chats(container);
  if (page === 'character') container.append(settingsForm('人设与说话方式', '共享基础角色，各自积累相处习惯。自动记忆保留原话依据，可在聊天与记忆中更正或遗忘。', ['enabled', 'character', 'autoMemory', 'maxBubbles', 'replyGapMs', 'contextMessages', 'retentionDays']));
  if (page === 'interaction') {
    container.append(settingsForm('主动聊天', '次数是上限。没有合适内容可以不发，也不计未回复；关闭轻松开新话题后只回访有依据的旧话题。用户回来聊天会提前结束忙碌暂停。', ['proactiveEnabled', 'proactiveAllowCasual', 'proactiveDaily', 'startHour', 'endHour', 'intervalHours', 'proactiveRetryHours', 'busyHours', 'unansweredLimit', 'unansweredPauseHours', 'reminderGraceMinutes']), settingsForm('语音与表达', '语音合成失败时自动使用对应文字回复。修改语音方式后保存，可查看相应设置。', ['autoVoice', 'autoVoiceChance', 'voiceWithText', 'voiceProvider']));
    if (state.config.voiceProvider === 'bailian') container.append(settingsForm('百炼声音设置', '选择声音、调整日常语气。开启自动情绪后，会根据当前角色和聊天内容轻微调整表达。API Key 在「模型与预算」中管理。', ['bailianWorkspace', 'bailianVoice', 'voiceInstruction', 'voiceEmotionEnabled', 'voiceSpeed', 'voicePitch', 'voiceVolume']), voiceStudio());
    if (state.config.voiceProvider === 'system') container.append(settingsForm('本机声音设置', '只适用于 macOS。', ['voiceName', 'voiceRate']));
    if (state.config.voiceProvider === 'http') container.append(settingsForm('通用接口设置', '接口需接受兼容的合成请求并返回 WAV 音频。', ['voiceName', 'voiceModel', 'voiceEndpoint']));
  }
  if (page === 'members') members(container);
  if (page === 'models') container.append(settingsForm('模型连接', '当前首期使用 DeepSeek Flash，支持文字与普通图片。修改模型后需要重新核对能力与价格。', ['model', 'modelBaseUrl']), credentials(), settingsForm('月度预算与保护', '估算采用配置单价，不等于供应商最终账单。百炼每个汉字按 2 个计费字符计算。达到降级线暂停主动聊天和自动语音，额度耗尽停止新付费请求。', ['totalBudget', 'fixedReserve', 'safetyReserve', 'warnPercent', 'reducePercent', 'inputPrice', 'outputPrice', 'voicePricePer10k', 'bailianPricePer10k']));
}
try { const session = await api('/session'); if (session.authenticated) { page = pages.some(p => p[0] === location.hash.slice(1)) ? location.hash.slice(1) : 'overview'; await refresh(); showApp(); } else { showLogin(); if (!session.configured) { $('#login-note').textContent = '尚未设置管理员密码，请先运行本机配置向导。'; $('#login-note').classList.remove('hidden'); } } } catch (error) { showLogin(); toast(error.message); }
