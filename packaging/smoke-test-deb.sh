#!/usr/bin/env bash
# Smoke-test a built package in a clean Debian/Ubuntu container (no systemd: the instance tool
# starts the processes itself):
#
#   docker run --rm -v "$PWD":/src -w /src ubuntu:24.04 packaging/smoke-test-deb.sh dist/librowise_*.deb
set -Eeuo pipefail

DEB="${1:?usage: smoke-test-deb.sh path/to/librowise_VERSION_ARCH.deb}"
PORT="${SMOKE_PORT:-8800}"
NAME="demo"
step() { printf '\n==> %s\n' "$*"; }
trap 'echo "SMOKE TEST FAILED at line $LINENO" >&2; tail -n 50 /var/log/librowise/$NAME/*.log 2>/dev/null || true' ERR

step "Installing $DEB"
apt-get update -q >/dev/null
# Recommends (postgresql, caddy) are skipped: this exercises the minimal SQLite path.
DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends curl "$(realpath "$DEB")"
librowise --help >/dev/null
# Container images exclude /usr/share/man via dpkg path-exclude, so check the package itself.
CONTENTS="$(dpkg-deb -c "$DEB")"
grep -q './usr/share/man/man8/librowise-instance.8.gz' <<<"$CONTENTS"
grep -q './usr/share/man/man1/librowise.1.gz' <<<"$CONTENTS"
test -f /usr/lib/systemd/system/librowise-web@.service
id librowise

step "Creating instance $NAME (SQLite, no proxy, port $PORT)"
librowise instance create "$NAME" --db sqlite --no-proxy --port "$PORT" --no-start --admin-email admin@example.org
stat -c '%a %U:%G %n' "/etc/librowise/$NAME.env"
test "$(stat -c '%a %U:%G' "/etc/librowise/$NAME.env")" = "640 root:librowise"
librowise instance create "$NAME" --no-start >/dev/null  # idempotent re-run

step "Starting the web process"
librowise instance start "$NAME"
curl -fsS "http://127.0.0.1:$PORT/healthz"; echo
curl -fsS "http://127.0.0.1:$PORT/readyz"; echo
librowise instance list
librowise instance backup "$NAME"
librowise instance doctor "$NAME"

step "Removing the instance"
librowise instance remove "$NAME" --purge-data --yes
test ! -e "/var/lib/librowise/$NAME" && test ! -e "/etc/librowise/$NAME.env"
if curl -fsS -m 3 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    echo "web process still running after remove" >&2
    exit 1
fi

step "Removing and purging the package"
DEBIAN_FRONTEND=noninteractive apt-get remove -y -q librowise >/dev/null
test ! -e /opt/librowise/venv/bin/python && test -d /var/lib/librowise
DEBIAN_FRONTEND=noninteractive apt-get purge -y -q librowise >/dev/null
test ! -e /var/lib/librowise && test ! -e /etc/librowise
echo
echo "SMOKE TEST PASSED"
