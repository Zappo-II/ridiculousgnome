#!/bin/bash
# SPDX-FileCopyrightText: 2026 Zappo-II
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Run rg-helper on the host's system bus for development, e.g. together
# with gnome-extension/run-nested.sh. No VM, no system user, no permanent
# group change:
#
# - installs a development D-Bus policy (once) that lets *your* user own
#   the helper's name on the system bus,
# - runs the helper as your user with the input group for this one process
#   only (systemd-run SupplementaryGroups).
#
# Usage: helper/dev-run.sh [rg-helper args, e.g. --layout de]
#        helper/dev-run.sh --remove     remove the development policy again
#
# Stop the helper with Ctrl+C.
#
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
target="x86_64-unknown-linux-musl"
bin="${here}/target/${target}/release/rg-helper"
policy="/etc/dbus-1/system.d/io.github.zappoii.RidiculousGnome.Helper-dev.conf"

reload() {
    sudo busctl call org.freedesktop.DBus /org/freedesktop/DBus \
        org.freedesktop.DBus ReloadConfig
}

if [[ "${1:-}" == "--remove" ]]; then
    sudo rm -f "${policy}"
    reload
    echo "removed ${policy}"
    exit 0
fi

(cd "${here}" && cargo build --quiet --release --target "${target}")

if [[ ! -f "${policy}" ]]; then
    sed "s/user=\"rg-helper\"/user=\"${USER}\"/" \
        "${here}/dist/io.github.zappoii.RidiculousGnome.Helper.conf" |
        sudo tee "${policy}" >/dev/null
    reload
    echo "installed ${policy}"
fi

exec sudo systemd-run --quiet --pty --collect \
    --uid="${USER}" -p SupplementaryGroups=input \
    "${bin}" "$@"
