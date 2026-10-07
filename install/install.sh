#!/usr/bin/env bash
# Librowise one-line installer for Ubuntu 22.04/24.04 and Debian 12/13 (amd64, arm64).
#
#   curl -fsSL https://raw.githubusercontent.com/librowise/librowise/main/install/install.sh \
#     | sudo bash -s -- --domain catalogue.example.org --email admin@example.org
#
# Installs PostgreSQL, Caddy (automatic HTTPS) and Librowise into /opt/librowise, then creates a
# first library instance with `librowise instance create`. Safe to re-run: every step checks what
# is already there. Run with --help for all options; docs/INSTALL.md explains the result.
set -Eeuo pipefail

# ---------------------------------------------------------------- constants
LIBROWISE_VERSION="v1.0.0"   # release installed by default (--version overrides)
PY_MODULE="shelfwise"        # Python package run with `python -m` (renamed together with the project)
DIST_NAME="shelfwise"        # pip distribution name
REPO_URL="https://github.com/librowise/librowise"
PREFIX="/opt/librowise"
VENV="$PREFIX/venv"
BIN_LINK="/usr/local/bin/librowise"
SERVICE_USER="librowise"
LOG_DIR="/var/log/librowise"
LOG_FILE="$LOG_DIR/install.log"
CADDY_KEYRING="/usr/share/keyrings/caddy-stable-archive-keyring.gpg"
PGDG_KEY="/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc"

# ---------------------------------------------------------------- options
DOMAIN=""
EMAIL=""
INSTANCE="library"
VERSION="$LIBROWISE_VERSION"
SOURCE=""
PROXY="caddy"
DB="postgres"
PORT=""
TIMEZONE=""
DEMO_DATA=0
ASSUME_YES=0
DRY_RUN=0
UNINSTALL=0
PURGE=0

usage() {
    cat <<EOF
Librowise installer for Ubuntu 22.04/24.04 and Debian 12/13.

Usage: install.sh --domain HOST [options]
       install.sh --no-proxy [--sqlite] [options]       # local / evaluation install
       install.sh --uninstall [--purge] [--yes]

Options:
  --domain HOST       Public host name of the catalogue (DNS must point here for HTTPS)
  --email ADDRESS     Administrator e-mail (also used for Let's Encrypt notices)
  --instance NAME     Instance name (default: $INSTANCE)
  --version TAG       Release to install from $REPO_URL (default: $LIBROWISE_VERSION)
  --source DIR        Install from a local source checkout instead of a release
  --no-proxy          Do not install/configure Caddy; the app listens on 127.0.0.1 only
  --nginx             Configure nginx instead of Caddy (HTTPS via certbot, see output)
  --sqlite            Use SQLite instead of PostgreSQL (small libraries, evaluation)
  --port PORT         Local port of the web server (default: first free from 8100)
  --timezone TZ       Library time zone, e.g. Asia/Kolkata (default: the server's)
  --demo-data         Load the demo catalogue and accounts (never for production)
  --yes               Do not ask for confirmation
  --dry-run           Show what would be done without changing anything
  --uninstall         Remove the application and services (data is kept)
  --purge             With --uninstall: also delete all instances' databases, data and backups
  -h, --help          Show this help
EOF
}

die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
info() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }

run() {
    if [[ $DRY_RUN -eq 1 ]]; then
        printf '  [dry-run] %s\n' "$*"
    else
        printf '  $ %s\n' "$*"
        "$@"
    fi
}

need_value() { [[ $# -ge 2 && -n $2 && $2 != --* ]] || die "$1 needs a value (see --help)"; }

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --*=*) set -- "${1%%=*}" "${1#*=}" "${@:2}"; continue ;;
            --domain) need_value "$@"; DOMAIN="$2"; shift ;;
            --email) need_value "$@"; EMAIL="$2"; shift ;;
            --instance) need_value "$@"; INSTANCE="$2"; shift ;;
            --version) need_value "$@"; VERSION="$2"; shift ;;
            --source) need_value "$@"; SOURCE="$2"; shift ;;
            --port) need_value "$@"; PORT="$2"; shift ;;
            --timezone) need_value "$@"; TIMEZONE="$2"; shift ;;
            --no-proxy) PROXY="none" ;;
            --nginx) PROXY="nginx" ;;
            --sqlite) DB="sqlite" ;;
            --demo-data) DEMO_DATA=1 ;;
            --yes | -y) ASSUME_YES=1 ;;
            --dry-run) DRY_RUN=1 ;;
            --uninstall) UNINSTALL=1 ;;
            --purge) PURGE=1 ;;
            -h | --help) usage; exit 0 ;;
            *) die "unknown option: $1 (see --help)" ;;
        esac
        shift
    done
    if [[ $UNINSTALL -eq 0 ]]; then
        [[ $PROXY == none || -n $DOMAIN ]] || die "--domain is required (or --no-proxy for a local-only install)"
        [[ $INSTANCE =~ ^[a-z][a-z0-9]*(-[a-z0-9]+)*$ && ${#INSTANCE} -le 30 ]] ||
            die "invalid --instance '$INSTANCE': lowercase letters, digits and single hyphens"
        [[ -z $PORT || $PORT =~ ^[0-9]+$ ]] || die "--port must be a number"
        [[ -z $SOURCE || -f $SOURCE/pyproject.toml ]] || die "--source $SOURCE is not a source checkout (no pyproject.toml)"
        [[ $VERSION =~ ^[A-Za-z0-9._/-]+$ ]] || die "invalid --version '$VERSION'"
    fi
    [[ $PURGE -eq 0 || $UNINSTALL -eq 1 ]] || die "--purge is only valid with --uninstall"
}

# ---------------------------------------------------------------- environment checks
OS_ID=""
OS_VERSION=""
OS_CODENAME=""
PYTHON=""
PG_FROM_PGDG=0

check_root() {
    if [[ $EUID -ne 0 ]]; then
        [[ $DRY_RUN -eq 1 ]] && { warn "not running as root; showing the plan only"; return; }
        die "run as root, e.g. curl -fsSL .../install.sh | sudo bash -s -- --domain ..."
    fi
}

detect_os() {
    [[ -r /etc/os-release ]] || die "cannot identify the operating system (/etc/os-release missing)"
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="${ID:-}"
    OS_VERSION="${VERSION_ID:-}"
    OS_CODENAME="${VERSION_CODENAME:-}"
    case "$OS_ID:$OS_VERSION" in
        ubuntu:22.04) PYTHON="python3.11"; PG_FROM_PGDG=1 ;;
        ubuntu:24.04) PYTHON="python3.12" ;;
        debian:12) PYTHON="python3.11"; PG_FROM_PGDG=1 ;;
        debian:13) PYTHON="python3.13" ;;
        *) die "unsupported system ${PRETTY_NAME:-$OS_ID $OS_VERSION}: Ubuntu 22.04/24.04 or Debian 12/13 required (see docs/INSTALL.md for manual installs)" ;;
    esac
    local arch
    arch="$(dpkg --print-architecture)"
    case "$arch" in
        amd64 | arm64) ;;
        *) die "unsupported architecture $arch (amd64 or arm64 required)" ;;
    esac
    info "System: ${PRETTY_NAME:-$OS_ID $OS_VERSION} ($arch), Python: $PYTHON"
}

