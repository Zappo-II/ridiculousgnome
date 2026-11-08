#!/bin/sh
# SPDX-FileCopyrightText: 2026 Zappo-II
# SPDX-License-Identifier: GPL-2.0-or-later
# Release vX.Y.Z of helper and extension:
#   make release VERSION=X.Y.Z        set the version, build, commit, tag,
#                                     push, GitHub release with gh
#   make release-check VERSION=X.Y.Z  the same up to the build, then shows
#                                     the changes and undoes them
# The version goes into helper/Cargo.toml and metadata.json's version-name
# (extensions.gnome.org sets the integer version itself, the repo has
# none). Release files: helper tarball, .deb, .rpm, extension zip,
# SHA256SUMS; packaging/arch gets pkgver, the tarball's checksum and
# .SRCINFO (make aur).
set -eu

dry_run=false
if [ "${1-}" = --dry-run ]; then dry_run=true; shift; fi
version=${1-}
tag=v$version
cd "$(dirname "$0")/.."

metadata=gnome-extension/RidiculousGnome@Zappo-II.github.io/metadata.json
changed="helper/Cargo.toml helper/Cargo.lock $metadata packaging/arch/PKGBUILD packaging/arch/.SRCINFO"

die() { echo "release: $*" >&2; exit 1; }

case $version in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) die "usage: make release VERSION=X.Y.Z (got '$version')" ;;
esac

[ -z "$(git status --porcelain)" ] || die "working tree not clean"
[ "$(git branch --show-current)" = main ] || die "not on main"
git fetch -q origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main differs from origin/main"
! git rev-parse -q --verify "refs/tags/$tag" >/dev/null || die "tag $tag exists"
for tool in nfpm makepkg gnome-extensions; do
    command -v $tool >/dev/null || die "$tool not installed"
done
$dry_run || gh auth status >/dev/null 2>&1 || die "gh not logged in (gh auth login)"

# Version into the sources
sed -i "0,/^version = /s/^version = .*/version = \"$version\"/" helper/Cargo.toml
(cd helper && cargo update --workspace --offline --quiet)
if grep -q '"version-name"' $metadata; then
    sed -i "s/\"version-name\": \"[^\"]*\"/\"version-name\": \"$version\"/" $metadata
else
    sed -i "s/^\(\s*\)\"uuid\":/\1\"version-name\": \"$version\",\n\1\"uuid\":/" $metadata
fi

make dist deb rpm extension VERSION=$version
make aur VERSION=$version

files="build/rg-helper-$version-x86_64.tar.gz build/rg-helper_${version}_amd64.deb
       build/rg-helper-$version-1.x86_64.rpm build/RidiculousGnome@Zappo-II.github.io.shell-extension.zip"
# shellcheck disable=SC2086 # word splitting of $files is intended
(cd build && sha256sum $(for f in $files; do basename "$f"; done) > SHA256SUMS)

if $dry_run; then
    git --no-pager diff --stat
    cat build/SHA256SUMS
    # .SRCINFO is new until the first release
    # shellcheck disable=SC2086
    git checkout -- $(git ls-files $changed)
    git clean -fq -- packaging/arch/.SRCINFO
    echo "dry run: nothing committed, tagged or pushed"
    exit 0
fi

# shellcheck disable=SC2086
git add $changed
git commit -q -m "Release $tag"
git tag -a "$tag" -m "$tag"
git push -q origin main "$tag"
# shellcheck disable=SC2086
gh release create "$tag" --verify-tag --title "$tag" --generate-notes $files build/SHA256SUMS
