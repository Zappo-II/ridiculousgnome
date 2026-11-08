# Ridiculous Gnome

A GNOME Shell extension that shows short-lived effects on screen while you
type and click — inspired by the "Ridiculous Coding" VS Code plugin, but
for every app. Two modes: **ridiculous** (sparks and explosions where you
type, pops where you click, a sparkle trail when you drag, optionally a
shaking window and sounds; XP with a level in the top bar and fireworks
at a level-up) and **presentation** (keys and
shortcuts at a fixed place, click rings — for screencasts and demos).

Works on GNOME 50 and 51 (Wayland), x86_64.

## Install

Two parts: the extension, and **rg-helper**, a small system service that
reads keyboard and mouse. GNOME does not let extensions see input to other
apps, so without the helper the extension runs in a *limited mode*:
effects only for the shell itself, e.g. when typing in the Activities
search.

On Ubuntu the desktop with its icons is an app window (Desktop Icons NG),
not part of the shell: in limited mode only the first click on the
desktop shows, nothing after it. With the helper the desktop works like
any other window.

### 1. The extension

Install from EGO...

- [extensions.gnome.org](https://extensions.gnome.org/)

Or download `RidiculousGnome@Zappo-II.github.io.shell-extension.zip`
from releases...

- [releases](https://github.com/Zappo-II/ridiculousgnome/releases)
- `gnome-extensions install --force RidiculousGnome@Zappo-II.github.io.shell-extension.zip`
- then log out and in
- and enable the extension
- `gnome-extensions enable RidiculousGnome@Zappo-II.github.io`.

### 2. The helper

Install from [releases](https://github.com/Zappo-II/ridiculousgnome/releases) (replace `X.Y.Z` with the version):

| System                | Install                                                                            |
| --------------------- | ---------------------------------------------------------------------------------- |
| Ubuntu, Debian        | `sudo apt install ./rg-helper_X.Y.Z_amd64.deb`                                     |
| Fedora                | `sudo dnf install ./rg-helper-X.Y.Z-1.x86_64.rpm`                                  |
| Arch                  | [`rg-helper-bin`](https://aur.archlinux.org/packages/rg-helper-bin) from the AUR, e.g. `paru -S rg-helper-bin` |
| other systemd distros | `tar xzf rg-helper-X.Y.Z-x86_64.tar.gz && cd rg-helper-X.Y.Z && sudo ./install.sh` |

No re-login needed: the extension notices the helper within seconds and
leaves the limited mode. The extension's settings (General page) show
whether the helper runs.

## What the helper sees, and who gets it

rg-helper reads **every keyboard, mouse and touchpad** on the machine. To
keep that contained:

- It runs as its own system user `rg-helper`, the only account with
  access to the input devices. Your user account gets no new rights.
- It has no network access and stores nothing; its log
  (`journalctl -u rg-helper`) names devices and subscribers, never keys.
- It hands events only to the user whose session is active and
  unlocked — nothing while the screen is locked, and nothing to other
  users on the same machine.

But it hands them to *any* program of that user, not only the extension:
the system bus cannot tell GNOME Shell from another program you run. So
rg-helper limits how much it tells about keys:

| Level | Key labels |
|---|---|
| `off` (window rules only) | none, and no other effects in that window either |
| `mouse` (window rules only) | none; clicks, drags and the wheel still show |
| `activity` | a symbol for every key |
| `classes` | letter, digit, symbol, space, and the names of keys like Return, Shift, F5 |
| `shortcuts` (default) | as `classes`, but while Ctrl, Alt or Super is held the key itself: `Ctrl + T` |
| `characters` | the typed characters |

Mouse and touchpad events are the same on all levels except `off`.

In the extension's settings you choose the level (Events → Keys → "Key
labels show"), and per window under Windows → "Window rules" — e.g. `off`
or `mouse` for your password manager, so its keys never leave the helper. rg-helper
gives out at most its **ceiling** (default `shortcuts`), which only root
can change. `shortcuts` shows what you do — `Ctrl + C`, `Super`, `Alt +
Tab` — but not what you type; AltGr does not count, so `@` or `€` stay a
symbol. To see the typed characters, set in `/etc/rg-helper.conf`:

```
max-detail = characters
```

and run `sudo systemctl restart rg-helper`. Do this only if you are fine
with *every* program you run being able to read what you type while
rg-helper is installed.

## Remove

Extension: in Extension Manager, or
`gnome-extensions uninstall RidiculousGnome@Zappo-II.github.io`.

Helper:

| Installed with | Remove |
|---|---|
| `.deb` | `sudo apt remove rg-helper` (`purge` also removes `/etc/rg-helper.conf`) |
| `.rpm` | `sudo dnf remove rg-helper` |
| AUR | `sudo pacman -R rg-helper-bin` |
| tarball | `sudo ./install.sh --uninstall` in the unpacked directory |

The system user `rg-helper` stays; `sudo userdel rg-helper` removes it.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md): architecture, building, nested
shell, test VMs, packages.

## License

Copyright (C) 2026 Zappo-II

Extension and helper are licensed under GPL-2.0-or-later (see
[LICENSE](LICENSE)), like GNOME Shell itself. Every source file says so
in an SPDX header.

Inspired by the Ridiculous Coding VS Code extension; no code, images or
sounds are taken from it. The images are drawn for this project, the
sounds are generated by `gnome-extension/make-sounds.sh`.