start_logging() {
    exec 3>&1  # the terminal: credentials are printed here only, never into the log
    [[ $DRY_RUN -eq 1 || $EUID -ne 0 ]] && return
    mkdir -p "$LOG_DIR"
    chmod 0755 "$LOG_DIR"
    touch "$LOG_FILE"
    chmod 0640 "$LOG_FILE"
    exec > >(tee -a "$LOG_FILE") 2>&1
    printf '\n----- %s: install.sh %s\n' "$(date -Is)" "$ORIGINAL_ARGS"
}

on_error() {
    local code=$? line=$1
    printf '\nERROR: the installer stopped at line %s (exit %s). Details: %s\n' "$line" "$code" "$LOG_FILE" >&2
    printf 'Fix the problem and re-run the same command: completed steps are skipped.\n' >&2
}

confirm() {
    local prompt=$1 answer=""
    [[ $ASSUME_YES -eq 1 || $DRY_RUN -eq 1 ]] && return 0
    if ! { true </dev/tty; } 2>/dev/null; then
        return 0  # non-interactive (cloud-init, CI): the command line is the confirmation
    fi
    printf '%s [y/N] ' "$prompt" >&3
    read -r answer </dev/tty || true
    [[ $answer =~ ^[Yy]([Ee][Ss])?$ ]]
}

# ---------------------------------------------------------------- installation steps
apt_install() {
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
}

install_base_packages() {
    step "Installing system packages"
    run apt-get update -q
    apt_install ca-certificates curl gnupg git "$PYTHON" "$PYTHON-venv" util-linux passwd logrotate
}

install_postgres() {
    [[ $DB == postgres ]] || return 0
    step "Installing PostgreSQL"
    if [[ $PG_FROM_PGDG -eq 1 ]]; then
        # The release ships PostgreSQL < 16: use the PostgreSQL project's repository (17).
        if [[ ! -f /etc/apt/sources.list.d/pgdg.list ]]; then
            run install -d /usr/share/postgresql-common/pgdg
            run curl -fsSL -o "$PGDG_KEY" https://www.postgresql.org/media/keys/ACCC4CF8.asc
            if [[ $DRY_RUN -eq 0 ]]; then
                echo "deb [signed-by=$PGDG_KEY] https://apt.postgresql.org/pub/repos/apt $OS_CODENAME-pgdg main" \
                    >/etc/apt/sources.list.d/pgdg.list
            fi
            run apt-get update -q
        fi
        apt_install postgresql-17 postgresql-client-17
    else
        apt_install postgresql postgresql-client
    fi
    run systemctl enable --now postgresql
}

