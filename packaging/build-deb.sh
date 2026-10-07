#!/usr/bin/env bash
# Build librowise_<version>_<arch>.deb with a self-contained Python environment in /opt/librowise.
#
#   packaging/build-deb.sh [--out DIR] [--python python3.12] [--revision 1] [--suffix ~noble]
#
# Run it on the Debian/Ubuntu release the package is for (the venv links to that release's
# Python), e.g. in a container:
#   docker run --rm -v "$PWD":/src -w /src ubuntu:24.04 bash -c \
#     'apt-get update -q && apt-get install -y -q python3-venv git && packaging/build-deb.sh'
# Only standard tools are used: python3 -m venv, pip, dpkg-deb, gzip.
set -Eeuo pipefail

PY_MODULE="librowise"   # Python package (renamed together with the project)
PKG="librowise"
PREFIX="/opt/$PKG"
VENV="$PREFIX/venv"
MAINTAINER="${DEB_MAINTAINER:-Librowise contributors <librowise@users.noreply.github.com>}"

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$SRC/dist"
PYTHON=""
REVISION="1"
SUFFIX=""
KEEP=0

die() { printf 'build-deb: %s\n' "$*" >&2; exit 1; }
log() { printf '==> %s\n' "$*"; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --out) OUT="$2"; shift ;;
        --python) PYTHON="$2"; shift ;;
        --revision) REVISION="$2"; shift ;;
        --suffix) SUFFIX="$2"; shift ;;
        --keep) KEEP=1 ;;
        -h | --help) sed -n '2,10p' "$0"; exit 0 ;;
        *) die "unknown option $1" ;;
    esac
    shift
done

command -v dpkg-deb >/dev/null || die "dpkg-deb not found (run this on Debian or Ubuntu)"
if [[ -z $PYTHON ]]; then
    for cand in python3 python3.13 python3.12 python3.11; do
        if command -v "$cand" >/dev/null &&
            "$cand" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
            PYTHON="$cand"
            break
        fi
    done
fi
[[ -n $PYTHON ]] || die "Python >= 3.11 not found (pass --python)"
PYVER="$("$PYTHON" -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')"
PY_DEP="python$PYVER"
# Create the venv from the versioned binary so it links to /usr/bin/pythonX.Y (package pythonX.Y,
# the declared dependency) rather than /usr/bin/python3, which belongs to another package.
PYTHON="$(command -v "python$PYVER")" || die "python$PYVER not found on PATH"
ARCH="$(dpkg --print-architecture)"
UPSTREAM="$("$PYTHON" - "$SRC/pyproject.toml" <<'EOF'
import sys, tomllib
print(tomllib.load(open(sys.argv[1], "rb"))["project"]["version"])
EOF
)"
VERSION="$UPSTREAM-$REVISION$SUFFIX"
DEB="$OUT/${PKG}_${VERSION}_${ARCH}.deb"
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$SRC" log -1 --format=%ct 2>/dev/null || date +%s)}"

