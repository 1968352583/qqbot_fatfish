# 人设表达对照

`cases.mjs` 使用合成聊天对比角色卡，不读取真实用户记录、不向 QQ 发消息。`baseline.json` 保存 2026-11-16 的生产角色卡和非敏感模型配置；v1、v2 是访谈后的候选，v3 是用户选择后的合并版本，生产默认见 `src/character.mjs`。

2026-11-17，用户导入 run `2026-11-16T16:03:08.267Z` 的选择：赞美、低落安慰、约定、无旧话题开场选 baseline；调侃、忙碌、短情绪延续、新朋友、熟悉称呼、共同经历、未完话题回访、已结束话题选 candidate；意见不同一组无偏好。合并方向是保留温和可靠，适度增加主见与俏皮，不一味强化傲娇。

运行（默认不付费）：

```sh
node experiments/persona/run.mjs --character=v3 --name=dry-run
node --env-file-if-exists=.env.local experiments/persona/run.mjs --live --character=v3 --name=new-comparison
```

真实调用需本机已配置 DeepSeek 密钥。结果保存到被 Git 忽略的 `.local/persona-eval/<name>/`，包括不含请求头的请求/响应、费用估算和盲选 HTML；现有真实结果不会覆盖。每批最多 48 次、估算 2 元，具体受供应商账单影响。

脚本调用当前代码中的模型实现；日后重跑会带上最新的上下文和协议，不能冒称精确重现旧版本。v1/v2 历史两轮各 38 次真实调用；v3 另用 15 次合成情境检查行为，结果及局限见 `docs/validation/app.md`。少量情境只能提供调试证据，不能保证每次措辞完全相同，也不代表主观听感已经验收。
