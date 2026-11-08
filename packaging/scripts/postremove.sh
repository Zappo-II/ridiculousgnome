#!/bin/sh
# SPDX-FileCopyrightText: 2026 Zappo-II
# SPDX-License-Identifier: GPL-2.0-or-later
# .deb/.rpm: after removal. Reloads systemd and D-Bus so the unit and the
# bus policy are gone; the system user rg-helper stays.
case "$1" in
    remove|purge|0) ;;
    *) exit 0 ;;
esac
[ -d /run/systemd/system ] || exit 0
systemctl daemon-reload || true
busctl call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus ReloadConfig >/dev/null || true
