import { setTimeout as delay } from 'node:timers/promises';
import { chinaDate, chinaHour } from './config.mjs';
import { ReminderCommands, reminderDelivery } from './reminders.mjs';
import { applyMemoryUpdates } from './memory.mjs';
export { reminderInput } from './reminders.mjs';

export function proactiveAllowed(user, config, usage, now, { ignoreCheck = false } = {}) {
  if (!config.enabled || !config.proactiveEnabled || !user.enabled || config.proactiveDaily === 0) return false;
  if (['reduced', 'stopped'].includes(usage.level) || user.busy_until > now || user.pause_until > now) return false;
  const hour = chinaHour(now);
  if (hour < config.startHour || hour >= config.endHour) return false;
  if (user.proactive_day === chinaDate(now) && user.proactive_count >= config.proactiveDaily) return false;
  if (!ignoreCheck && user.last_proactive_check && now - user.last_proactive_check < (config.proactiveRetryHours ?? 1) * 3600000) return false;
  return user.last_inbound > 0 && now - Math.max(user.last_inbound, user.last_proactive) >= config.intervalHours * 3600000;
}

// Explicit, present-tense boundaries only; quoted or future plans are not a pause.
export function wantsQuiet(text) {
  return /^(?:我)?(?:先不聊(?:了)?|先(?:去)?休息|先(?:去)?睡(?:觉)?|要(?:去)?睡(?:觉)?|想(?:自己|一个人)(?:待|静|呆)一会儿)(?:[，,。！!\s]|$)/u.test(text);
}

