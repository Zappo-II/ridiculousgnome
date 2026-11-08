#!/bin/sh
# SPDX-FileCopyrightText: 2026 Zappo-II
# SPDX-License-Identifier: GPL-2.0-or-later
# Installs rg-helper system-wide, as root:
#   sudo ./install.sh              install, or update an existing install
#   sudo ./install.sh --uninstall  remove it again (the system user rg-helper stays)
#
# Works from the release tarball (binary next to this script) and from the
# checkout (helper/, after `make helper`); `make install` calls it too.
# Same variables as the Makefile: DESTDIR, PREFIX, LIBEXECDIR, BIN. With
# DESTDIR only the files are written (for packages), nothing is started.
# LIBEXECDIR must be /usr/libexec on SELinux systems (Fedora), see
# CONTRIBUTING.md, "Permissions and install locations".
set -eu

here=$(cd "$(dirname "$0")" && pwd)
bus_name=io.github.zappoii.RidiculousGnome.Helper

DESTDIR=${DESTDIR-}
PREFIX=${PREFIX:-/usr}
LIBEXECDIR=${LIBEXECDIR:-$PREFIX/libexec}
UNITDIR=${UNITDIR:-$PREFIX/lib/systemd/system}
SYSUSERSDIR=${SYSUSERSDIR:-$PREFIX/lib/sysusers.d}
DBUSDIR=${DBUSDIR:-$PREFIX/share/dbus-1}
SYSCONFDIR=${SYSCONFDIR:-/etc}
LICENSEDIR=${LICENSEDIR:-$PREFIX/share/licenses/rg-helper}

# Release tarball: helper/dist and the binary next to this script;
# checkout: dist/ next to it and cargo's output
dist=$here/helper/dist
[ -d "$dist" ] || dist=$here/dist
if [ -z "${BIN-}" ]; then
    for BIN in "$here/rg-helper" "$here/target/x86_64-unknown-linux-musl/release/rg-helper"; do
        [ -f "$BIN" ] && break
    done
fi

live() { [ -z "$DESTDIR" ]; }

reload() {
    systemctl daemon-reload
    busctl call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus ReloadConfig
}

do_install() {
    [ -f "$BIN" ] || { echo "no helper binary, run 'make helper' first (not as root)" >&2; exit 1; }
    install -Dm755 "$BIN" "$DESTDIR$LIBEXECDIR/rg-helper"
    mkdir -p "$DESTDIR$UNITDIR"
    sed "s|^ExecStart=[^ ]*|ExecStart=$LIBEXECDIR/rg-helper|" "$dist/rg-helper.service" \
        > "$DESTDIR$UNITDIR/rg-helper.service"
    chmod 644 "$DESTDIR$UNITDIR/rg-helper.service"
    install -Dm644 "$dist/rg-helper.sysusers.conf" "$DESTDIR$SYSUSERSDIR/rg-helper.conf"
    install -Dm644 "$dist/$bus_name.conf" "$DESTDIR$DBUSDIR/system.d/$bus_name.conf"
    install -Dm644 "$dist/$bus_name.service" "$DESTDIR$DBUSDIR/system-services/$bus_name.service"
    # License texts: the tarball has them next to this script
    for f in "$here"/LICENSE "$here"/THIRD-PARTY-*; do
        if [ -f "$f" ]; then install -Dm644 "$f" "$DESTDIR$LICENSEDIR/${f##*/}"; fi
    done
    # An existing config keeps its max-detail
    [ -e "$DESTDIR$SYSCONFDIR/rg-helper.conf" ] ||
        install -Dm644 "$dist/rg-helper.conf" "$DESTDIR$SYSCONFDIR/rg-helper.conf"
    live || return 0
    if command -v restorecon >/dev/null; then restorecon "$LIBEXECDIR/rg-helper"; fi
    systemd-sysusers "$SYSUSERSDIR/rg-helper.conf"
    reload
    # A running extension asks for D-Bus activation only when it starts,
    # so start the helper now instead of waiting for a re-login.
    systemctl restart rg-helper.service
}

do_uninstall() {
    if live; then systemctl stop rg-helper.service 2>/dev/null || true; fi
    rm -f "$DESTDIR$LIBEXECDIR/rg-helper" \
          "$DESTDIR$UNITDIR/rg-helper.service" \
          "$DESTDIR$SYSUSERSDIR/rg-helper.conf" \
          "$DESTDIR$DBUSDIR/system.d/$bus_name.conf" \
          "$DESTDIR$DBUSDIR/system-services/$bus_name.service" \
          "$DESTDIR$LICENSEDIR/LICENSE" "$DESTDIR$LICENSEDIR"/THIRD-PARTY-*
    rmdir "$DESTDIR$LICENSEDIR" 2>/dev/null || true
    # A changed config stays
    if cmp -s "$dist/rg-helper.conf" "$DESTDIR$SYSCONFDIR/rg-helper.conf"; then
        rm -f "$DESTDIR$SYSCONFDIR/rg-helper.conf"
    fi
    if live; then reload; fi
}

if live && [ "$(id -u)" -ne 0 ]; then
    echo "run as root: sudo $0 $*" >&2
    exit 1
fi

case "${1-}" in
    "") do_install ;;
    --uninstall) do_uninstall ;;
    *) echo "usage: $0 [--uninstall]" >&2; exit 2 ;;
esac