install_proxy() {
    case "$PROXY" in
        caddy)
            step "Installing Caddy (automatic HTTPS)"
            if [[ ! -f /etc/apt/sources.list.d/caddy-stable.list ]]; then
                apt_install debian-keyring debian-archive-keyring apt-transport-https
                if [[ $DRY_RUN -eq 1 ]]; then
                    run "curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o $CADDY_KEYRING"
                else
                    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o "$CADDY_KEYRING"
                    chmod 0644 "$CADDY_KEYRING"
                    echo "deb [signed-by=$CADDY_KEYRING] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" \
                        >/etc/apt/sources.list.d/caddy-stable.list
                fi
                run apt-get update -q
            fi
            apt_install caddy
            run systemctl enable --now caddy
            ;;
        nginx)
            step "Installing nginx"
            apt_install nginx
            run systemctl enable --now nginx
            ;;
        none) ;;
    esac
}

create_service_user() {
    step "Creating the $SERVICE_USER system account"
    if id -u "$SERVICE_USER" >/dev/null 2>&1; then
        info "  $SERVICE_USER already exists"
    else
        run useradd --system --user-group --home-dir /var/lib/librowise --no-create-home \
            --shell /usr/sbin/nologin --comment "Librowise ILS" "$SERVICE_USER"
    fi
}

install_app() {
    step "Installing Librowise into $VENV"
    if dpkg-query -W -f='${Status}' librowise 2>/dev/null | grep -q "install ok installed"; then
        die "the librowise Debian package is installed: upgrade it with apt, or remove it before using this installer"
    fi
    run install -d -m 0755 "$PREFIX"
    if [[ ! -x $VENV/bin/python ]]; then
        run "$PYTHON" -m venv "$VENV"
    fi
    run "$VENV/bin/python" -m pip install --quiet --upgrade --disable-pip-version-check pip wheel
    local spec
    if [[ -n $SOURCE ]]; then
        spec="$(cd "$SOURCE" && pwd)[postgres]"
    else
        spec="${DIST_NAME}[postgres] @ git+${REPO_URL}@${VERSION}"
    fi
    run "$VENV/bin/python" -m pip install --upgrade --disable-pip-version-check "$spec"
    run ln -sfn "$VENV/bin/librowise" "$BIN_LINK"
    if [[ $DRY_RUN -eq 0 ]]; then
        "$VENV/bin/python" -c "import $PY_MODULE, sys; print('  installed', $PY_MODULE.__version__, 'on Python', sys.version.split()[0])"
    fi
}

CRED_FILE=""
INSTANCE_ARGS=()

create_instance() {
    step "Creating instance '$INSTANCE'"
    INSTANCE_ARGS=(instance create "$INSTANCE")
    [[ -n $DOMAIN ]] && INSTANCE_ARGS+=(--domain "$DOMAIN")
    [[ -n $EMAIL ]] && INSTANCE_ARGS+=(--admin-email "$EMAIL")
    [[ -n $PORT ]] && INSTANCE_ARGS+=(--port "$PORT")
    [[ -n $TIMEZONE ]] && INSTANCE_ARGS+=(--timezone "$TIMEZONE")
    [[ $DB == sqlite ]] && INSTANCE_ARGS+=(--db sqlite)
    [[ $PROXY == none ]] && INSTANCE_ARGS+=(--no-proxy)
    [[ $PROXY == nginx ]] && INSTANCE_ARGS+=(--proxy nginx)
    [[ $DEMO_DATA -eq 1 ]] && INSTANCE_ARGS+=(--demo-data)
    if [[ $DRY_RUN -eq 1 ]]; then
        if [[ -x $BIN_LINK ]]; then
            "$BIN_LINK" "${INSTANCE_ARGS[@]}" --dry-run || true
        else
            run librowise "${INSTANCE_ARGS[@]}"
        fi
        return
    fi
    CRED_FILE="$(mktemp /root/.librowise-credentials.XXXXXX)"
    chmod 0600 "$CRED_FILE"
    run "$BIN_LINK" "${INSTANCE_ARGS[@]}" --credentials-file "$CRED_FILE"
}

open_firewall() {
    [[ $PROXY != none ]] || return 0
    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "^Status: active"; then
        step "Opening HTTP/HTTPS in the ufw firewall"
        run ufw allow 80/tcp
        run ufw allow 443/tcp
    fi
}

