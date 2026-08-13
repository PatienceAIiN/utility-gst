#!/usr/bin/env bash
# Deploy the landing page as a static site alongside the API.
#
# Runs ON the VM. The nginx vhost is backed up first and restored automatically
# if the config test fails, because this box serves five other production sites.
set -euo pipefail

VHOST=/etc/nginx/sites-enabled/patienceai.in
BACKUP="/root/patienceai.in.bak.$(date +%s)"

install -d -m 755 /var/www/utility
install -m 644 /tmp/utility-index.html /var/www/utility/index.html

cp "$VHOST" "$BACKUP"

if ! grep -q 'location /utility/' "$VHOST"; then
  python3 - "$VHOST" <<'PY'
import sys
path = sys.argv[1]
source = open(path).read()
block = '''
    # Utility landing page (static). no-cache so an admin push is picked up on
    # the next visit rather than after a browser cache expiry.
    location /utility/ {
        alias /var/www/utility/;
        index index.html;
        add_header Cache-Control "no-cache, must-revalidate";
    }
    location = /utility { return 301 /utility/; }
'''
anchor = source.index('location /utility-api/')
start = source.rindex('\n', 0, anchor)
open(path, 'w').write(source[:start] + block + source[start:])
print('landing location inserted')
PY
else
  echo 'landing location already present'
fi

if nginx -t 2>&1 | grep -q successful; then
  systemctl reload nginx
  echo 'nginx reloaded'
else
  echo 'NGINX CONFIG FAILED - restoring backup' >&2
  cp "$BACKUP" "$VHOST"
  nginx -t && systemctl reload nginx
  exit 1
fi

probe() { curl -s -o /dev/null -w "$1 HTTP %{http_code}\n" --max-time 8 -H 'Host: patienceai.in' "http://127.0.0.1$2"; }
probe '  landing   :' /utility/
probe '  api       :' /utility-api/healthz
probe '  main site :' /

sudo -u postgres psql -d utility -c \
  "delete from accounts where email='e2e-test@patienceai.in';" >/dev/null 2>&1 \
  && echo '  test account cleaned'
