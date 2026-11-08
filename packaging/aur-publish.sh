#!/bin/sh
# SPDX-FileCopyrightText: 2026 Zappo-II
# SPDX-License-Identifier: GPL-2.0-or-later
# Publish packaging/arch to the AUR package rg-helper-bin, after `make release`:
#   make aur-publish         copy PKGBUILD, .SRCINFO and the install file into
#                            the AUR checkout, test-build from the GitHub
#                            release, commit and push
#   make aur-publish-check   the same up to the test build, then shows the
#                            changes and undoes them
# AUR_DIR is the AUR git checkout (default ../aur-rg-helper-bin next to this
# repo; cloned when missing). Needs an AUR account with this machine's ssh
# key: `ssh aur@aur.archlinux.org help` must answer.
set -eu

dry_run=false
if [ "${1-}" = --dry-run ]; then dry_run=true; shift; fi
cd "$(dirname "$0")/.."
repo=$(pwd)
src=$repo/packaging/arch
aur=${AUR_DIR:-$repo/../aur-rg-helper-bin}
files="PKGBUILD .SRCINFO rg-helper-bin.install"

die() { echo "aur-publish: $*" >&2; exit 1; }

for tool in git makepkg; do
    command -v $tool >/dev/null || die "$tool not installed"
done

# The AUR gets what is committed and pushed here, for a released version
[ -z "$(git status --porcelain -- packaging/arch)" ] || die "packaging/arch has uncommitted changes"
pkgver=$(sed -n 's/^pkgver=//p' "$src/PKGBUILD")
pkgrel=$(sed -n 's/^pkgrel=//p' "$src/PKGBUILD")
[ "$pkgver" != 0.0.0 ] || die "no release yet (pkgver 0.0.0); run make release first"
git rev-parse -q --verify "refs/tags/v$pkgver" >/dev/null || die "no tag v$pkgver here; run make release first"
git fetch -q origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main differs from origin/main"

if [ ! -d "$aur/.git" ]; then
    echo "cloning the AUR repository into $aur"
    git clone -q ssh://aur@aur.archlinux.org/rg-helper-bin.git "$aur"
fi
[ -z "$(git -C "$aur" status --porcelain)" ] || die "$aur has uncommitted changes"
# A new, empty AUR repository has nothing to pull yet
if git -C "$aur" rev-parse -q --verify HEAD >/dev/null; then git -C "$aur" pull -q --ff-only; fi

for f in $files; do cp -f "$src/$f" "$aur/$f"; done
if [ -z "$(git -C "$aur" status --porcelain)" ]; then
    echo "aur-publish: the AUR already has rg-helper-bin $pkgver-$pkgrel"
    exit 0
fi

# Test build from the real release download, outside both checkouts
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for f in $files; do cp -f "$aur/$f" "$tmp/$f"; done
(cd "$tmp" && makepkg -f >makepkg.log 2>&1) || { tail -20 "$tmp/makepkg.log" >&2; die "test build failed"; }
(cd "$tmp" && makepkg --printsrcinfo) | cmp -s - "$tmp/.SRCINFO" || die ".SRCINFO does not match PKGBUILD (make aur)"
if command -v namcap >/dev/null; then
    lint=$(namcap "$tmp"/*.pkg.tar.zst)
    [ -z "$lint" ] || echo "$lint"
    ! echo "$lint" | grep -q ' E: ' || die "namcap reports errors"
else
    echo "aur-publish: namcap not installed, package not linted"
fi

if $dry_run; then
    git -C "$aur" --no-pager diff --stat
    # shellcheck disable=SC2086
    tracked=$(cd "$aur" && git ls-files $files)
    # shellcheck disable=SC2086
    if [ -n "$tracked" ]; then git -C "$aur" checkout -q -- $tracked; fi
    # shellcheck disable=SC2086
    git -C "$aur" clean -fq -- $files
    echo "dry run: rg-helper-bin $pkgver-$pkgrel builds; nothing committed or pushed"
    exit 0
fi

# shellcheck disable=SC2086
git -C "$aur" add $files
git -C "$aur" commit -q -m "rg-helper-bin $pkgver-$pkgrel"
git -C "$aur" push -q origin HEAD:master
echo "aur-publish: rg-helper-bin $pkgver-$pkgrel pushed"
