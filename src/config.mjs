import { defaultCharacter } from './character.mjs';

export const defaults = {
  enabled: true, proactiveEnabled: true, autoMemory: true, proactiveAllowCasual: true,
  character: defaultCharacter,
  model: 'deepseek-flash', modelBaseUrl: 'https://api.deepseek.com',
  maxBubbles: 3, replyGapMs: 1200, contextMessages: 24, retentionDays: 30,
  proactiveDaily: 2, startHour: 9, endHour: 22, intervalHours: 3, proactiveRetryHours: 1,
  busyHours: 4, unansweredLimit: 2, unansweredPauseHours: 24,
  reminderGraceMinutes: 10,
  autoVoice: true, autoVoiceChance: 0.1, voiceWithText: false,
  voiceProvider: process.platform === 'darwin' ? 'system' : 'disabled',
  voiceName: 'Tingting', voiceModel: '', voiceEndpoint: '', voiceRate: 180,
  bailianWorkspace: '', bailianVoice: 'longanhuan_v3.1', bailianPricePer10k: 1.4,
  voiceInstruction: '用普通话自然聊天，亲近、轻松，情绪表达克制。',
  voiceEmotionEnabled: true, voiceSpeed: 1, voicePitch: 1, voiceVolume: 50,
  totalBudget: 100, fixedReserve: 30, safetyReserve: 10,
  warnPercent: 80, reducePercent: 90,
  inputPrice: 2, outputPrice: 8, voicePricePer10k: 1,
};
export const personalKeys = ['proactiveEnabled', 'proactiveDaily', 'startHour', 'endHour', 'intervalHours', 'busyHours', 'unansweredLimit', 'unansweredPauseHours', 'autoVoice', 'voiceWithText'];
const ranges = {
  maxBubbles: [1, 3], replyGapMs: [0, 10000], contextMessages: [2, 80], retentionDays: [1, 365],
  proactiveDaily: [0, 20], startHour: [0, 23], endHour: [1, 24], intervalHours: [0.1, 48], proactiveRetryHours: [0.1, 48],
  busyHours: [0.1, 168], unansweredLimit: [1, 10], unansweredPauseHours: [1, 168],
  reminderGraceMinutes: [0, 120], autoVoiceChance: [0, 1], voiceRate: [100, 250],
  totalBudget: [0, 100000], fixedReserve: [0, 100000], safetyReserve: [0, 100000],
  voiceSpeed: [0.5, 2], voicePitch: [0.5, 2], voiceVolume: [0, 100], bailianPricePer10k: [0, 1000],
  warnPercent: [1, 99], reducePercent: [1, 100], inputPrice: [0, 1000], outputPrice: [0, 1000], voicePricePer10k: [0, 1000],
};
export function validateConfig(patch, base = defaults, personal = false) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置格式不正确。');
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in defaults) || (personal && !personalKeys.includes(key))) throw new Error(`不支持的设置：${key}`);
    if (typeof value !== typeof defaults[key]) throw new Error(`设置类型不正确：${key}`);
    if (ranges[key] && (!Number.isFinite(value) || value < ranges[key][0] || value > ranges[key][1])) throw new Error(`设置超出范围：${key}`);
    if (['maxBubbles', 'replyGapMs', 'contextMessages', 'retentionDays', 'proactiveDaily', 'startHour', 'endHour', 'unansweredLimit', 'voiceRate'].includes(key) && !Number.isInteger(value)) throw new Error(`设置必须为整数：${key}`);
    if (typeof value === 'string' && value.length > (key === 'character' ? 12000 : key === 'voiceInstruction' ? 500 : 300)) throw new Error(`设置过长：${key}`);
  }
  const merged = { ...base, ...patch };
  if (merged.startHour >= merged.endHour) throw new Error('开始时段必须早于结束时段。');
  if (merged.warnPercent >= merged.reducePercent) throw new Error('预警阈值必须小于降级阈值。');
  if (merged.fixedReserve + merged.safetyReserve > merged.totalBudget) throw new Error('固定开支与余量不能超过总预算。');
  if (!['system', 'http', 'bailian', 'disabled'].includes(merged.voiceProvider)) throw new Error('语音方式无效。');
  if (merged.bailianWorkspace && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(merged.bailianWorkspace)) throw new Error('请填写北京地域的业务空间 ID，不要填写密钥或完整网址。');
  if (!Number.isInteger(merged.voiceVolume)) throw new Error('语音音量必须为整数。');
  for (const key of ['modelBaseUrl', 'voiceEndpoint']) {
    if (!merged[key]) continue;
    const url = new URL(merged[key]);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('模型和语音地址必须为 HTTPS。');
  }
  return merged;
}
export const chinaDate = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
export const chinaHour = now => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23' }).format(new Date(now)));
export const monthKey = now => chinaDate(now).slice(0, 7);
