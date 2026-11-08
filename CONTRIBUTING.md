# Contributing

Ridiculous Gnome has two parts that only talk over D-Bus:

- **The extension** (`gnome-extension/RidiculousGnome@Zappo-II.github.io/`,
  GJS, GNOME Shell 50+): filters input events and draws the effects of
  both modes. Unprivileged, like every extension.
- **rg-helper** (`helper/`, Rust): a small system service that reads
  `/dev/input/event*` and hands the events to the extension of the
  active session over the system bus.

What a user sees and installs is in the [README](README.md). This file
is for working on the code.

## Getting started

On Arch, after cloning:

```
sudo pacman -S rust rust-musl musl mutter-devkit make python
make                 # lists all targets
```

1. **Try the extension** — no helper, nothing installed: `make nested`
   opens a nested GNOME Shell window with the extension enabled in
   limited mode. Type in the Activities overview.
2. **Real input in the nested shell** — in one terminal
   `make helper && helper/dev-run.sh` (runs the helper on the system bus
   until Ctrl+C; asks for sudo once to add a development D-Bus policy,
   `helper/dev-run.sh --remove` takes it out again), in a second one
   `make nested`.
3. **Install the helper on this machine** — `make helper`, then
   `sudo make install`; `sudo make uninstall` removes it again. Stop it
   (`sudo systemctl stop rg-helper`) before using `helper/dev-run.sh`,
   both want the same bus name.

`make check` runs the helper's tests and clippy, validates the settings
schema and the translations. Run it before every commit.

## Repository layout

| Path | What |
|---|---|
| `gnome-extension/RidiculousGnome@Zappo-II.github.io/` | the extension: JS modules, schema, stylesheet, icons, sounds |
| `gnome-extension/run-nested.sh` | nested shell with the extension (`make nested`) |
| `gnome-extension/make-sounds.sh` | generates the sound samples in `sounds/` |
| `helper/src/` | the helper: `main.rs` (devices, D-Bus, subscribers), `xkb.rs` (keycode → label), `detail.rs` (detail levels), `session.rs` (logind), `touchpad.rs` (tap, scroll, swipe, pinch) |
| `helper/dist/` | system files: systemd unit, sysusers entry, D-Bus activation and policy, `rg-helper.conf` |
| `helper/install.sh` | the one install implementation (`make install`, the tarball) |
| `helper/dev-run.sh` | the helper on the host's system bus for the nested shell |
| `helper/examples/listen.rs` | prints the helper's signals (`cargo run --example listen`) |
| `packaging/` | nfpm config and scripts (.deb, .rpm), Arch `PKGBUILD`, `release.sh` |
| `po/` | translations |

## Architecture

```
/dev/input/event*                         gnome-shell (unprivileged,
      │  evdev                             active-session user)
      ▼                                   ┌──────────────────────────────┐
┌───────────────┐    system D-Bus         │ extension.js                 │
│ rg-helper     │◀── Subscribe() ─────────│  EvdevInputSource ──onEvent─▶│
│ system user   │◀── SetKeyboardLayout() ─│  Filter (window rules)       │
│ rg-helper,    │◀── SetDetail() ─────────│   → renderer of the mode     │
│ group input   │── unicast signals ─────▶│  FocusTracker                │
│  xkb, logind  │   (Key, Button, …)      └──────────────────────────────┘
└───────────────┘
```

### Why a separate helper

On GNOME 50+ Wayland an extension cannot see input to app windows. All
in-process and portal options were tried and fail for a passive overlay:

- **AT-SPI**: mutter answers "Access denied" to anyone but Orca for
  keyboard monitoring; no mouse events under Wayland.
- **Clutter stage event filter**: mutter hands key and button events to
  Wayland clients before the stage filter sees them. Only the shell's own
  UI is visible — this is the *limited mode*.
- **`InputCapture` portal**: capture only, it takes input away from apps;
  there is no observe-while-passing-through mode.
- `wtype` / `xdotool` cannot inject into native Wayland apps on GNOME, so
  real input has to be typed by hand when testing.

That leaves reading evdev from a separate process with its own
permission, as `showmethekey` and `wshowkeys` do.

### The extension

`extension.js` wires everything in `enable()` and undoes it in
`disable()`: settings, `FocusTracker`, the input source, the `Filter`,
and the renderer of the current mode (`effect-mode`).