export class Bot {
  constructor({ store, model, voice, transport, log = () => {}, sleep = delay, random = Math.random }) {
    Object.assign(this, { store, model, voice, transport, log, sleep, random });
    this.jobs = new Map(); this.cooldowns = new Map(); this.ticking = false; this.lastPrune = 0;
    this.reminderCommands = new ReminderCommands(store);
  }
  cancel(userId) { this.jobs.get(userId)?.abort(); }
  stop() { for (const job of this.jobs.values()) job.abort(); }
  async accept(packet) {
    if (packet.op !== 0 || packet.t !== 'C2C_MESSAGE_CREATE') return;
    const data = packet.d, openid = data?.author?.user_openid;
    if (typeof openid !== 'string' || typeof data.id !== 'string') return;
    const at = Date.parse(data.timestamp);
    if (!Number.isFinite(at) || this.store.now() - at > 4 * 60000 || at > this.store.now() + 60000) return;
    let user = this.store.byOpenid(openid);
    const raw = typeof data.content === 'string' ? data.content.trim().slice(0, 12000) : '';
    if (!user) {
      const invitation = raw.match(/^\/加入\s+([a-f0-9]{16})$/);
      if (!invitation) return;
      user = this.store.join(openid, invitation[1]); if (!user) return;
    }
    if (!user.enabled) return;
    const images = [], transcripts = [];
    let hasVoice = false, unsupported = false;
    for (const item of (Array.isArray(data.attachments) ? data.attachments : []).slice(0, 4)) {
      if (item.voice_wav_url || item.asr_refer_text || item.content_type?.startsWith('audio/')) {
        hasVoice = true; if (typeof item.asr_refer_text === 'string') transcripts.push(item.asr_refer_text.slice(0, 6000));
      } else if (item.content_type?.startsWith('image/')) {
        try { const url = new URL(item.url); if (url.protocol === 'https:' && !url.username && !url.password && ['qq.com', 'qpic.cn', 'gtimg.cn', 'multimedia.nt.qq.com.cn'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)) && (!item.size || item.size <= 10 * 1024 * 1024)) images.push(url.href); else unsupported = true; } catch { unsupported = true; }
      } else unsupported = true;
    }
    const content = [raw, ...transcripts.map(t => `[语音参考转写，可能不准确] ${t}`), ...(images.length ? ['[用户发送图片，本轮临时查看]'] : [])].filter(Boolean).join('\n') || '[未识别附件]';
    const kind = raw.startsWith('/') ? 'command' : hasVoice ? 'voice' : images.length ? 'image' : 'text';
    const messageId = this.store.inbound(user.id, data.id, content, kind, at); if (!messageId) return;
    this.cancel(user.id);
    const controller = new AbortController(); this.jobs.set(user.id, controller);
    const revision = this.store.user(user.id).revision;
    const input = { id: data.id, at, messageId, revision, content, raw, kind, images, signal: controller.signal };
    try {
      await this.sleep(250, undefined, { signal: controller.signal });
      let command;
      try { command = this.command(user.id, raw, messageId); }
      catch (error) { command = error.message; }
      if (command !== null) {
        input.revision = this.store.user(user.id).revision;
        if (command.type === 'agreement') await this.agreementReply(user.id, command, input);
        else await this.deliver(user.id, [command], input, { control: true });
        return;
      }
      if (!this.store.preferences(user.id).enabled) return;
      if (hasVoice && !transcripts.length) { await this.deliver(user.id, ['这段语音我暂时没听清，可以再说一次，或发文字给我吗？'], input); return; }
      if (unsupported && !raw && !images.length && !transcripts.length) { await this.deliver(user.id, ['这条附件我暂时看不明白，可以发普通图片或描述一下吗？'], input); return; }
      if (kind === 'text' && wantsQuiet(raw)) this.store.busy(user.id);
      let response = await this.model.respond(user.id, { images, signal: controller.signal });
      if (!this.current(user.id, input)) return;
      const memoryResult = applyMemoryUpdates({ store: this.store, userId: user.id, input, response });
      if (memoryResult.edited) {
        input.revision = this.store.user(user.id).revision;
        // The old response and edit request may contain forgotten facts. Generate
        // afresh from cleaned history without passing the raw edit back in.
        try { response = await this.model.respond(user.id, { signal: controller.signal, memoryOutcome: memoryResult.memoryOutcome }); }
        catch {
          response = { bubbles: [memoryResult.memoryOutcome.action === 'corrected' ? '嗯，按你刚说的来。' : '好，那就不提了。'], voice: false, quotes: [], sources: [], memoryIds: [] };
        }
      }
      if (!this.current(user.id, input)) return;
      await this.respond(user.id, response, input);
    } catch (error) {
      if (!controller.signal.aborted) {
        this.log('conversation', error.message);
        await this.deliver(user.id, [error.message.includes('预算') ? '这个月的 AI 调用额度暂时用完啦。设置、记忆管理和已经安排好的提醒仍然可用。' : '我这会儿有点卡住了，稍后再聊一句试试吧。'], input).catch(() => {});
      }
    } finally { if (this.jobs.get(user.id) === controller) this.jobs.delete(user.id); }
  }
  current(userId, input) { return !input.signal?.aborted && this.store.user(userId)?.revision === input.revision; }
  async agreementReply(userId, agreement, input) {
    let response;
    try {
      if (this.store.preferences(userId).enabled && this.store.usage().level !== 'stopped') {
        response = await this.model.respond(userId, { agreement, signal: AbortSignal.any([input.signal, AbortSignal.timeout(8000)]) });
      }
    } catch { /* The agreement is already durable; a natural fallback still confirms it. */ }
    if (!this.current(userId, input)) return;
    const sources = [...new Set([input.messageId, ...(response?.sources ?? [])])], memories = response?.memoryIds ?? [];
    const draft = response?.reminderText;
    if (agreement.action === 'saved' && typeof draft === 'string' && draft.includes(agreement.text) && !/编号|创建成功|提醒你[:：]|今天|明天|后天/.test(draft)) {
      this.store.prepareReminderDelivery(userId, agreement.id, draft, { sources, memories });
    }
    const bubbles = response?.bubbles;
    const valid = Array.isArray(bubbles) && bubbles.length && !/已安排|创建成功|北京时间|编号/.test(bubbles.join(''));
    await this.deliver(userId, valid ? bubbles : [agreement.reply], input, { control: true, kind: 'agreement', sources, memories });
  }
  async deliver(userId, bubbles, input, { control = false, kind, sources = [], memories = [], proactive = false, onFirst } = {}) {
    let sent = 0;
    for (const text of bubbles) {
      if (!this.current(userId, input) || (!control && !this.store.preferences(userId).enabled)) break;
      if (!proactive && this.store.now() - input.at > 4 * 60000) break;
      const user = this.store.user(userId);
      const reply = proactive ? undefined : { id: input.id, seq: this.store.replySequence(input.id) };
      await this.transport.text(user.openid, text, reply);
      this.store.message(userId, 'assistant', text, { kind: kind ?? (control ? 'command' : 'text'), sources, memories });
      if (sent++ === 0) onFirst?.();
      if (sent < bubbles.length) await this.sleep(this.store.config().replyGapMs, undefined, { signal: input.signal });
    }
    return sent;
  }
  async respond(userId, response, input, proactive = false) {
    if (proactive && response.skipped) return;
    const prefs = this.store.preferences(userId), text = response.bubbles.join(' ');
    const explicit = !proactive && /用语音|语音回|说给我听/.test(input.raw);
    const automatic = prefs.autoVoice && response.voice && this.random() < prefs.autoVoiceChance && !['reduced', 'stopped'].includes(this.store.usage().level);
    let initiated = false;
    const onFirst = () => { if (proactive && !initiated) { this.store.initiated(userId); initiated = true; } };
    if ((explicit || automatic) && this.voice && text.length <= 100) {
      try {
        const audio = await this.voice.synthesize(text, { signal: input.signal, optional: !explicit, instruction: response.voiceInstruction });
        if (!this.current(userId, input) || !this.store.preferences(userId).enabled) return;
        if (!proactive && this.store.now() - input.at > 4 * 60000) return;
        const reply = proactive ? undefined : { id: input.id, seq: this.store.replySequence(input.id) };
        await this.transport.audio(this.store.user(userId).openid, audio, reply);
        this.store.message(userId, 'assistant', text, { kind: 'voice', sources: response.sources, memories: response.memoryIds });
        onFirst();
        if (!prefs.voiceWithText) return;
      } catch (error) { if (input.signal.aborted) return; this.log('voice', '语音未完成，回退到对应文字。'); }
    }
    await this.deliver(userId, response.bubbles.slice(0, prefs.maxBubbles), input, { sources: response.sources, memories: response.memoryIds, proactive, onFirst });
  }
  command(userId, text, messageId) {
    const user = this.store.user(userId);
    if (/^\/加入(?:\s|$)/.test(text)) return '欢迎来找大肥鱼玩！可以直接聊天，也可以发 /帮助 查看记忆、提醒和个人设置。';
    if (text === '/帮助') return '可以直接聊天、发语音或普通图片。\n/记忆 · /记住 内容 · /忘记 关键词\n/更正 记忆编号 新内容\n/提醒 5分钟后 喝水\n/提醒 2026-12-01 08:00 内容\n/提醒列表 · /取消提醒 编号\n/设置 · /设置 主动 开或关 · /设置 次数 2\n/设置 时段 9-22 · /设置 间隔 3\n/设置 自动语音 开或关 · /设置 语音附文 开或关\n/设置 恢复默认 · /忙';
    if (/^\/记忆(?:\s+\d+)?$/.test(text)) {
      const memories = this.store.memories(userId), pages = Math.max(1, Math.ceil(memories.length / 5));
      const page = Math.min(pages, Math.max(1, Number(text.split(/\s+/)[1]) || 1));
      return memories.length ? `${memories.slice((page - 1) * 5, page * 5).map(m => `${m.id.slice(0, 8)}：${m.text}`).join('\n')}\n第 ${page}/${pages} 页；可发送 /记忆 页码。` : '还没有保存长期记忆。';
    }
    if (text.startsWith('/记住 ')) { this.store.remember(userId, text.slice(4), messageId ? [messageId] : []); return '记住啦。你可以随时查看、更正或让我忘记。'; }
    if (text.startsWith('/忘记 ')) { const result = this.store.forget(userId, { keyword: text.slice(4).trim() }); return `已清理相关记忆 ${result.memories} 条和关联记录 ${result.messages} 条。${result.reminders ? `相关的 ${result.reminders} 件约定也一起忘掉了。` : ''}`; }
    if (text.startsWith('/更正 ')) { const match = text.match(/^\/更正\s+(\S+)\s+(.+)$/); const memory = match && this.store.memories(userId).find(m => m.id.startsWith(match[1])); if (!memory) return '请先用 /记忆 查看编号，再发送 /更正 编号 新内容。'; this.store.forget(userId, { memoryId: memory.id, replacement: match[2] }); return '已更正，并清理关联的旧记录。'; }
    if (text === '/忙' || /^(我)?(现在|这会儿)?(在忙|很忙|先忙|忙去了)[。！!]?$/u.test(text)) { this.store.busy(userId); return '好，你先忙。回来找我就好～'; }
    if (text === '/设置') { const p = this.store.preferences(userId); return `主动聊天：${p.proactiveEnabled ? '开' : '关'}；每天最多 ${p.proactiveDaily} 次\n时段：${p.startHour}～${p.endHour} 点；最小间隔 ${p.intervalHours} 小时\n自动语音：${p.autoVoice ? '开' : '关'}；语音附文：${p.voiceWithText ? '开' : '关'}\n发送 /帮助 查看修改方式。`; }
    if (text === '/设置 恢复默认') { this.store.updateUser(userId, { prefs: {} }); return '已恢复全局默认偏好。'; }
    if (text.startsWith('/设置 ')) {
      const [, name, value] = text.split(/\s+/); const patch = { ...user.prefs };
      const bool = { 主动: 'proactiveEnabled', 自动语音: 'autoVoice', 语音附文: 'voiceWithText' };
      if (bool[name] && ['开', '关'].includes(value)) patch[bool[name]] = value === '开';
      else if (name === '次数') patch.proactiveDaily = Number(value);
      else if (name === '间隔') patch.intervalHours = Number(value);
      else if (name === '时段' && /^\d{1,2}-\d{1,2}$/.test(value)) [patch.startHour, patch.endHour] = value.split('-').map(Number);
      else return '这项设置我没看懂，发送 /帮助 查看示例。';
      this.store.updateUser(userId, { prefs: patch }); return '个人偏好已保存，全局停用和预算限制仍然有效。';
    }
    const reminder = this.reminderCommands.handle(userId, text, messageId);
    if (reminder !== null) return reminder;
    if (text.startsWith('/')) return '暂时不认识这个命令，发 /帮助 看看吧。';
    return null;
  }
  async tick() {
    if (this.ticking) return; this.ticking = true;
    try {
      const now = this.store.now();
      if (now - this.lastPrune > 3600000) { this.store.prune(); this.lastPrune = now; }
      for (const candidate of this.store.dueReminders()) {
        const reminder = this.store.pendingReminder(candidate.id);
        if (!reminder) continue;
        const config = this.store.config(), age = this.store.now() - reminder.due;
        if (age > config.reminderGraceMinutes * 60000) { this.store.markReminder(reminder.id, 'missed', '超过补发窗口'); continue; }
        if (!config.enabled || !this.store.user(reminder.user_id)?.enabled) continue;
        this.store.markReminder(reminder.id, 'sending');
        try {
          const text = reminderDelivery(reminder, age > 60000);
          await this.transport.text(this.store.user(reminder.user_id).openid, text);
          this.store.message(reminder.user_id, 'assistant', text, { kind: 'reminder', sources: JSON.parse(reminder.delivery_sources), memories: JSON.parse(reminder.delivery_memories) });
          this.store.markReminder(reminder.id, 'sent', age > 60000 ? '延迟补发' : '');
        } catch (error) {
          this.store.markReminder(reminder.id, error.status ? 'pending' : 'uncertain', error.status ? `平台暂未接受（${error.code ?? error.status}）` : '网络结果不确定，请核对 QQ；不自动重试', now + 60000);
          this.log('reminder', '提醒发送未完成，已记录状态。');
        }
      }
      for (const user of this.store.users()) {
        if (this.jobs.has(user.id) || (this.cooldowns.get(user.id) ?? 0) > now || !proactiveAllowed(user, this.store.preferences(user.id), this.store.usage(), now)) continue;
        this.cooldowns.set(user.id, now + this.store.config().proactiveRetryHours * 3600000);
        // Persist before the provider call, including interrupted attempts.
        // Considering an opening is neither a sent message nor an unanswered one.
        this.store.checkedProactive(user.id);
        const controller = new AbortController(); this.jobs.set(user.id, controller);
        try {
          const input = { revision: user.revision, signal: controller.signal };
          const response = await this.model.respond(user.id, { proactive: true, signal: controller.signal });
          if (!response.skipped && proactiveAllowed(this.store.user(user.id), this.store.preferences(user.id), this.store.usage(), this.store.now(), { ignoreCheck: true })) await this.respond(user.id, response, input, true);
        } catch (error) { if (!controller.signal.aborted) this.log('proactive', error.message); }
        finally { if (this.jobs.get(user.id) === controller) this.jobs.delete(user.id); }
      }
    } finally { this.ticking = false; }
  }
}
