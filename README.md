# QQ 大肥鱼陪伴机器人

面向 1～5 位受邀用户的 QQ 单聊陪伴机器人。支持稳定人设、独立记忆、分条回复、语音、主动聊天、一次性提醒和管理员网页。

已实现管理员网页、独立记忆、可调主动聊天、提醒和预算保护，并配置 GitHub Actions 自动测试与云服务器部署。DeepSeek 文字对话、语音输入和普通图片理解已在本机实测；macOS 的语音条输出无法直接迁到 Linux，云端语音暂时回退文字。运行和迁移结果见 [验证记录](docs/validation/app.md)。

日常更新推送到 `main` 即触发测试和部署流程。目前云端已运行，GitHub 测试已通过，自动发布仍受服务器网络连接超时阻碍，见 [任务 #5](https://github.com/1968352583/qqbot_fatfish/issues/5)。访问云端后台时运行 `ssh -N -L 3210:127.0.0.1:3210 root@warma`，再打开 [后台](http://127.0.0.1:3210)。关闭本机或隧道不会停止云端机器人。详见 [部署说明](docs/deployment.md)。

## 本地开发与管理

需要 Node.js 24.14.x（当前验证为 24.14.1），无需安装第三方 npm 依赖。使用 Node 内置 SQLite；该运行时仍会显示 SQLite ExperimentalWarning。

1. 复制 `.env.example` 为 `.env.local`，填入 QQ 凭据、DeepSeek 密钥和至少 12 位管理员密码，设置文件权限为 `600`。本次本机配置已通过 `.local/setup-qq.sh`、`.local/setup-ai.sh` 完成，已有配置无需重做。
2. 在项目根目录运行：

   ```bash
   npm start
   ```

3. 打开 [管理员后台](http://127.0.0.1:3210)，使用刚设置的密码登录。首次部署可在「成员与提醒」创建邀请码，再从 QQ 单聊发送 `/加入 邀请码`。本机已有联调账号会自动导入。
4. 直接在 QQ 聊天；发送「用语音回复我」测试语音，发送 `/帮助` 查看命令。按 `Ctrl+C` 停止，再次启动会保留数据。

本机数据在 `.local/app/`，包含 SQLite 聊天与记忆、设置和仅本机保存的凭据。不要把 `.env.local` 或 `.local/` 上传至公共仓库。后台修改的凭据优先于环境变量，修改密码会退出所有后台会话。

启动脚本只对机器人进程禁用环境代理；本机代理路径曾约 120 秒断线，直连及网关会话恢复已经验证。同一数据目录只允许运行一个应用实例。电脑休眠、关机或进程退出后，本机机器人会离线。

## 使用与验证

- [使用说明](docs/usage.md)：个人设置、记忆、提醒、管理员功能及费用规则。
- [云端部署说明](docs/deployment.md)：GitHub Actions、systemd、SSH 后台、迁移与回滚。
- [应用验证记录](docs/validation/app.md)：实际收发、自动测试和限制。
- [QQ 通道联调](docs/validation/qq-c2c.md)：三条气泡、WAV 语音、窗口外主动发送与重连证据。
- [需求基线 #1](https://github.com/1968352583/qqbot_fatfish/issues/1)、[实现任务 #3](https://github.com/1968352583/qqbot_fatfish/issues/3)、[调查依据](docs/research/qqbot-feasibility.md)。

## 检查

```bash
npm test
python3 -m unittest discover -s tests -p '*_test.py'
```

36 项应用测试和 3 项发布包测试覆盖用户隔离、遗忘与来源清理、插话中断、预算、自然约定、提醒恢复、管理员鉴权、QQ 连接健康、媒体消息、网关重连，以及发布路径和文件权限校验。测试使用合成数据，不向真实 QQ 发消息，不调用付费模型。HTTP 测试需要本机监听权限。

单独排查官方通道可运行 `bash scripts/qq-smoke.sh check`；完整联调工具的发送操作仅对已绑定测试账号执行，详见通道联调文档。