| Module | Does |
|---|---|
| `evdevInputSource.js` | the helper as input source: subscribes, sends the keyboard layout (`InputSourceManager` + `xkb-options`) and the detail level, reports `missing` / `failed` / `subscribed` |
| `shellInputSource.js` | limited mode: a stage event filter, shell UI only; password entries are dropped |
| `helperDBus.js` | the helper's bus name, starting it (`StartServiceByName`) and telling "missing" from "failed" |
| `helperNotice.js` | the limited-mode notification, once per session |
| `focusTracker.js` | focused window and its WM class |
| `filter.js` | event-type switches, window rules, key detail; tracks held keys and buttons |
| `keyLabels.js` | key labels cut down to a detail level, then made display-ready (`formatKey()`) |
| `touchpadMapper.js` | turns the helper's touchpad facts into clicks and wheel steps, honouring GNOME's touchpad settings |
| `effects.js` | the triggers of both modes, their switches, `keyEffect()` |
| `presentation.js`, `clickRings.js`, `look.js` | presentation mode: keys at a fixed place, click rings, styles and accent colour |
| `renderer.js`, `placement.js`, `sprites.js`, `shake.js`, `sound.js`, `fireworks.js`, `xp.js` | ridiculous mode: where an effect appears, sprites, shake, sounds, level-up, XP |
| `panelIndicator.js` | the top bar button in both modes |
| `prefs.js` | preferences (Gtk4/Adwaita, own process) |

Events have the shape `{kind, key?, button?, …}`; the sources produce
it, the Filter cuts it down, the renderer draws it. Positions come from
`global.get_pointer()` (`placement.js`), not from the helper, so the
helper never deals with stage coordinates, scaling or monitors.

Rules the code keeps, because extensions.gnome.org reviews them: nothing
created at import time; everything from `enable()` undone in `disable()`
(signals, timeouts, actors, bus watches, pending calls through a
cancellable); errors only in the log; no key values in any log.

GJS caches ES modules for the lifetime of the shell: after a change,
restart the nested shell, or log out and in where the extension is
installed. Disable/enable runs the old code again.

### The helper

One static musl binary with pure-Rust crates (`evdev`, `zbus`, `kbvm`):
no C code at build time, no `.so` at run time, the same binary on every
distro. The only run-time data is xkeyboard-config (`/usr/share/X11/xkb`).

- **Devices**: keyboards, mice, absolute pointers (e.g. the QEMU/SPICE
  tablet in a VM) and touchpads; no touchscreens or gamepads. Hotplug
  through inotify on `/dev/input`.
- **Keys**: one xkb state for all keyboards; keycode → character or
  keysym name, with the layout the extension sends (`SetKeyboardLayout`,
  follows layout switches). Auto-repeat is not forwarded.
- **Touchpad**: tap and two-finger scrolling are made by libinput in the
  compositor and do not exist in evdev; the helper recognises them
  itself (`touchpad.rs`, thresholds in mm) and sends facts, the extension
  applies the user's settings (`touchpadMapper.js`).
- **Who gets events**: only the user of the active, unlocked user
  session on seat0 (logind; class `user`, so not the GDM greeter), as
  unicast signals, never broadcast. `Subscribe` checks only "active", not
  "unlocked": the shell subscribes ~200 ms before it clears `LockedHint`.
- **Detail levels** (`detail.rs`): any process of that user can
  subscribe, so the helper decides how much it tells about keys. Each
  subscriber picks a level with `SetDetail`, the answer is
  `min(ceiling, requested)`; the ceiling is `max-detail` in
  `/etc/rg-helper.conf` (default `shortcuts`). A new subscriber starts at
  `off`. The extension sets the focused window's level on every focus
  change, so keys of an `off` window never leave the helper.
- **Lifetime**: D-Bus activation through systemd; `--exit-idle` ends it
  30 s after the last subscriber left (lock, logout, extension off).
- **Never logs key values.** Its log names devices and subscribers.

#### D-Bus contract

Name and interface `io.github.zappoii.RidiculousGnome.Helper`, object
`/io/github/zappoii/RidiculousGnome/Helper`, system bus. The `Version`
property is the contract version (now **4**); the extension refuses
other versions with a notice. Raise it on every incompatible change.

| Member | Signature | Meaning |
|---|---|---|
| `Subscribe` / `Unsubscribe` | `()` | start / stop receiving signals (also implicit when the caller leaves the bus) |
| `SetKeyboardLayout` | `sss` | layout, variant, options; subscribers only |
| `SetDetail` | `s → s` | requested detail level → effective one |
| `MaxDetail` (prop) | `s` | the ceiling |
| `Key` | `b s` | pressed?, label (character, keysym name or class) |
| `Button` | `b u` | pressed?, button |
| `Wheel` | `s` | `up` / `down` / `left` / `right` |
| `Motion` | `()` | pointer moved (at most every 50 ms) |
| `Touch` | `b u` | touching?, finger count |
| `Tap` | `u` | finger count of a tap |
| `PadButton` | `b u s` | clickpad pressed?, finger count, area `left` / `right` |
| `Scroll` | `s` | two fingers moved one step (10 mm), direction |
| `Swipe` | `u s` | 3+ fingers swiped, direction |
| `Pinch` | `u s` | spread `out` / `in`, one per 4 mm |

The extension watches the name and calls `StartServiceByName` itself;
dbus-broker answers "not installed", "fails to start" and "running
without activation file" all with `ServiceUnknown`, so after a failed
start `helperDBus.js` tells them apart with `ListActivatableNames`.
The prefs window never starts the helper; it reads `helper-status`,
which the extension publishes.

