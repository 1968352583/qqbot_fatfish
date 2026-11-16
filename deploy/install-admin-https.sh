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
stop_existing_nginx() {
    local pid
    [[ -s /www/server/nginx/logs/nginx.pid ]] || return 0
    read -r pid < /www/server/nginx/logs/nginx.pid
    [[ $pid =~ ^[0-9]+$ ]] || { echo 'Invalid Nginx PID file.' >&2; return 1; }
    kill -0 "$pid" 2>/dev/null || return 0
    [[ $(readlink "/proc/$pid/exe") == "$nginx" ]] || { echo 'Nginx PID belongs to another executable.' >&2; return 1; }
    kill -QUIT "$pid" || return 1
    for attempt in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || return 0
        sleep 1
    done
    # QUIT cannot be undone by reload. Finish the shutdown before another master
    # is started, including when this function is called from failure recovery.
    [[ $(readlink "/proc/$pid/exe") == "$nginx" ]] || return 0
    echo 'Nginx graceful shutdown timed out; ending existing connections.' >&2
    kill -TERM "$pid" || return 1
    for attempt in $(seq 1 10); do
        kill -0 "$pid" 2>/dev/null || return 0
        sleep 1
    done
    echo 'Existing Nginx is still running; refusing to start another master.' >&2
    return 1
}
adopt_nginx() {
    systemctl daemon-reload || return 1
    if ! systemctl is-active --quiet nginx; then
        stop_existing_nginx || return 1
        systemctl reset-failed nginx || return 1
        systemctl start nginx || return 1
    fi
    systemctl enable nginx || return 1
    systemctl is-active --quiet nginx
}
finish() {
    result=$?
    trap - EXIT
    if [[ $result -ne 0 && $changed -eq 1 ]]; then
        restored=1
        cp -p "$backup/env" "$env_file" || restored=0
        if [[ -f $backup/nginx.conf ]]; then cp -p "$backup/nginx.conf" "$nginx_config" || restored=0; else rm -f "$nginx_config" || restored=0; fi
        for name in cert.pem privkey.pem; do
            if [[ -f $backup/$name ]]; then cp -p "$backup/$name" "$tls_dir/$name" || restored=0; else rm -f "$tls_dir/$name" || restored=0; fi
        done
        if [[ $restored -eq 1 ]]; then
            if [[ $unit_changed -eq 1 ]]; then
                # Keep the corrected BaoTa unit: restoring the broken RPM unit
                # would leave restart/boot pointing at a different installation.
                "$nginx" -t && adopt_nginx && systemctl reload nginx && systemctl is-active --quiet nginx || restored=0
            else
                "$nginx" -t && "$nginx" -s reload || restored=0
            fi
            systemctl restart fatfish || restored=0
        fi
        if [[ $restored -eq 1 ]]; then
            echo "HTTPS installation failed; previous application/TLS/site configuration restored. Backup: $backup" >&2
            [[ $unit_changed -eq 0 ]] || echo 'BaoTa Nginx remains managed and enabled by the corrected systemd unit.' >&2
        else
            echo "HTTPS installation failed and automatic recovery is incomplete; inspect Nginx/fatfish before continuing. Backup: $backup" >&2
        fi
    fi
    exit "$result"
}
trap finish EXIT
trap 'exit 130' INT TERM HUP
changed=1

# Reuse the certificate unless close to expiry. Rotation changes its fingerprint.
constraints=0
if [[ -s $tls_dir/cert.pem ]]; then
    constraints=$(openssl x509 -in "$tls_dir/cert.pem" -noout -text | grep -c 'X509v3 Basic Constraints' || true)
fi
if [[ ! -s $tls_dir/cert.pem || ! -s $tls_dir/privkey.pem ]] ||
   [[ $constraints -ne 1 ]] ||
   ! openssl x509 -in "$tls_dir/cert.pem" -checkend 2592000 -noout >/dev/null; then
    # Use an isolated configuration: OpenSSL 1.1.1 can append -addext to the
    # system v3_ca section, producing duplicate and contradictory constraints.
    cat > "$backup/openssl.cnf" <<EOF
[req]
prompt = no
distinguished_name = subject
x509_extensions = server
[subject]
CN = $admin_ip
[server]
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
subjectAltName = IP:$admin_ip
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
EOF
    openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 365 \
        -config "$backup/openssl.cnf" \
        -keyout "$tls_dir/privkey.pem.next" -out "$tls_dir/cert.pem.next" 2>"$backup/openssl.log"
    openssl verify -CAfile "$tls_dir/cert.pem.next" "$tls_dir/cert.pem.next"
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
install -m 644 "$source_dir/admin-nginx-systemd.conf" "$unit_override.next"
mv "$unit_override.next" "$unit_override"
unit_changed=1
adopt_nginx

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
    if curl -fs --max-time 3 http://127.0.0.1:3210/api/health >/dev/null; then healthy=1; break; fi
    sleep 2
done
[[ $healthy -eq 1 ]] || { echo 'QQ health check failed.' >&2; exit 1; }
"$nginx" -s reload
for attempt in $(seq 1 10); do
    if curl --noproxy '*' --cacert "$tls_dir/cert.pem" \
        --resolve "$admin_ip:443:127.0.0.1" -fsS --max-time 5 \
        "https://$admin_ip/api/session" > "$backup/session-check.json" 2> "$backup/https-check.err"; then
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
cat "$backup/https-check.err" >&2
exit 1
