#!/bin/bash
# SPDX-FileCopyrightText: 2026 Zappo-II
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Run the extension in a nested GNOME Shell (devkit window) without a VM.
#
# The nested shell gets its own XDG_DATA_HOME and XDG_CONFIG_HOME, so its
# dconf database and extension directory are separate from the host
# session: enabling the extension here never enables it on the host.
#
# Needs: mutter-devkit (Arch: `sudo pacman -S mutter-devkit`)
#
# Usage: ./run-nested.sh [MONITORS]   (default 1, e.g. 2 for multi-monitor)
#
# Without rg-helper on the system bus the extension runs in limited mode
# (type in the Activities overview); with helper/dev-run.sh it gets real
# input.
#
# Shell log output (console.log/console.error) goes to this terminal:
#   ./run-nested.sh 2>&1 | grep RidiculousGnome
#
set -euo pipefail

monitors="${1:-1}"
if ! [[ "${monitors}" =~ ^[1-9]$ ]]; then
    echo "Usage: $0 [MONITORS]  (1-9, default 1)" >&2
    exit 1
fi

# The devkit starts with one virtual monitor; each --add-monitor adds another
devkitArgs=""
for ((i = 1; i < monitors; i++)); do
    devkitArgs+=" --add-monitor"
done

uuid="RidiculousGnome@Zappo-II.github.io"
extSrc="$(cd "$(dirname "$0")" && pwd)/${uuid}"
sandbox="${XDG_RUNTIME_DIR:-/tmp}/ridiculousgnome-nested"

glib-compile-schemas "${extSrc}/schemas/"

# A fresh copy, not a symlink: removing the extension in the nested shell
# (an extension manager, gnome-extensions uninstall) deletes its directory,
# and through a symlink that would be the source in this repo
mkdir -p "${sandbox}/data/gnome-shell/extensions" "${sandbox}/config"
rm -rf "${sandbox}/data/gnome-shell/extensions/${uuid}"
cp -r "${extSrc}" "${sandbox}/data/gnome-shell/extensions/${uuid}"

# The host's touchpad and mouse settings (tap-to-click, click method,
# natural scrolling), so touchpad gestures show as they behave on the host
peripherals="$(dconf dump /org/gnome/desktop/peripherals/ 2>/dev/null || true)"

export XDG_DATA_HOME="${sandbox}/data"
export XDG_CONFIG_HOME="${sandbox}/config"

# The private bus cannot start systemd units, so the AT-SPI registry never
# comes up and GTK apps fail to register ("Could not activate remote peer
# 'org.a11y.atspi.Registry'"). Accessibility is not needed in here.
export GTK_A11Y=none
export NO_AT_BRIDGE=1

# dconf-service is started on the private bus and inherits the sandbox dirs.
# Event sounds start off here (only in the sandbox's dconf): any sound
# through the shell's sound player freezes the devkit picture after a while,
# ours as well as an app's bell, e.g. a text editor at the end of the
# document. To try sounds anyway:
# gsettings set org.gnome.desktop.sound event-sounds true (inside).
exec dbus-run-session -- bash -c '
    dconf write /org/gnome/shell/enabled-extensions "[\"$1\"]"
    dconf write /org/gnome/desktop/sound/event-sounds false
    [[ -n "$3" ]] && printf "%s\n" "$3" | dconf load /org/gnome/desktop/peripherals/
    exec gnome-shell --devkit ${2:+"--devkit-args=$2"} --wayland
' bash "${uuid}" "${devkitArgs}" "${peripherals}"
