const DAY = 86400000;
const offset = 8 * 3600000;
const numberPattern = '[0-9零〇一二两三四五六七八九十]+';
const clockPattern = new RegExp(`^(?:(今天|明天|后天)\\s*)?(?:(凌晨|早上|上午|中午|下午|晚上)\\s*)?(${numberPattern})(?:(?:点|时)(?:(半|一刻|三刻)|(${numberPattern})分?)?|:([0-9]{1,2}))(?:钟)?\\s*(.*)$`);
const relativePattern = new RegExp(`^(${numberPattern}|半)\\s*(分钟|小时)后\\s*(?:(?:提醒我|叫我|喊我)\\s*)?(.+)$`);
const dateAt = (now, day = '今天') => new Date(now + offset + ({ 今天: 0, 明天: 1, 后天: 2 })[day] * DAY).toISOString().slice(0, 10);
const showTime = due => new Date(due + offset).toISOString().slice(0, 16).replace('T', ' ');
const normalize = text => text.normalize('NFKC').trim().replace(/^(?:请|麻烦你?|帮我)\s*/, '').replace(/明早/g, '明天早上').replace(/明晚/g, '明天晚上').replace(/今早/g, '今天早上').replace(/今晚/g, '今天晚上');

export function friendlyTime(due, now) {
  const date = new Date(due + offset), hour = date.getUTCHours(), minute = date.getUTCMinutes();
  const day = dateAt(due), relative = day === dateAt(now) ? '今天' : day === dateAt(now, '明天') ? '明天' : day === dateAt(now, '后天') ? '后天' : `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
  const part = hour < 6 ? '凌晨' : hour < 12 ? '早上' : hour === 12 ? '中午' : hour < 18 ? '下午' : '晚上';
  return `${relative}${part}${hour > 12 ? hour - 12 : hour}点${minute === 30 ? '半' : minute ? `${minute}分` : ''}`;
}

export const reminderDelivery = (reminder, late = false) => `${late ? '来晚了一点，抱歉呀。' : ''}${reminder.delivery_text || `到约好的时间啦，我来叫你${reminder.text}～`}`;

function number(text) {
  if (/^\d+$/.test(text)) return Number(text);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (text in digits) return digits[text];
  const tens = text.match(/^([一二两三四五六七八九])?十([一二两三四五六七八九])?$/);
  return tens ? (tens[1] ? digits[tens[1]] : 1) * 10 + (tens[2] ? digits[tens[2]] : 0) : NaN;
}

function resolveClock(request, now) {
  let hour = request.hour;
  const part = request.part;
  if (part === '凌晨' && hour === 12) hour = 0;
  else if (['下午', '晚上'].includes(part) && hour >= 1 && hour < 12) hour += 12;
  else if (part === '中午' && hour >= 1 && hour <= 2) hour += 12;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(request.minute) || request.minute < 0 || request.minute > 59 ||
    (['早上', '上午', '凌晨'].includes(part) && hour > 12) || (part === '中午' && (hour < 11 || hour > 14)) || (part === '晚上' && hour === 12)) throw new Error('时间不够明确，请使用完整日期和 24 小时制，例如 /提醒 2026-12-01 08:00 吃饭。');
  if (!part && request.ambiguousPeriod) return { ...request, needsConfirmation: true };
  let due = Date.parse(`${request.day ?? dateAt(now)}T${String(hour).padStart(2, '0')}:${String(request.minute).padStart(2, '0')}:00+08:00`);
  if (!request.day && due <= now) due += DAY;
  return { due, text: request.text };
}

export function reminderInput(input, now) {
  const text = normalize(input), command = text.startsWith('/提醒');
  const body = command ? text.replace(/^\/提醒\s*/, '') : text;
  const relative = body.replace(/^(?:提醒我|叫我|喊我)\s*/, '').match(relativePattern);
  if (relative) return { due: now + (relative[1] === '半' ? 0.5 : number(relative[1])) * (relative[2] === '分钟' ? 60000 : 3600000), text: relative[3].trim() };
  const absolute = command && body.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$/);
  if (absolute) {
    const due = Date.parse(`${absolute[1]}T${absolute[2]}:00+08:00`);
    if (!Number.isFinite(due) || showTime(due) !== `${absolute[1]} ${absolute[2]}`) throw new Error('提醒日期或时间无效。');
    return { due, text: absolute[3].trim() };
  }
  let time, content;
  const first = body.match(/^(.*?)\s*(?:提醒我|叫我|喊我)\s*(.+)$/);
  if (first?.[1]) { time = first[1].replace(/^(?:在|到)\s*/, ''); content = first[2]; }
  else {
    const rest = body.replace(/^(?:提醒我|叫我|喊我)\s*/, '');
    if (!command && rest === body) return null;
    const match = rest.match(clockPattern); if (!match || !match[7]) return null;
    time = rest.slice(0, rest.length - match[7].length).trim(); content = match[7];
  }
  const match = time.match(clockPattern); if (!match || match[7]) return null;
  const minute = match[4] ? ({ 半: 30, 一刻: 15, 三刻: 45 })[match[4]] : match[5] ? number(match[5]) : Number(match[6] ?? 0);
  const hour = number(match[3]);
  return resolveClock({ day: match[1] ? dateAt(now, match[1]) : null, part: match[2], hour, minute, ambiguousPeriod: !match[6] && hour >= 1 && hour <= 12, text: content.trim() }, now);
}

export class ReminderCommands {
  constructor(store) { this.store = store; this.pending = new Map(); }
  ask(userId, request) {
    this.pending.set(userId, { request, expires: this.store.now() + 15 * 60000 });
    return `好呀，你说的${request.hour}点是早上还是晚上呀？`;
  }
  save(userId, request, sourceId) {
    const sources = [...new Set([...(request.sources ?? []), sourceId].filter(Boolean))];
    request = { ...request, sources };
    if (request.needsConfirmation) return this.ask(userId, request);
    const id = this.store.reminder(userId, request.text, request.due, { sources });
    this.pending.delete(userId);
    const when = friendlyTime(request.due, this.store.now());
    return { type: 'agreement', action: 'saved', id, due: request.due, text: request.text, when, reply: '好，到时候叫你。' };
  }
  handle(userId, input, sourceId) {
    const text = normalize(input), now = this.store.now();
    if (text === '/提醒列表') return this.store.reminders(userId).slice(0, 20).map(r => `${r.id.slice(0, 8)} · ${showTime(r.due)} · ${r.text}（${({ pending: '等待', sent: '已发', missed: '已错过', cancelled: '取消', uncertain: '待核对' })[r.status] ?? r.status}）`).join('\n') || '还没有提醒。';
    if (text.startsWith('/取消提醒 ')) { const key = text.slice(6).trim(), reminder = this.store.reminders(userId).find(r => r.id.startsWith(key)); return reminder && this.store.cancelReminder(userId, reminder.id) ? '已取消这条提醒。' : '没有找到可取消的提醒。'; }
    const pending = this.pending.get(userId);
    if (pending && pending.expires > now) {
      if (/^(取消|取消提醒|算了|不用了|\/取消)[。!！]?$/.test(text)) { this.pending.delete(userId); return '好呀，那就先不约了～'; }
      const choice = text.replace(/[。!！]$/, '').match(/^(今天|明天|后天)?(凌晨|早上|上午|中午|下午|晚上)?$/);
      if (choice && (choice[1] || choice[2])) return this.save(userId, { ...resolveClock({ ...pending.request, ...(choice[1] ? { day: dateAt(now, choice[1]) } : {}), ...(choice[2] ? { part: choice[2] } : {}) }, now), sources: pending.request.sources }, sourceId);
      if (/^(好|好的|是|是的|确认|嗯)[。!！]?$/.test(text)) return this.ask(userId, pending.request);
    }
    this.pending.delete(userId);
    const cancellation = text.match(/^(?:不用|不要|别)(?:再)?(?:提醒|叫|喊)(?:我)?(.*?)了[。!！~～]?$/);
    if (cancellation || /^(?:取消刚才那个|刚才那个取消吧|刚才那个不用了)[。!！~～]?$/.test(text)) {
      const topic = cancellation?.[1].trim();
      const candidates = this.store.upcomingReminders(userId).filter(r => !topic || r.text.includes(topic));
      if (!candidates.length) return '好呀，我这边没有等着叫你的这件事。';
      if (candidates.length > 1) return `我们还约了几件事，你说的是哪件呀？比如${candidates.slice(0, 3).map(r => r.text).join('、')}。`;
      const reminder = candidates[0]; this.store.cancelReminder(userId, reminder.id);
      return { type: 'agreement', action: 'cancelled', id: reminder.id, due: reminder.due, text: reminder.text, reply: `好，那就不叫你${reminder.text}啦～` };
    }
    const intent = /^\/提醒/.test(text) || /提醒我/.test(text) || /(?:点|时|分钟|小时).*?(?:叫我|喊我)/.test(text);
    if (intent && /^(?:不要|不用|别|不需要)/.test(text)) return '没有创建新提醒。如果要取消已有提醒，请先发 /提醒列表，再发 /取消提醒 编号。';
    if (intent && /每天|每日|每周|每月/.test(text)) return '我现在能记下这一次的约定，每天重复还没学会。先约明天的好不好？';
    const reminder = reminderInput(text, now);
    if (reminder) return this.save(userId, reminder, sourceId);
    if (intent) return '好呀，你想让我什么时候来叫你、叫你做什么呢？';
    return null;
  }
}
