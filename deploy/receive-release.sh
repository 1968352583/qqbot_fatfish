#!/usr/bin/env bash
# Installed by the owner as a root-owned, forced SSH command. No arbitrary shell access.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 022
[[ $EUID -eq 0 ]] || exit 1
IFS= read -r revision
[[ $revision =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid commit ID' >&2; exit 1; }
root=/opt/fatfish
exec 9>/run/lock/fatfish-deploy.lock
flock -w 240 9
stage=$(mktemp -d "$root/.incoming.XXXXXXXX")
previous=$(readlink -f "$root/current" || true)
activated=0
healthy() {
  local expected=$1
  for attempt in $(seq 1 60); do
    if curl --fail --silent --max-time 3 http://127.0.0.1:3210/api/health |
      python3 -c 'import json,sys; data=json.load(sys.stdin); sys.exit(0 if data.get("ok") and data.get("release")==sys.argv[1] else 1)' "$expected" 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}
finish() {
  local result=$?
  trap - EXIT
  if [[ $result -ne 0 && $activated -eq 1 ]]; then
    systemctl stop fatfish || true
    if [[ -n $previous && -d $previous ]]; then
      ln -sfn "$previous" "$root/current.next"
      mv -Tf "$root/current.next" "$root/current"
      systemctl start fatfish || true
      if healthy "$(cat "$previous/RELEASE")"; then
        echo 'Deployment failed; previous release restored.' >&2
      else
        echo 'Deployment failed; previous code restored but QQ health needs inspection.' >&2
      fi
    else
      echo 'First deployment failed; service stopped for inspection.' >&2
    fi
  fi
  rm -rf -- "$stage"
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT TERM HUP
python3 /usr/local/lib/fatfish/unpack-release.py "$stage"
printf '%s\n' "$revision" > "$stage/RELEASE"
test -s /etc/fatfish/fatfish.env
test -s /var/lib/fatfish/fatfish.sqlite
chmod 755 "$stage"
runuser -u fatfish -- /opt/fatfish/runtime/bin/node --check "$stage/src/main.mjs"
release="$root/releases/$revision"
if [[ -d $release ]]; then
  diff -qr "$stage" "$release" >/dev/null || { echo 'Immutable release mismatch' >&2; exit 1; }
else
  mv "$stage" "$release"
fi
systemctl stop fatfish
activated=1
ln -sfn "$release" "$root/current.next"
mv -Tf "$root/current.next" "$root/current"
systemctl start fatfish
if ! healthy "$revision"; then
  echo 'New release did not establish a healthy QQ connection.' >&2
  exit 1
fi
activated=0
echo "Deployed $revision; HTTP and QQ gateway are healthy."