check_dns() {
    [[ -n $DOMAIN && $PROXY != none ]] || return 0
    if ! getent ahosts "$DOMAIN" >/dev/null 2>&1; then
        warn "$DOMAIN does not resolve yet. HTTPS certificates are issued once DNS points to this server."
    fi
}

summary() {
    local url user="" password=""
    url="$("$BIN_LINK" instance info "$INSTANCE" --json 2>/dev/null |
        "$VENV/bin/python" -c 'import json,sys; print(json.load(sys.stdin)["url"])' 2>/dev/null || true)"
    if [[ -n $CRED_FILE && -s $CRED_FILE ]]; then
        user="$(sed -n 's/^username=//p' "$CRED_FILE")"
        password="$(sed -n 's/^password=//p' "$CRED_FILE")"
    fi
    [[ -n $CRED_FILE ]] && rm -f "$CRED_FILE"
    {
        printf '\n'
        printf '============================================================\n'
        printf ' Librowise is installed.\n'
        printf '   Catalogue:  %s\n' "${url:-https://$DOMAIN}"
        printf '   Staff:      %s/staff\n' "${url:-https://$DOMAIN}"
        if [[ -n $password ]]; then
            printf '   Admin:      %s\n' "$user"
            printf '   Password:   %s   (shown once, not logged; change it after signing in)\n' "$password"
        else
            printf '   Admin:      unchanged (the instance already had an administrator)\n'
        fi
        printf '   Manage:     librowise instance --help   (status: librowise instance doctor %s)\n' "$INSTANCE"
        printf '   Log:        %s\n' "$LOG_FILE"
        printf '============================================================\n'
    } >&3
}

uninstall() {
    step "Uninstalling Librowise"
    local names=() name
    if [[ -x $BIN_LINK ]]; then
        mapfile -t names < <("$BIN_LINK" instance list --json 2>/dev/null |
            "$VENV/bin/python" -c 'import json,sys; print("\n".join(json.load(sys.stdin)))' 2>/dev/null || true)
    fi
    if [[ $PURGE -eq 1 ]]; then
        info "This deletes ${#names[@]} instance(s) with their databases, data and backups: ${names[*]:-none}"
        confirm "Permanently delete all Librowise data?" || die "aborted"
    fi
    for name in "${names[@]}"; do
        [[ -n $name ]] || continue
        if [[ $PURGE -eq 1 ]]; then
            run "$BIN_LINK" instance remove "$name" --purge-data --purge-backups --yes
        else
            run "$BIN_LINK" instance remove "$name"
        fi
    done
    local unit
    for unit in /etc/systemd/system/librowise-web@.service /etc/systemd/system/librowise-worker@.service \
        /etc/systemd/system/librowise-sip2@.service /etc/systemd/system/librowise@.target; do
        [[ -e $unit ]] && run rm -f "$unit"
    done
    command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]] && run systemctl daemon-reload
    [[ -L $BIN_LINK ]] && run rm -f "$BIN_LINK"
    [[ -d $PREFIX ]] && run rm -rf "$PREFIX"
    [[ -f /etc/logrotate.d/librowise ]] && run rm -f /etc/logrotate.d/librowise
    if [[ $PURGE -eq 1 ]]; then
        run rm -rf /etc/librowise /var/lib/librowise /var/backups/librowise /run/librowise
        id -u "$SERVICE_USER" >/dev/null 2>&1 && run userdel "$SERVICE_USER"
        info "Librowise and all its data were removed. PostgreSQL and Caddy/nginx are left installed."
        info "The install log is kept in $LOG_FILE."
    else
        info "Librowise was removed. Kept: /etc/librowise (configuration and secrets), /var/lib/librowise (data),"
        info "/var/backups/librowise (backups) and the PostgreSQL databases. Re-running the installer re-attaches"
        info "them; 'install.sh --uninstall --purge' deletes them."
    fi
}

main() {
    ORIGINAL_ARGS="$*"
    parse_args "$@"
    check_root
    start_logging
    trap 'on_error $LINENO' ERR
    if [[ $UNINSTALL -eq 1 ]]; then
        uninstall
        return
    fi
    detect_os
    info "Plan: instance '$INSTANCE', ${DB} database, proxy: ${PROXY}${DOMAIN:+, domain $DOMAIN}, version: ${SOURCE:-$VERSION}"
    confirm "Install Librowise now?" || die "aborted"
    check_dns
    install_base_packages
    install_postgres
    install_proxy
    create_service_user
    install_app
    create_instance
    open_firewall
    if [[ $DRY_RUN -eq 1 ]]; then
        printf '\nDry run finished: nothing was changed.\n'
        return
    fi
    summary
}

ORIGINAL_ARGS=""
main "$@"
