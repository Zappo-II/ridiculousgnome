#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Zappo-II
# SPDX-License-Identifier: GPL-2.0-or-later
"""Writes THIRD-PARTY-LICENSES for the static rg-helper binary.

The binary contains the Rust standard library, musl libc and every crate
linked into it (proc macros and build-only dependencies are left out:
they run at build time and end up in no binary). Their licenses ask for
the notice to travel with the binary, so `make dist`, `make deb rpm` and
the Arch package ship this file next to LICENSE.

Usage: third-party-licenses.py OUTPUT
Environment: RUST_LICENSE_DIR (default /usr/share/licenses/rust-musl),
MUSL_COPYRIGHT (default /usr/share/licenses/musl/COPYRIGHT).
"""

import hashlib
import json
import os
import re
import subprocess
import sys

TARGET = 'x86_64-unknown-linux-musl'
HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, '..', 'helper', 'Cargo.toml')
LICENSE_FILE = re.compile(r'^(LICEN[CS]E|COPYING|COPYRIGHT|UNLICENSE|NOTICE)', re.I)
RULE = '=' * 78
MIT_TEXT = '''MIT License

Copyright (c) {holders}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
'''


def die(msg):
    sys.exit(f'third-party-licenses: {msg}')


def read(path):
    with open(path, encoding='utf-8', errors='replace') as f:
        return f.read().strip('\n') + '\n'


def linked_crates():
    meta = json.loads(subprocess.check_output(
        ['cargo', 'metadata', '--format-version', '1', '--locked',
         '--filter-platform', TARGET, '--manifest-path', MANIFEST]))
    packages = {p['id']: p for p in meta['packages']}
    nodes = {n['id']: n for n in meta['resolve']['nodes']}
    root = meta['resolve']['root']
    seen, todo = set(), [root]
    while todo:
        pid = todo.pop()
        if pid in seen:
            continue
        seen.add(pid)
        for dep in nodes[pid]['deps']:
            if not any(k['kind'] is None for k in dep['dep_kinds']):
                continue  # dev- or build-dependency
            kinds = {k for t in packages[dep['pkg']]['targets'] for k in t['kind']}
            if 'proc-macro' in kinds:
                continue
            todo.append(dep['pkg'])
    seen.discard(root)
    return sorted((packages[p] for p in seen), key=lambda p: (p['name'], p['version']))


def license_texts(pkg):
    folder = os.path.dirname(pkg['manifest_path'])
    names = sorted(n for n in os.listdir(folder)
                   if LICENSE_FILE.match(n) and os.path.isfile(os.path.join(folder, n)))
    if pkg.get('license_file'):
        names.append(pkg['license_file'])
    texts = [(n, read(os.path.join(folder, n))) for n in dict.fromkeys(names)]
    if texts:
        return texts
    # Some crates publish only the SPDX expression; for MIT the standard
    # text with the crate's authors stands in for the missing file.
    if not re.search(r'\bMIT\b', pkg.get('license') or ''):
        die(f"{pkg['name']} {pkg['version']}: no license file in {folder}, and not MIT")
    holders = ', '.join(pkg.get('authors') or []) or f"the {pkg['name']} authors"
    print(f"third-party-licenses: {pkg['name']} {pkg['version']} has no license file, "
          'using the standard MIT text', file=sys.stderr)
    return [('standard MIT text, no license file published', MIT_TEXT.format(holders=holders))]


def section(title, body):
    return f'{RULE}\n{title}\n{RULE}\n\n{body}\n'


def main():
    if len(sys.argv) != 2:
        die('usage: third-party-licenses.py OUTPUT')
    rust_dir = os.environ.get('RUST_LICENSE_DIR', '/usr/share/licenses/rust-musl')
    musl = os.environ.get('MUSL_COPYRIGHT', '/usr/share/licenses/musl/COPYRIGHT')
    for path in (os.path.join(rust_dir, 'COPYRIGHT'), os.path.join(rust_dir, 'LICENSE-MIT'), musl):
        if not os.path.isfile(path):
            die(f'{path} missing (Arch: pacman -S rust-musl musl)')

    crates = linked_crates()
    out = [
        'Third-party software in rg-helper\n\n'
        'rg-helper itself is Copyright (C) 2026 Zappo-II, GPL-2.0-or-later (see\n'
        'LICENSE). Its binary is statically linked and also contains the\n'
        'software below, under the licenses that follow. Where a crate offers\n'
        'a choice (e.g. "MIT OR Apache-2.0"), rg-helper uses it under MIT.\n',
        section('Rust standard library (MIT OR Apache-2.0)',
                read(os.path.join(rust_dir, 'COPYRIGHT')) + '\n'
                + read(os.path.join(rust_dir, 'LICENSE-MIT'))),
        section('musl libc (MIT)', read(musl)),
        section('libunwind from LLVM (Apache-2.0 WITH LLVM-exception)',
                'Part of the Rust musl target. The LLVM exception waives the\n'
                'attribution requirement for this compiled form.\n'),
    ]

    # Crates: one entry each; identical license texts are printed once.
    listing, by_text = [], {}
    for pkg in crates:
        repo = pkg.get('repository') or pkg.get('homepage') or ''
        listing.append(f"  {pkg['name']} {pkg['version']}  ({pkg.get('license') or '?'})  {repo}".rstrip())
        for name, text in license_texts(pkg):
            key = hashlib.sha256(text.encode()).hexdigest()
            by_text.setdefault(key, [text, []])[1].append(f"{pkg['name']} {pkg['version']} ({name})")
    out.append(section(f'Rust crates ({len(crates)})', '\n'.join(listing) + '\n'))
    for text, users in by_text.values():
        out.append(section('License text of:\n  ' + '\n  '.join(users), text))

    with open(sys.argv[1], 'w', encoding='utf-8') as f:
        f.write('\n'.join(out))
    print(f'{sys.argv[1]}: {len(crates)} crates, {len(by_text)} license texts')


if __name__ == '__main__':
    main()
