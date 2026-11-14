#!/usr/bin/env bash
# One-time provisioning by the server owner. Does not start the bot or copy private data.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root' >&2; exit 1; }
bundle_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
archive=${1:?Pass the official node-v24.14.1-linux-x64.tar.xz archive}
public_key=${2:?Pass the dedicated GitHub deployment public-key file}
[[ $(uname -m) == x86_64 ]] || { echo 'This runtime is for x86_64 Linux' >&2; exit 1; }
expected=84d38715d449447117d05c3e71acd78daa49d5b1bfa8aacf610303920c3322be
[[ $(sha256sum "$archive" | cut -d ' ' -f1) == "$expected" ]] || { echo 'Node checksum mismatch' >&2; exit 1; }
grep -Eq '^ssh-ed25519 [A-Za-z0-9+/=]+( .*)?$' "$public_key"
id fatfish >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /var/lib/fatfish --shell /sbin/nologin fatfish
id fatfish-deploy >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/fatfish-deploy --shell /bin/bash fatfish-deploy
install -d -o root -g root -m 755 /opt/fatfish /opt/fatfish/releases /opt/fatfish/runtime /usr/local/lib/fatfish
if [[ ! -x /opt/fatfish/runtime/bin/node ]]; then
  tar -xJf "$archive" --strip-components=1 -C /opt/fatfish/runtime
fi
[[ $(/opt/fatfish/runtime/bin/node --version) == v24.14.1 ]]
install -d -o fatfish -g fatfish -m 700 /var/lib/fatfish
install -d -o root -g fatfish -m 750 /etc/fatfish
install -m 644 "$bundle_dir/unpack-release.py" /usr/local/lib/fatfish/unpack-release.py
install -m 755 "$bundle_dir/receive-release.sh" /usr/local/sbin/fatfish-deploy
install -m 644 "$bundle_dir/fatfish.service" /etc/systemd/system/fatfish.service
install -d -o root -g root -m 755 /var/lib/fatfish-deploy
install -d -o root -g root -m 755 /var/lib/fatfish-deploy/.ssh
{ printf 'restrict,command="sudo -n /usr/local/sbin/fatfish-deploy" '; cat "$public_key"; } > /var/lib/fatfish-deploy/.ssh/authorized_keys
chmod 644 /var/lib/fatfish-deploy/.ssh/authorized_keys
printf 'fatfish-deploy ALL=(root) NOPASSWD: /usr/local/sbin/fatfish-deploy ""\n' > /etc/sudoers.d/fatfish-deploy
chmod 440 /etc/sudoers.d/fatfish-deploy
visudo -cf /etc/sudoers.d/fatfish-deploy
systemd-analyze verify /etc/systemd/system/fatfish.service
systemctl daemon-reload
systemctl enable fatfish
echo 'Installed. Copy credentials and migrated data before the first deployment.'
