#!/usr/bin/env bash
# Owner-run installation for the existing BaoTa Nginx on warma.
# Uses a self-signed leaf certificate: clients must verify/trust it explicitly.
set -euo pipefail
umask 077
[[ $EUID -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
admin_ip=${1:?Usage: install-admin-https.sh PUBLIC_IPV4}
python3 -c 'import ipaddress,sys; assert ipaddress.ip_address(sys.argv[1]).version == 4' "$admin_ip"
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
nginx=/www/server/nginx/sbin/nginx
nginx_config=/www/server/panel/vhost/nginx/zz-fatfish-admin.conf
env_file=/etc/fatfish/fatfish.env
tls_dir=/etc/fatfish/tls
unit_override=/etc/systemd/system/nginx.service.d/fatfish-bt.conf
test -x "$nginx"
test -s "$env_file"
test -s "$source_dir/admin-nginx.conf"
test -s "$source_dir/admin-nginx-systemd.conf"
# Deploy the application proxy fix before publishing the listener.
grep -q 'ADMIN_TRUST_PROXY' /opt/fatfish/current/src/main.mjs
exec 9>/run/lock/fatfish-deploy.lock
flock -w 240 9

backup=$(mktemp -d /etc/fatfish/.https-backup.XXXXXXXX)
cp -p "$env_file" "$backup/env"
[[ ! -f $nginx_config ]] || cp -p "$nginx_config" "$backup/nginx.conf"
[[ ! -f $unit_override ]] || cp -p "$unit_override" "$backup/nginx-systemd.conf"
install -d -m 700 "$tls_dir"
for name in cert.pem privkey.pem; do
    [[ ! -f $tls_dir/$name ]] || cp -p "$tls_dir/$name" "$backup/$name"
done
changed=0
unit_changed=0
finish() {
    result=$?
    trap - EXIT
    if [[ $result -ne 0 && $changed -eq 1 ]]; then
        cp -p "$backup/env" "$env_file"
        if [[ -f $backup/nginx.conf ]]; then cp -p "$backup/nginx.conf" "$nginx_config"; else rm -f "$nginx_config"; fi
        for name in cert.pem privkey.pem; do
            if [[ -f $backup/$name ]]; then cp -p "$backup/$name" "$tls_dir/$name"; else rm -f "$tls_dir/$name"; fi
        done
        if [[ $unit_changed -eq 1 ]]; then
            if [[ -f $backup/nginx-systemd.conf ]]; then cp -p "$backup/nginx-systemd.conf" "$unit_override"; else rm -f "$unit_override"; fi
            systemctl daemon-reload || true
        fi
        "$nginx" -t && "$nginx" -s reload || true
        if ! test -s /www/server/nginx/logs/nginx.pid; then "$nginx" || true; fi
        systemctl restart fatfish || true
        echo "HTTPS installation failed; previous configuration restored. Backup: $backup" >&2
    fi
    exit "$result"
}
trap finish EXIT
trap 'exit 130' INT TERM HUP
changed=1

# Reuse the certificate unless close to expiry. Rotation changes its fingerprint.
if [[ ! -s $tls_dir/cert.pem || ! -s $tls_dir/privkey.pem ]] ||
   ! openssl x509 -in "$tls_dir/cert.pem" -checkend 2592000 -noout >/dev/null; then
    openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 365 \
        -subj "/CN=$admin_ip" \
        -addext "subjectAltName=IP:$admin_ip" \
        -addext 'basicConstraints=critical,CA:FALSE' \
        -addext 'keyUsage=critical,digitalSignature,keyEncipherment' \
        -addext 'extendedKeyUsage=serverAuth' \
        -keyout "$tls_dir/privkey.pem.next" -out "$tls_dir/cert.pem.next" 2>"$backup/openssl.log"
    chmod 600 "$tls_dir/privkey.pem.next"
    chmod 644 "$tls_dir/cert.pem.next"
    mv "$tls_dir/privkey.pem.next" "$tls_dir/privkey.pem"
    mv "$tls_dir/cert.pem.next" "$tls_dir/cert.pem"
fi
openssl x509 -in "$tls_dir/cert.pem" -checkip "$admin_ip" -noout
sed "s/__ADMIN_IP__/$admin_ip/g" "$source_dir/admin-nginx.conf" > "$nginx_config"
chmod 644 "$nginx_config"
"$nginx" -t

# The system RPM unit otherwise masks BaoTa's SysV startup entry. Adopt the
# existing installation so the HTTPS listener also returns after a reboot.
install -d -m 755 /etc/systemd/system/nginx.service.d
install -m 644 "$source_dir/admin-nginx-systemd.conf" "$unit_override"
unit_changed=1
systemctl daemon-reload
if ! systemctl is-active --quiet nginx; then
    if [[ -s /www/server/nginx/logs/nginx.pid ]]; then
        old_pid=$(cat /www/server/nginx/logs/nginx.pid)
        [[ $old_pid =~ ^[0-9]+$ ]] || exit 1
        [[ $(readlink "/proc/$old_pid/exe") == "$nginx" ]] || exit 1
        "$nginx" -s quit
        for attempt in $(seq 1 20); do
            if ! kill -0 "$old_pid" 2>/dev/null; then break; fi
            sleep 1
        done
        if kill -0 "$old_pid" 2>/dev/null; then echo 'Existing Nginx has not exited.' >&2; exit 1; fi
    fi
    systemctl start nginx
fi
systemctl enable nginx

python3 - "$env_file" "$admin_ip" <<'PY'
import os, re, sys
path, ip = sys.argv[1:]
stat = os.stat(path)
with open(path) as source:
    lines = [line for line in source if not re.match(r'^\s*(?:export\s+)?(?:ADMIN_ORIGIN|ADMIN_TRUST_PROXY|HOST|PORT)\s*=', line)]
content = ''.join(lines).rstrip('\n') + '\nHOST=127.0.0.1\nPORT=3210\nADMIN_ORIGIN=https://' + ip + '\nADMIN_TRUST_PROXY=1\n'
with open(path + '.next', 'w') as target:
    target.write(content)
os.chmod(path + '.next', stat.st_mode & 0o777)
os.chown(path + '.next', stat.st_uid, stat.st_gid)
os.replace(path + '.next', path)
PY
systemctl restart fatfish
healthy=0
for attempt in $(seq 1 40); do
    if curl -fsS --max-time 3 http://127.0.0.1:3210/api/health >/dev/null; then healthy=1; break; fi
    sleep 2
done
[[ $healthy -eq 1 ]] || { echo 'QQ health check failed.' >&2; exit 1; }
"$nginx" -s reload
for attempt in $(seq 1 10); do
    if curl --noproxy '*' --cacert "$tls_dir/cert.pem" \
        --resolve "$admin_ip:443:127.0.0.1" -fsS --max-time 5 \
        "https://$admin_ip/api/session" > "$backup/session-check.json"; then
        python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["authenticated"] is False and d["configured"] is True' "$backup/session-check.json"
        changed=0
        echo "HTTPS entry installed: https://$admin_ip/"
        openssl x509 -in "$tls_dir/cert.pem" -noout -fingerprint -sha256 -dates
        echo "Rollback files (root only): $backup"
        exit 0
    fi
    sleep 1
done
echo 'HTTPS listener check failed.' >&2
exit 1
