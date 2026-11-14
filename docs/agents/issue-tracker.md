# Issue tracker: GitHub

本项目的任务和规格保存在 GitHub Issues。
目标仓库：https://github.com/1968352583/qqbot_fatfish

## 操作约定

使用 gh CLI。所有 issue、pr 和 label 命令均显式添加：
--repo 1968352583/qqbot_fatfish

gh api 命令使用 repos/1968352583/qqbot_fatfish 下的完整路径。

- 创建任务：gh issue create --title "标题" --body-file <正文文件>
- 读取任务：gh issue view <编号> --json number,title,body,labels,comments
- 列出任务：gh issue list --state open --json number,title,labels
- 添加评论：gh issue comment <编号> --body-file <评论文件>
- 添加标签：gh issue edit <编号> --add-label "<标签>"
- 移除标签：gh issue edit <编号> --remove-label "<标签>"
- 关闭任务：gh issue close <编号>

多行正文先写入临时文件，再通过 --body-file 传入。
分诊标签的角色映射见 `triage-labels.md`。

## 技能用语

“发布到任务跟踪器”：在目标仓库创建 GitHub Issue。
“获取相关任务”：读取指定 Issue 的正文、标签和评论。

## Pull requests as a triage surface

**PRs as a request surface: no.**

设为 yes 时，使用 gh pr 的对应命令读取、评论、标记和关闭 PR。
GitHub 的 Issue 与 PR 共用编号；引用不明确时先判断对象类型。

## Wayfinding operations

- Map：标记为 wayfinder:map 的 Issue，保存 Notes、
  Decisions-so-far 和 Fog。
- 子任务：优先使用 GitHub sub-issue 关联 Map；不可用时，
  在子任务正文记录 Part of #<map>，并在 Map 中维护任务清单。
- 类型：使用 wayfinder:research、wayfinder:prototype、
  wayfinder:grilling 或 wayfinder:task 标签。
- 阻塞：优先使用 GitHub 原生任务依赖；不可用时，在正文记录
  Blocked by: #<编号>。所有阻塞任务关闭后才可开始。
- 下一项：从 Map 的未关闭子任务中筛选无阻塞、未分配的任务，
  按 Map 顺序选择第一项。
- 认领：开始工作前将任务分配给执行者。
- 完成：评论记录结果，关闭子任务，再将结果摘要和链接补入
  Map 的 Decisions-so-far。
