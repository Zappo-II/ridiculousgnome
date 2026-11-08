#!/bin/sh
# SPDX-FileCopyrightText: 2026 Zappo-II
# SPDX-License-Identifier: GPL-2.0-or-later
# .deb/.rpm: after install and upgrade. Creates the user, reloads systemd
# and D-Bus and (re)starts the helper: a running extension asks for D-Bus
# activation only when it starts. Without a running systemd (chroot,
# container) only the user is created.
systemd-sysusers /usr/lib/sysusers.d/rg-helper.conf || true
[ -d /run/systemd/system ] || exit 0
systemctl daemon-reload || true
busctl call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus ReloadConfig >/dev/null || true
systemctl restart rg-helper.service || true