WORK="$(mktemp -d)"
STAGE="$WORK/root"
cleanup() {
    if [[ $KEEP -eq 1 ]]; then echo "staging kept in $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

log "Building $PKG $VERSION for $ARCH with Python $PYVER"
mkdir -p "$STAGE$PREFIX" "$OUT"

log "Creating the virtual environment"
"$PYTHON" -m venv "$STAGE$VENV"
"$STAGE$VENV/bin/python" -m pip install --quiet --no-cache-dir --disable-pip-version-check --upgrade pip wheel
# Build from a clean copy so local build/ and *.egg-info directories never leak into the package.
mkdir -p "$WORK/src"
tar -C "$SRC" --exclude=.git --exclude=.venv --exclude=dist --exclude=build --exclude='*.egg-info' \
    --exclude=.claude --exclude=node_modules -cf - pyproject.toml README.md LICENSE "$PY_MODULE" |
    tar -C "$WORK/src" -xf -
"$STAGE$VENV/bin/python" -m pip install --quiet --no-cache-dir --no-compile --disable-pip-version-check \
    "$WORK/src[postgres]"
"$STAGE$VENV/bin/python" -m pip uninstall --quiet --yes wheel
"$STAGE$VENV/bin/python" -c "import $PY_MODULE; print('    application', $PY_MODULE.__version__)"
target="$(readlink -f "$STAGE$VENV/bin/python")"
[[ $target == "/usr/bin/python$PYVER" ]] || die "venv interpreter resolves to $target, expected /usr/bin/python$PYVER"

log "Generating systemd units, logrotate configuration and man pages"
mkdir -p "$STAGE/usr/lib/systemd/system" "$STAGE/etc/logrotate.d" "$STAGE/usr/share/man"
"$STAGE$VENV/bin/python" - "$STAGE" "$VENV/bin/python" <<EOF
import sys
from pathlib import Path
from $PY_MODULE.instances.common import Layout
from $PY_MODULE.instances.render import render_logrotate, render_units

stage, python = Path(sys.argv[1]), sys.argv[2]
layout = Layout.for_system("/")
for name, text in render_units(python, layout).items():
    (stage / "usr/lib/systemd/system" / name).write_text(text, encoding="utf-8")
(stage / "etc/logrotate.d/$PKG").write_text(render_logrotate(layout), encoding="utf-8")
EOF
"$STAGE$VENV/bin/python" "$SRC/packaging/gen-manpages.py" "$STAGE/usr/share/man" --version "$UPSTREAM" >/dev/null
find "$STAGE/usr/share/man" -type f -exec gzip -9n {} +

log "Relocating the environment to $VENV"
# Scripts (shebangs, activate*) and pyvenv.cfg carry the staging path: point them at the final one.
grep -rlI --null -F "$STAGE$VENV" "$STAGE$VENV/bin" "$STAGE$VENV/pyvenv.cfg" |
    xargs -0 -r sed -i "s|$STAGE$VENV|$VENV|g"
find "$STAGE$VENV" -name direct_url.json -delete
find "$STAGE$VENV" -name RECORD -path '*.dist-info/*' -exec sed -i "s|$STAGE||g" {} +
leftover="$(grep -rIl -F "$STAGE" "$STAGE$PREFIX" || true)"
[[ -z $leftover ]] || die "staging path still referenced in: ${leftover//$'
'/ }"
# Byte-code compiled once, with paths as installed; unchecked-hash .pyc stay valid regardless of mtimes.
find "$STAGE$VENV" -type d -name __pycache__ -prune -exec rm -rf {} +
"$STAGE$VENV/bin/python" -m compileall -q -j0 --invalidation-mode unchecked-hash -s "$STAGE" -p / \
    "$STAGE$VENV/lib" >/dev/null
touch "$STAGE$PREFIX/.installed-by-dpkg"

log "Adding the command, documentation and metadata"
mkdir -p "$STAGE/usr/bin" "$STAGE/usr/share/doc/$PKG" "$STAGE/usr/share/lintian/overrides" "$STAGE/DEBIAN"
ln -s "$VENV/bin/$PKG" "$STAGE/usr/bin/$PKG"
install -m 0644 "$SRC/packaging/debian/copyright" "$STAGE/usr/share/doc/$PKG/copyright"
for doc in README.md docs/INSTALL.md docs/DEPLOYMENT.md; do
    [[ -f $SRC/$doc ]] && gzip -9nc "$SRC/$doc" >"$STAGE/usr/share/doc/$PKG/$(basename "$doc").gz"
done
{
    printf '%s (%s) unstable; urgency=medium\n\n' "$PKG" "$VERSION"
    printf '  * Upstream release %s. See %s/releases.\n\n' "$UPSTREAM" "https://github.com/librowise/librowise"
    printf ' -- %s  %s\n' "$MAINTAINER" "$(date -R -u -d "@$SOURCE_DATE_EPOCH")"
} | gzip -9n >"$STAGE/usr/share/doc/$PKG/changelog.Debian.gz"
install -m 0644 "$SRC/packaging/debian/lintian-overrides" "$STAGE/usr/share/lintian/overrides/$PKG"
for script in postinst prerm postrm; do
    install -m 0755 "$SRC/packaging/debian/$script" "$STAGE/DEBIAN/$script"
done
printf '/etc/logrotate.d/%s\n' "$PKG" >"$STAGE/DEBIAN/conffiles"

# Normalise permissions: directories 0755, files 0644 unless executable.
find "$STAGE" -path "$STAGE/DEBIAN" -prune -o -type d -exec chmod 0755 {} +
find "$STAGE" -path "$STAGE/DEBIAN" -prune -o -type f -perm /111 -exec chmod 0755 {} + -o -type f -exec chmod 0644 {} +
find "$STAGE$VENV" -type f -name '*.so*' -exec chmod 0644 {} +  # shared libraries are not programs
# Wheels sometimes carry a stray executable bit on data/module files: keep it on scripts and ELF programs only.
"$PYTHON" - "$STAGE$VENV/lib" <<'EOF'
import os, stat, sys
for root, _, files in os.walk(sys.argv[1]):
    for name in files:
        path = os.path.join(root, name)
        mode = os.lstat(path).st_mode
        if stat.S_ISREG(mode) and mode & 0o111 and ".so" not in name:
            with open(path, "rb") as fh:
                head = fh.read(4)
            if not (head.startswith(b"#!") or head == b"\x7fELF"):
                os.chmod(path, 0o644)
EOF

INSTALLED_SIZE="$(du -sk --exclude=DEBIAN "$STAGE" | cut -f1)"
sed -e "s|@VERSION@|$VERSION|" -e "s|@ARCH@|$ARCH|" -e "s|@MAINTAINER@|$MAINTAINER|" \
    -e "s|@INSTALLED_SIZE@|$INSTALLED_SIZE|" -e "s|@PYTHON@|$PY_DEP|" \
    "$SRC/packaging/debian/control.in" >"$STAGE/DEBIAN/control"
(cd "$STAGE" && find . -path ./DEBIAN -prune -o -type f -printf '%P\0' | LC_ALL=C sort -z |
    xargs -0 md5sum) >"$STAGE/DEBIAN/md5sums"

log "Packing $DEB"
find "$STAGE" -newermt "@$SOURCE_DATE_EPOCH" -print0 | xargs -0 -r touch --no-dereference --date="@$SOURCE_DATE_EPOCH"
dpkg-deb --root-owner-group -Zxz --build "$STAGE" "$DEB" >/dev/null
dpkg-deb --info "$DEB" | sed -n '/Package:/,/Description:/p'
ls -l "$DEB"
