#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Zappo-II
# SPDX-License-Identifier: GPL-2.0-or-later
"""Writes the third-party license files for the static rg-helper binary.

The binary contains the Rust standard library, musl libc and every crate
linked into it (proc macros and build-only dependencies are left out:
they run at build time and end up in no binary). Their licenses ask for
the notice to travel with the binary, so `make dist`, `make deb rpm` and
the Arch package ship these files next to LICENSE:

  THIRD-PARTY-LICENSES      what is in the binary, under which license
  THIRD-PARTY-<license>     the license texts, one file per license

Where a crate offers a choice ("MIT OR Apache-2.0") MIT is taken, so the
files are MIT plus whatever a crate requires on top (e.g. Zlib,
Unicode-3.0). One file per license is what Arch's namcap checks for.

Usage: third-party-licenses.py OUTPUT_DIR
Environment: RUST_LICENSE_DIR (default /usr/share/licenses/rust-musl),
MUSL_COPYRIGHT (default /usr/share/licenses/musl/COPYRIGHT).
"""

import glob
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
# Preference when a crate offers a choice
PREFERRED = ['MIT', 'Zlib', 'Apache-2.0']
# How to recognise a license text, by file name or by its first lines
SIGNS = {
    'MIT': (r'MIT', r'^\s*(The )?MIT License|Permission is hereby granted, free of charge'),
    'Zlib': (r'ZLIB', r"provided 'as-is', without any express or implied"),
    'Unicode-3.0': (r'UNICODE', r'UNICODE LICENSE|Unicode License'),
    'Apache-2.0': (r'APACHE', r'Apache License\s+Version 2\.0'),
}
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


def warn(msg):
    print(f'third-party-licenses: {msg}', file=sys.stderr)


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


def chosen_licenses(expr):
    """The licenses rg-helper uses a crate under: one per OR group, all of an AND.

    Handles the forms crates use: "A OR B", "A/B", "(A OR B) AND C",
    "A WITH exception OR B".
    """
    chosen = []
    for group in re.split(r'\s+AND\s+', expr.replace('/', ' OR ')):
        options = [o.strip(' ()') for o in re.split(r'\s+OR\s+', group)]
        options = [o for o in options if ' WITH ' not in o] or options
        pick = next((p for p in PREFERRED if p in options), options[0])
        chosen.append(pick)
    return chosen


def license_of(name, text):
    # The file name first: the Unicode license also starts with "Permission
    # is hereby granted, free of charge"
    for lic, (by_name, _) in SIGNS.items():
        if re.search(by_name, name, re.I):
            return lic
    head = text[:600]
    for lic, (_, by_text) in SIGNS.items():
        if re.search(by_text, head, re.I | re.M):
            return lic
    return None


def crate_texts(pkg):
    """{license: (file name, text)} for the licenses chosen for this crate."""
    folder = os.path.dirname(pkg['manifest_path'])
    names = sorted(n for n in os.listdir(folder)
                   if LICENSE_FILE.match(n) and os.path.isfile(os.path.join(folder, n)))
    found = {}
    for n in names:
        text = read(os.path.join(folder, n))
        lic = license_of(n, text)
        if lic and lic not in found:
            found[lic] = (n, text)
    texts = {}
    for lic in chosen_licenses(pkg.get('license') or ''):
        if lic in found:
            texts[lic] = found[lic]
        elif lic == 'MIT':
            # Some crates publish only the SPDX expression; the standard
            # text with the crate's authors stands in for the missing file.
            holders = ', '.join(pkg.get('authors') or []) or f"the {pkg['name']} authors"
            warn(f"{pkg['name']} {pkg['version']} has no MIT license file, using the standard text")
            texts[lic] = ('standard MIT text, no license file published', MIT_TEXT.format(holders=holders))
        else:
            die(f"{pkg['name']} {pkg['version']}: no {lic} license text in {folder}")
    return texts


def section(title, body):
    return f'{RULE}\n{title}\n{RULE}\n\n{body}\n'


def main():
    if len(sys.argv) != 2:
        die('usage: third-party-licenses.py OUTPUT_DIR')
    out_dir = sys.argv[1]
    rust_dir = os.environ.get('RUST_LICENSE_DIR', '/usr/share/licenses/rust-musl')
    musl = os.environ.get('MUSL_COPYRIGHT', '/usr/share/licenses/musl/COPYRIGHT')
    for path in (os.path.join(rust_dir, 'COPYRIGHT'), os.path.join(rust_dir, 'LICENSE-MIT'), musl):
        if not os.path.isfile(path):
            die(f'{path} missing (Arch: pacman -S rust-musl musl)')

    # license -> list of (title, text); identical texts are merged below
    by_license = {'MIT': [
        ('Rust standard library', read(os.path.join(rust_dir, 'COPYRIGHT')) + '\n'
         + read(os.path.join(rust_dir, 'LICENSE-MIT'))),
        ('musl libc', read(musl)),
    ]}
    listing = [
        '  Rust standard library  (MIT OR Apache-2.0; used under MIT)',
        '  musl libc  (MIT)',
        '  libunwind from LLVM  (Apache-2.0 WITH LLVM-exception; the exception waives',
        '    the attribution requirement for this compiled form)',
    ]
    crates = linked_crates()
    for pkg in crates:
        texts = crate_texts(pkg)
        repo = pkg.get('repository') or pkg.get('homepage') or ''
        listing.append(f"  {pkg['name']} {pkg['version']}  ({pkg.get('license')}; used under "
                       f"{' AND '.join(texts)})  {repo}".rstrip())
        for lic, (name, text) in texts.items():
            by_license.setdefault(lic, []).append((f"{pkg['name']} {pkg['version']} ({name})", text))

    os.makedirs(out_dir, exist_ok=True)
    for old in glob.glob(os.path.join(out_dir, 'THIRD-PARTY-*')):
        os.remove(old)
    files = sorted(by_license)
    index = (
        'Third-party software in rg-helper\n\n'
        'rg-helper itself is Copyright (C) 2026 Zappo-II, GPL-2.0-or-later (see\n'
        'LICENSE). Its binary is statically linked and also contains the\n'
        'software below. Where a component offers a choice of licenses,\n'
        'rg-helper uses it under MIT. The license texts are in\n'
        + ''.join(f'THIRD-PARTY-{lic}\n' for lic in files)
        + '\n' + '\n'.join(listing) + '\n')
    with open(os.path.join(out_dir, 'THIRD-PARTY-LICENSES'), 'w', encoding='utf-8') as f:
        f.write(index)
    for lic in files:
        merged = {}
        for title, text in by_license[lic]:
            merged.setdefault(text, []).append(title)
        body = [f'{lic} license texts of the components listed in THIRD-PARTY-LICENSES\n']
        body += [section('\n'.join(titles), text) for text, titles in merged.items()]
        with open(os.path.join(out_dir, f'THIRD-PARTY-{lic}'), 'w', encoding='utf-8') as f:
            f.write('\n'.join(body))
    print(f'{out_dir}: {len(crates)} crates; THIRD-PARTY-LICENSES, '
          + ', '.join(f'THIRD-PARTY-{lic}' for lic in files))


if __name__ == '__main__':
    main()
