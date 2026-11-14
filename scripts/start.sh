#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
if [[ -f .local/cloud-deployed && ${FATFISH_ALLOW_LOCAL:-0} != 1 ]]; then
  echo '机器人已迁移到云端。需要恢复本机时，请先停止云端服务，再设置 FATFISH_ALLOW_LOCAL=1。' >&2
  exit 1
fi
exec env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
  NODE_USE_ENV_PROXY=0 node --env-file-if-exists=.env.local src/main.mjs
