#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# Use a direct route for this QQ test only; leave the user's proxy settings intact.
exec env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  -u http_proxy -u https_proxy -u all_proxy NODE_USE_ENV_PROXY=0 \
  node --env-file="$project_root/.env.local" "$project_root/scripts/qq-smoke.mjs" "$@"
