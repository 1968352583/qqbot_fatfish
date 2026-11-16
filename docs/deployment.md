# GitHub CI/CD 与云端运行

本项目使用 GitHub 托管运行器执行测试，通过受限 SSH 入口发布到 Linux 服务器，由 systemd 持续运行。机器人使用独立的 `fatfish` 账号，开机启动，异常退出后自动重启；主程序与私人数据分别存放。实际上线结果见 [验证记录](validation/app.md)。

2026-11-14 当前状态：云端实例已经通过受限发布入口上线，QQ 连接及异常重启验证通过；GitHub 测试通过，但运行器到服务器的连接超时，自动发布仍待网络问题解决。以下流程已配置，尚未完成端到端自动发布验收。

## 日常发布

提交并推送至 `main` 后，GitHub Actions 的 [Test and deploy](https://github.com/1968352583/qqbot_fatfish/actions/workflows/ci-deploy.yml) 自动执行：

1. 在 Ubuntu 上使用 Node.js 24.14.1 运行应用测试、发布包验证和 Shell 语法检查。
2. 仅测试成功的 `main` 提交可访问 `production` 部署环境；PR 只测试，不部署。
3. 打包指定的应用文件，经专用 SSH 密钥上传，不包含 `.env.local`、`.local/`、聊天数据库或模型权重。
4. 串行切换版本并重启服务；确认 HTTP 正常、QQ 网关已连接且运行版本对应当前提交。
5. 新版本无法通过健康检查时恢复上一版代码；首次部署没有上一版时停止服务并报错。回滚不恢复旧数据库，避免覆盖新消息和遗忘操作。数据库变更应保持前后版本兼容。

也可以在 Actions 页选择 `Run workflow`，分支使用 `main`。已被新提交取代的旧任务会跳过部署，避免旧版本覆盖新版本。发布程序不会执行上传包中的安装脚本，不接受软链接、路径穿越或超限归档。

## 后台与运维

公网入口为 [https://8.130.14.159](https://8.130.14.159)，使用原管理员密码。完成下述安装并处理设备上的证书信任后，手机或其他电脑可直接访问，不依赖本机开机或 SSH 隧道。

### IP HTTPS 安装与证书更新

将部署文件传到服务器后，以 root 运行：

```bash
bash deploy/install-admin-https.sh 8.130.14.159
```

入口复用宝塔 Nginx `/www/server/nginx/sbin/nginx`，独立配置位于 `/www/server/panel/vhost/nginx/zz-fatfish-admin.conf`。该 IP 的 HTTP 80 请求跳转到 HTTPS；HTTPS 443 反代到 `127.0.0.1:3210`。应用继续仅监听回环地址，环境配置使用：

```dotenv
ADMIN_ORIGIN=https://8.130.14.159
ADMIN_TRUST_PROXY=1
```

`ADMIN_TRUST_PROXY=1` 用于识别本机 Nginx 转发的 HTTPS 请求，应与回环监听一起使用；不要把应用端口 3210 直接开放到公网。云安全组和系统防火墙需允许入口使用的 80、443 端口。

证书为自签叶证书，包含 IP SAN `8.130.14.159`、`CA:FALSE`，有效期 365 天。证书文件为 `/etc/fatfish/tls/cert.pem`，私钥为 `/etc/fatfish/tls/privkey.pem`；私钥权限为 `0600`，仅保存在服务器，不能放入仓库或传给访问设备。浏览器不会自动信任自签证书，这不代表已取得可信 CA 签发的证书。

首次从新设备访问时，先通过已核实主机密钥的 SSH 连接读取证书指纹及有效期：

```bash
ssh root@warma 'openssl x509 -in /etc/fatfish/tls/cert.pem -noout -fingerprint -sha256 -dates'
```

核对浏览器显示的 SHA-256 指纹一致后，再按设备支持的方式信任该证书或添加访问例外；需要导入时仅使用 `cert.pem`，不要导出私钥。证书更新后需重新核对新指纹，部分设备也需重新处理信任。不要忽略指纹不符的警告。

证书剩余有效期不足 30 天时，在服务器重新运行 `bash deploy/install-admin-https.sh 8.130.14.159` 更新，并检查新有效期和指纹；剩余有效期充足时脚本保留现有证书。当前方案需手动更新，没有可信 CA 自动续期。2026-11-16 的排查中，服务器直连 Let's Encrypt 生产和测试 ACME 接口均发生 TCP 超时，可信 CA 签发受出站网络阻塞；此处记录的是自签 HTTPS 配置步骤，实际验收结果见 [验证记录](validation/app.md)。

### SSH 备用入口与运维

公网入口或设备证书信任暂不可用时，可在本机终端建立隧道并保持连接：

```bash
ssh -N -L 3210:127.0.0.1:3210 root@warma
```

然后打开 [备用管理员后台](http://127.0.0.1:3210)，使用原管理员密码。隧道只用于这条备用访问路径；断开隧道、关闭电脑都不影响服务器上的机器人。

服务仍仅监听服务器 `127.0.0.1:3210`，公网请求由 Nginx 转发。若本地 3210 被占用，先停止占用它的本机应用；不要只换隧道端口而不核对 Host/Origin 校验。

```bash
ssh root@warma 'systemctl status fatfish --no-pager'
ssh root@warma 'journalctl -u fatfish -n 50 --no-pager'
ssh root@warma 'systemctl restart fatfish'
ssh root@warma 'curl -fsS http://127.0.0.1:3210/api/health'
```

`/api/health` 只返回健康标志与版本，不返回聊天或凭据；QQ 未连接时返回 503。网关权限被平台拒绝时服务保留后台用于诊断，不能仅凭 `systemctl active` 判断 QQ 已在线。

## 目录和凭据

| 位置 | 内容 |
| --- | --- |
| `/opt/fatfish/releases/<提交 SHA>` | 只读版本源码 |
| `/opt/fatfish/current` | 当前版本软链接 |
| `/opt/fatfish/runtime` | 校验过的 Node.js 24.14.1 Linux 运行时 |
| `/var/lib/fatfish` | SQLite 数据库、后台保存的凭据覆盖和进程锁，仅应用账号可读写 |
| `/etc/fatfish/fatfish.env` | QQ、DeepSeek 和管理员环境配置，root 与应用账号可读 |
| `/etc/fatfish/tls/cert.pem` | 公网后台的自签 IP 叶证书，可供访问设备核对或导入 |
| `/etc/fatfish/tls/privkey.pem` | TLS 私钥，root 专用、权限 `0600`，仅留在服务器 |
| `/www/server/panel/vhost/nginx/zz-fatfish-admin.conf` | 宝塔 Nginx 的 IP HTTPS 入口与回环反代配置 |
| `/usr/local/sbin/fatfish-deploy` | root 管理的受限发布入口 |

GitHub `production` 环境只保存 `DEPLOY_HOST`、`DEPLOY_KEY`、`DEPLOY_KNOWN_HOSTS`。这把 SSH 密钥属于独立的 `fatfish-deploy` 账号，通过强制命令和 sudo 限定到发布入口，不能直接取得任意 SSH shell。服务器主机密钥在安装时核实并固定，部署时不临时接受陌生主机密钥。应用业务密钥不进入 GitHub。

密钥管理仍可通过后台操作；后台存储的凭据覆盖环境文件。服务器配置文件使用 Node 的 dotenv 解析，不应作为 Shell 脚本 `source`。

## 首次安装与迁移

安装程序 `deploy/install.sh` 适用于 x86_64 Linux，要求 systemd、Python 3、curl、tar、xz、sudo 和 flock。将 `deploy/` 文件、官方 `node-v24.14.1-linux-x64.tar.xz` 以及专用部署公钥传到服务器，使用 root 运行：

```bash
bash deploy/install.sh /path/to/node-v24.14.1-linux-x64.tar.xz /path/to/github-deploy.pub
```

程序检查运行时 SHA-256、创建专用账号、安装服务及受限发布入口，仅启用开机启动，不立即启动。首次发布前还需通过 SSH 配置业务凭据与持久数据库、为 QQ 平台添加服务器出口 IP 白名单，并设置 GitHub 环境 Secrets 和只允许 `main` 的部署规则。

迁移必须确保原实例停止，再使用 SQLite backup API 创建一致性快照，传输至 `/var/lib/fatfish/fatfish.sqlite`。若存在后台保存的 `secrets.json` 也需迁移，不复制旧进程锁。迁移后核对数据库完整性及成员、聊天、记忆、提醒数量，再启动新实例。2026-11-14 用户明确授权将本机凭据及上述数据迁往其指定服务器。

本机 `.local/cloud-deployed` 标记会阻止再次 `npm start`，避免意外运行双实例。如确实要恢复本机，先停止服务器服务，再明确使用 `FATFISH_ALLOW_LOCAL=1 npm start`。本机旧数据库是迁移时快照，不包含云端上线后的新对话；不能直接覆盖云端数据。

版本更新保留现有数据库；正在发送且结果不明的提醒会标记为待核对，过期按原补发规则处理。没有自动恢复旧备份，也尚未配置周期性异地备份。旧代码版本保留在 releases，按需由管理员清理。

发布入口与 systemd 配置属于服务器安装层；修改 `deploy/` 后需要管理员重新安装相应文件，应用发布包不会自行改写这些权限控制文件。

## 语音与资源

当前服务器为 2 核、约 2 GB 内存、无 NVIDIA GPU。机器人本体调用远端 DeepSeek；语音输入与图片理解延续现有通道，macOS Tingting 输出无法在 Linux 使用。迁移初期禁用了语音输出，后续新增百炼 Qwen-Audio-3.1-TTS-Plus 适配，服务器已验证合成和 WAV 下载，可通过管理员后台选择百炼并配置声音。

用户指定的 Breeze TTS 2 本地权重约 7.124 GiB，官方建议至少 12 GB 显存；当前服务器无法按现有实现正常运行。具体依据和协议差异见 [Breeze 适配检查](research/breeze-server-fit.md)。百炼由远端执行推理，不安装本地模型。

百炼使用北京地域业务空间专属 HTTPS 域名。API Key 通过 `DASHSCOPE_API_KEY` 环境变量或后台凭据提供，业务空间和音色在持久设置中保存；后台凭据优先于环境变量。合成结果仅从允许的阿里云 OSS 域名下载，使用 HTTPS，不将 API Key 转发到文件存储，不跟随重定向。管理员试听与音色设计要求登录及同源请求。

仓库中的 Dockerfile/compose.yaml 保留作可选模板，本次正式部署使用 systemd，没有依赖服务器拉取 Docker 镜像。

实现参考：[GitHub 并发控制](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)、[GitHub Actions 安全使用](https://docs.github.com/en/actions/reference/security/secure-use)。
