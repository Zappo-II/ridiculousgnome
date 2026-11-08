#!/bin/sh
# SPDX-FileCopyrightText: 2026 Zappo-II
# SPDX-License-Identifier: GPL-2.0-or-later
# .deb/.rpm: before removal. Stops the helper only when the package goes
# away (deb: "remove", rpm: 0 packages left), not on upgrade.
case "$1" in
    remove|0) [ -d /run/systemd/system ] && systemctl stop rg-helper.service || true ;;
esac