#### Permissions and install locations

The helper runs as its own system user `rg-helper` in group `input`; the
login user gets no new rights. The unit is hardened (`ProtectSystem=strict`,
`ProtectHome`, `PrivateNetwork`, `NoNewPrivileges`, `DevicePolicy=closed`
with `DeviceAllow=char-input r`; `systemd-analyze security` rates it
2.5). The D-Bus policy lets only `rg-helper` own the name; anyone may
call, the helper checks the session itself.

The binary must live in `/usr/libexec` on SELinux systems (Fedora):
there it gets `bin_t` and runs as `unconfined_service_t`, which may read
input devices; under `/usr/lib` it stays `init_t` and every `open()` is
denied. The Arch package uses `/usr/lib/rg-helper` (no SELinux).
On Ubuntu, AppArmor has no profile for it; nothing to do.

## Testing

### Nested shell

`make nested` (or `gnome-extension/run-nested.sh [monitors]`, e.g. `2`
for two virtual monitors) runs GNOME Shell's devkit with the extension in
a sandbox under `$XDG_RUNTIME_DIR/ridiculousgnome-nested`: own dconf, a
copy of the extension, nothing changed in your session. Restart it after
every change. Run one at a time — they share the sandbox.

- With `helper/dev-run.sh` in a second terminal the nested shell gets
  real input. The helper reads the host's devices, so typing in other
  host windows shows up too.
- Keyboard layouts: set them inside the nested session, e.g.
  `dconf write /org/gnome/desktop/input-sources/sources "[('xkb','us'), ('xkb','de+nodeadkeys')]"`,
  switch with Super+Space.
- Event sounds are off in the sandbox: any sound through the shell's
  player freezes the devkit picture after a while. Test sounds in a VM.
- Not testable here: lock and session switch (logind sees the host
  session), the real install, GNOME 50.
- Harmless log noise: `org.freedesktop.systemd1 … failed`, gvfs,
  geolocation, xkbcomp.

### Test VMs

For the real install, lock handling and the minimum GNOME version, I used a
Fedora and an Ubuntu VM (libvirt) with GNOME 50:

- Spice with OpenGL on and `virtio-vga-gl` with 3D acceleration; check
  `journalctl -k -b | grep features` shows `+virgl` in the guest.
  Without it the shell renders in software and turns off all animations.
- ssh access by alias; the make targets take it from `VM_HOST`
  (default `gshell`).
- `make vm-extension VM_HOST=…` copies the extension zip over ssh and
  installs it; then log out and in in the guest. Never use a shared
  folder or symlink for the extension: uninstalling it in the guest
  deletes the directory, through the link the source.
- Helper: the packages as a user gets them — `make deb rpm VERSION=x.y.z`,
  copy into the guest, `sudo apt install ./…deb` / `sudo dnf install
  ./…rpm`. `make vm-install` (tarball + `sudo make install`) needs `make`
  in the guest, which Ubuntu Desktop does not have.
- Lock the guest from the host with `loginctl lock-session <id>` over
  ssh (Super+L in the VM window locks the host).
- The pointer arrives through the SPICE tablet: touchpad taps are already
  clicks there. Touchpad features need real hardware with the nested
  shell.
- Live snapshots fail with virgl on; shut the VM down first.

Worth checking after changes to the helper or the install: active user
gets events, another user (`sudo -u nobody busctl --system call …
Subscribe`) is refused, nothing while locked, layout switches follow,
`journalctl -u rg-helper` shows no key values, the extension leaves the
limited mode within seconds of installing the helper and returns to it
after removing it.

## Translations

`make pot` updates `po/ridiculousgnome.pot` from the sources and merges
it into the `po/*.po` files; `make translations` compiles them into the
extension directory (the nested shell and `make extension` do this
themselves). New language: copy the `.pot` to `po/<lang>.po`.

## Packages

| Target | Builds into `build/` |
|---|---|
| `make extension` | the extension zip (also what goes to extensions.gnome.org) |
| `make dist` | helper tarball: binary, `install.sh`, Makefile, system files, licenses |
| `make deb rpm` | helper packages with nfpm (`paru -S nfpm-bin`) |
| `make arch` | `rg-helper-bin` with `makepkg` |

The helper binary is statically linked, so tarball and packages carry
`THIRD-PARTY-LICENSES` next to `LICENSE`: the Rust standard library, musl
and every linked crate with its license text. `make third-party` writes
it from `cargo metadata` (`packaging/third-party-licenses.py`); it stops
when a crate has no license file and is not MIT, and warns when it uses
the standard MIT text for one.

Packages need a version: a tag `vX.Y.Z` on the commit, or
`VERSION=X.Y.Z`. One tag covers helper and extension; whether they fit
together is decided by the contract version, not the release number.
