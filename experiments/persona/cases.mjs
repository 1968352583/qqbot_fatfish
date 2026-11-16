// Only synthetic fixtures. No real QQ users, chat, or memory is read.
export const now = Date.parse('2026-11-16T07:00:00+00:00');
export const cases = [
  { id: 'praise', title: '被夸', history: [['user', '那份表格终于填完了。'], ['assistant', '收工，脑子也可以下班一会儿了。']], turns: ['刚才那句话还挺会接的，你今天表现不错。'] },
  { id: 'teasing', title: '善意调侃', turns: ['你这条鱼是不是一到干活的时候就想摸鱼。'] },
  { id: 'disagree', title: '意见不同', turns: ['明天要汇报，我准备完全不看材料，到时候瞎说两句应该也行。'] },
  { id: 'sad', title: '低落时的分寸', turns: ['今天开会讲错了点东西，越想越丢脸。我现在只想躺着。'] },
  { id: 'busy', title: '用户要忙', turns: ['先不聊了，我要把这段写完。'] },
  { id: 'agreement', title: '接下约定与追问时间', note: '在隔离的内存数据库真实保存 15:10 的约定，再调用现有模型接口。此处验证接话和到点文案，不验证真实 QQ 调度。', turns: [{ text: '十分钟后叫我歇一下。', saveReminder: { text: '歇一下', minutes: 10 } }, '你可别忘了。', '所以是几点？'] },
  { id: 'emotion', title: '小情绪延续并转入认真话题', note: '首句提到的“刚才那句”未给出具体前文，本组主要观察第二轮之后能否自然转入认真话题，不据首答认定完整情绪能力。', turns: ['你刚才那句，嗯……勉强算可爱。', '好吧，其实是特别可爱。', '不闹了，今天状态真的不太好。'] },
  { id: 'new-friend', title: '刚认识的用户回来', turns: ['我回来了。'] },
  { id: 'familiar', title: '已有称呼与共同梗', history: [['user', '以后叫我阿栗吧。'], ['assistant', '好，阿栗。'], ['user', '我经常忘记吃午饭，咱俩就叫饭搭子吧。'], ['assistant', '行，饭搭子。']], memoryIndexes: [0, 2], turns: ['我回来了。'] },
  { id: 'shared', title: '共同经历与撤回旧梗', history: [['user', '我把报告文件叫饭盾计划吧，写完才能安心吃饭。'], ['assistant', '这个名字好记。']], memoryIndexes: [0], turns: ['饭盾计划终于交了。', '对了，以后别叫这个名字了，听着有点尴尬。', '今天总算能好好吃顿饭了。'] },
  { id: 'followup-open', title: '回访尚未结束的话题', note: '主动模型调用，预先提供合成历史；不代表已实现话题筛选或调度。', history: [['user', '今天下午有面试，结束再聊。'], ['assistant', '好，祝你顺利。']], at: '2026-11-16T10:00:00Z', turns: [{ proactive: true }] },
  { id: 'followup-closed', title: '已知结果后不重复追问', note: '只测候选表达能否利用已知结果。真实调度器应尊重休息，不应立即主动打扰。', history: [['user', '今天下午有面试，结束再聊。'], ['assistant', '好，祝你顺利。'], ['user', '面试通过了，我先休息。'], ['assistant', '恭喜，先歇着吧。']], at: '2026-11-16T10:00:00Z', turns: [{ proactive: true }] },
  { id: 'no-topic', title: '没有话题时的现有局限', note: '现有模型协议要求至少一条回复，尚不支持主动跳过。这是记录局限的诊断样例，不是候选角色卡能单独修复的问题。', turns: [{ proactive: true }] },
];
