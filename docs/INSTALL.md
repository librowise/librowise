# Installing Librowise

| You want… | Use | Time |
|---|---|---|
| A production library on a fresh Ubuntu/Debian server | [the one-line installer](#install-in-5-minutes) | 5 minutes |
| Packages managed by apt, no internet access at install time | [the Debian package](#debian-package) | 5 minutes |
| Containers / Kubernetes | [Docker](#docker) | 5 minutes |
| To try it on a Windows PC | [Windows evaluation](#windows-evaluation) | 3 minutes |
| Full control (other distributions, existing PostgreSQL, custom layout) | [manual installation](#manual-and-advanced-installation) | 20 minutes |

Every path ends in the same model, borrowed from Koha: one machine runs any number of
**instances** (one per library or consortium member), each with its own database, settings,
processes, backups and web address, all managed with `librowise instance …`
(see [the Koha command map](#managing-instances)).

---

## Install in 5 minutes

Requirements: Ubuntu 22.04 or 24.04, or Debian 12 or 13 (amd64 or arm64), 2 GB RAM, root access,
and a DNS name pointing at the server (for HTTPS). Ports 80 and 443 must be reachable.

```bash
curl -fsSL https://raw.githubusercontent.com/librowise/librowise/main/install/install.sh \
  | sudo bash -s -- --domain catalogue.example.org --email admin@example.org
```

The installer:

1. checks the OS and architecture and installs `git`, Python (3.11–3.13, from the distribution),
   PostgreSQL 16/17 (the distribution's, or the PostgreSQL project's repository on releases that
   ship an older one) and Caddy from Caddy's official apt repository;
2. creates the `librowise` system account and a Python environment in `/opt/librowise/venv`
   with the pinned release (or `--version vX.Y.Z`, or `--source DIR` for a checkout), and links
   `/usr/local/bin/librowise`;
3. runs `librowise instance create library --domain … --admin-email …`, which creates the
   PostgreSQL role and database, `/etc/librowise/library.env` with generated secrets, the systemd
   services, the Caddy site (Let's Encrypt certificate obtained automatically), log rotation,
   nightly backups and the first administrator;
4. opens ports 80/443 if `ufw` is active and prints the address and the administrator's one-time
   password. The password is shown on the terminal only — never written to the log
   (`/var/log/librowise/install.log`).

Options: `--instance NAME`, `--version TAG`, `--source DIR`, `--no-proxy` (no Caddy; the app
listens on 127.0.0.1 only), `--nginx` (nginx instead of Caddy, HTTPS via certbot), `--sqlite`,
`--port`, `--timezone`, `--demo-data`, `--yes`, `--dry-run` (print the plan), `--uninstall`.
Re-running the installer is safe: finished steps are skipped and the instance is repaired, not
recreated.

## Debian package

Release pages carry `librowise_<version>-1~<codename>_<arch>.deb` for Ubuntu 22.04 (jammy) and
24.04 (noble) and Debian 12 (bookworm) and 13 (trixie). The package contains the application and
all Python dependencies in `/opt/librowise/venv`, the `librowise` command, systemd template
units and man pages (`man librowise`, `man librowise-instance`).

```bash
sudo apt install ./librowise_1.1.0-1~noble_amd64.deb
sudo apt install postgresql caddy           # recommended, not required
sudo librowise instance create library --domain catalogue.example.org --admin-email admin@example.org
```

Installing the package creates the `librowise` account and directories but no instance — like
`koha-common`, you then run `librowise instance create`. Upgrading the package (`apt install` of a
newer .deb) backs up, migrates and restarts every instance automatically. `apt remove` stops the
services and keeps all data; `apt purge` also deletes `/etc/librowise`, `/var/lib/librowise` and
`/var/log/librowise` (backups in `/var/backups/librowise` and the PostgreSQL databases are kept
and listed).

Build it yourself on the target release (only `python3-venv`, `dpkg-deb` and `gzip` are used):

```bash
docker run --rm -v "$PWD":/src -w /src ubuntu:24.04 bash -c \
  'apt-get update && apt-get install -y python3-venv git && packaging/build-deb.sh'
docker run --rm -v "$PWD":/src -w /src ubuntu:24.04 packaging/smoke-test-deb.sh dist/librowise_*.deb
```

## Docker

The image `ghcr.io/librowise/librowise` (amd64 and arm64) runs the web app or, with
`python -m librowise worker`, the background worker. [`docker-compose.yml`](../docker-compose.yml)
is a complete stack with PostgreSQL:

```bash
export LIBROWISE_SECRET_KEY=$(python3 -c "import secrets;print(secrets.token_urlsafe(64))")
docker compose up -d
docker compose run --rm app python -m librowise create-admin --username admin --email admin@example.org
```

Put a TLS proxy in front of port 8000; [DEPLOYMENT.md](DEPLOYMENT.md) covers configuration,
scaling and observability. The `instance` commands are not used with containers: the compose file
plays their role.

## Windows evaluation

For trying Librowise on Windows 10/11 (SQLite, this computer only — use Linux for production):

```powershell
irm https://raw.githubusercontent.com/librowise/librowise/main/install/install.ps1 | iex
```

The script finds Python 3.11+ (or offers to install Python 3.12 with `winget`), creates
`%LOCALAPPDATA%\Librowise\venv`, installs the release, creates a `demo` instance with
`librowise instance create demo --db sqlite --no-proxy`, starts it and opens the browser. To pass
options, download it first:

```powershell
irm https://raw.githubusercontent.com/librowise/librowise/main/install/install.ps1 -OutFile install.ps1
powershell -ExecutionPolicy Bypass -File install.ps1 -Instance demo -DemoData -Port 8100
powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall            # add -Purge to delete data
```

Manage it with `%LOCALAPPDATA%\Librowise\librowise.cmd instance start|stop|list|doctor demo`.
On Windows the instance tool starts the web and worker processes itself (there is no systemd);
PostgreSQL creation and reverse-proxy options are Linux-only and are refused with a clear message
(`--db-url` to an existing database works). To start an instance at logon, create a scheduled task:

```powershell
$cmd = "$env:LOCALAPPDATA\Librowise\librowise.cmd"
schtasks /Create /SC ONLOGON /TN "Librowise demo" /TR "`"$cmd`" instance start demo"
```

or wrap `librowise.cmd instance serve demo` and `… serve demo worker` as two Windows services with
[NSSM](https://nssm.cc/) (`nssm install LibrowiseDemoWeb "%LOCALAPPDATA%\Librowise\librowise.cmd" instance serve demo`).

## Manual and advanced installation

Any Linux with Python 3.11+ and PostgreSQL 14+ works:

```bash
sudo useradd --system --user-group --home-dir /var/lib/librowise --shell /usr/sbin/nologin librowise
sudo python3 -m venv /opt/librowise/venv
sudo /opt/librowise/venv/bin/pip install "librowise[postgres] @ git+https://github.com/librowise/librowise@v1.1.0"
sudo ln -s /opt/librowise/venv/bin/librowise /usr/local/bin/librowise
sudo librowise instance create library --domain catalogue.example.org --dry-run   # review the plan
sudo librowise instance create library --domain catalogue.example.org
```

Variations:

* **Existing or remote PostgreSQL**: `--db-url postgresql+psycopg://user:pass@db.internal/library`
  (nothing is created; the role needs to own the database).
* **nginx**: `--proxy nginx`, then `sudo certbot --nginx -d catalogue.example.org`, set
  `LIBROWISE_COOKIE_SECURE=true` and `LIBROWISE_PUBLIC_URL=https://…` in the env file and restart.
  Sites edited by certbot are never overwritten.
* **Your own proxy or load balancer**: `--no-proxy --domain catalogue.example.org` and proxy to the
  printed local port. Set `--bind 0.0.0.0` only on a private network.
* **Without root** (any OS): `librowise instance create NAME --db sqlite --no-proxy` keeps
  everything under `~/.local/share/librowise` (`LIBROWISE_HOME` overrides it).

Files of a system instance `NAME`:

| Path | Contents |
|---|---|
| `/etc/librowise/NAME.env` | all settings and secrets (`root:librowise`, 0640); edit, then `instance restart` |
| `/etc/librowise/instances.json` | registry: names, ports, domains, proxy, database kind |
| `/var/lib/librowise/NAME` | data (SQLite database, search-index cache) |
| `/var/backups/librowise/NAME` | nightly backups (14 kept) with SHA-256 manifests |
| `/var/log/librowise/NAME/{web,worker,sip2}.log` | process logs, rotated weekly |
| `librowise-web@NAME`, `librowise-worker@NAME`, `librowise-sip2@NAME`, `librowise@NAME.target` | systemd units |
| `/etc/caddy/librowise.d/NAME.caddy` or `/etc/nginx/sites-available/librowise-NAME.conf` | proxy site |

---

## Managing instances

| Koha | Librowise | Notes |
|---|---|---|
| `koha-create --create-db NAME` | `librowise instance create NAME --domain D` | database, env file, services, HTTPS proxy, first admin; `--dry-run` shows every step |
| `koha-list` | `librowise instance list` | `--json` for scripts; `instance info NAME` for one instance |
| `koha-remove NAME` | `librowise instance remove NAME` | keeps data; `--purge-data` drops the database and files (backups kept unless `--purge-backups`) |
| `koha-upgrade-schema NAME` | `librowise instance upgrade NAME` / `--all` | backup → `migrate` → restart; `--version vX.Y.Z` first upgrades the application |
| `koha-run-backups` | `librowise instance backup --all` | nightly backups also run inside each instance's worker |
| `koha-plack --start/--stop/--restart NAME` | `librowise instance start/stop/restart NAME` | web, worker and (if enabled) SIP2 |
| `koha-sip --enable/--start NAME` | `librowise instance enable NAME --sip2` | SIP2 port is in the env file (`LIBROWISE_SIP2_PORT`) |
| `koha-worker --start NAME` | `librowise instance start NAME` | the worker is part of every instance |
| `koha-enable / koha-disable NAME` | `librowise instance enable / disable NAME` | start at boot or not |
| `koha-shell NAME` | `librowise instance shell NAME [-- COMMAND]` | e.g. `-- create-admin --username jdoe --email …`, `-- reindex`, `-- jobs list` |
| `koha-email-enable` | edit `LIBROWISE_EMAIL_BACKEND=smtp` and `SMTP_*` in the env file | then `instance restart` |
| — | `librowise instance doctor NAME` | database, migration head, processes, ports, /readyz, TLS expiry, disk, backups |
| — | `librowise instance serve NAME [web|worker|sip2]` | one process in the foreground (debugging, containers) |

## Upgrades and rollback

* **Installer installs**: `sudo librowise instance upgrade --all --version v1.2.0` installs the
  release into `/opt/librowise/venv`, then for each instance takes a backup, runs the migrations
  and restarts the services.
* **Debian package**: `sudo apt install ./librowise_1.2.0-1~noble_amd64.deb` — the package's
  post-install step runs `librowise instance upgrade --all`.
* **Docker**: pull the new tag and run `python -m librowise migrate` before starting the app.

**Rollback**: migrations only move forward, so roll back by reinstalling the previous release and
restoring the backup that `instance upgrade` took just before migrating:

```bash
sudo librowise instance stop library
sudo /opt/librowise/venv/bin/pip install "librowise[postgres] @ git+https://github.com/librowise/librowise@v1.1.0"
#   (package installs: apt install ./librowise_1.1.0-1~noble_amd64.deb — its automatic schema
#    upgrade reports a failure because the database is newer; that is expected here)
ls -t /var/backups/librowise/library/ | head -3                    # the pre-upgrade backup
sudo librowise instance shell library -- restore /var/backups/librowise/library/librowise-YYYYMMDD-HHMMSS.dump --yes
sudo librowise instance start library
```

## Backups and restore

* Every instance's worker runs a nightly backup at 01:15 (library time) into
  `/var/backups/librowise/NAME`: `pg_dump --format=custom` for PostgreSQL, the SQLite online
  backup API otherwise, each with a SHA-256 manifest; the newest 14 are kept
  (`LIBROWISE_BACKUP_KEEP`). Change the time in `LIBROWISE_SCHEDULES`.
* On demand: `librowise instance backup NAME` (or `--all`).
* List / verify: `librowise instance shell NAME -- backup --list` and `… -- backup --verify FILE`.
* Restore: `librowise instance stop NAME`, then
  `librowise instance shell NAME -- restore FILE --yes`, then `librowise instance start NAME`.
* Copy `/var/backups/librowise` **and** `/etc/librowise` (it holds the secret key) off the
  machine. See [DEPLOYMENT.md](DEPLOYMENT.md#backups) for point-in-time recovery.

## Uninstall

| Installed with | Remove the software, keep data | Remove everything |
|---|---|---|
| `install.sh` | `sudo bash install.sh --uninstall` | `sudo bash install.sh --uninstall --purge` |
| Debian package | `sudo apt remove librowise` | `sudo apt purge librowise`, then drop the databases it lists |
| Windows | `install.ps1 -Uninstall` | `install.ps1 -Uninstall -Purge` |
| one instance | `librowise instance remove NAME` | `librowise instance remove NAME --purge-data --purge-backups` |

PostgreSQL and Caddy/nginx are left installed.

## Troubleshooting

Start with `sudo librowise instance doctor NAME`; it names the failing piece and the command to fix it.

| Symptom | Check / fix |
|---|---|
| Browser shows a certificate error or "connection refused" | DNS must point to the server and ports 80/443 be open (`ufw status`, cloud firewall). `journalctl -u caddy -n 50` shows ACME errors. |
| `502 Bad Gateway` | the web process is down: `systemctl status librowise-web@NAME`, `/var/log/librowise/NAME/web.log` |
| "Database is not initialised" / doctor says schema behind | `sudo librowise instance upgrade NAME` |
| Port already in use | pick another with `--port`, or see `ss -ltnp` |
| `/readyz` returns 503 with `worker` | `systemctl status librowise-worker@NAME`; schedules (notices, backups) need the worker |
| Sign-in loops on plain HTTP | `LIBROWISE_COOKIE_SECURE=true` requires HTTPS; set it to `false` only for `--no-proxy` test installs |
| Lost the administrator password | `sudo librowise instance shell NAME -- create-admin --username admin2 --email you@example.org` creates another administrator; `-- reset-2fa --username admin` clears a lockout or lost 2FA device |
| E-mails are not sent | set `LIBROWISE_EMAIL_BACKEND=smtp` and `LIBROWISE_SMTP_*` in the env file; `instance shell NAME -- send-notices` shows delivery errors |
| Installer failed half way | read `/var/log/librowise/install.log`, fix the cause, re-run the same command |
| Windows: `instance start` reports the web did not answer | `%LOCALAPPDATA%\Librowise\log\NAME\web.log`; another program may use the port |
