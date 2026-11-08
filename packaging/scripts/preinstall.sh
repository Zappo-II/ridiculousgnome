#!/bin/sh
# SPDX-FileCopyrightText: 2026 Zappo-II
# SPDX-License-Identifier: GPL-2.0-or-later
# .deb/.rpm: before unpacking. Creates the user before the bus policy that
# names it lands: dbus-daemon reloads on its own when the file appears and
# would log "Unknown username" otherwise. The sysusers file is not unpacked
# yet, hence its lines here; keep them in sync with
# helper/dist/rg-helper.sysusers.conf. postinstall.sh runs it again.
command -v systemd-sysusers >/dev/null || exit 0
systemd-sysusers --replace=/usr/lib/sysusers.d/rg-helper.conf - <<'EOF' || true
u rg-helper - "RidiculousGnome input helper" - -
m rg-helper input
EOF
