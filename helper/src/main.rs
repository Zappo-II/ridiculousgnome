// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

//! rg-helper: evdev keyboards, mice and touchpads -> unicast D-Bus signals
//! to subscribed clients only (contract in CONTRIBUTING.md, "D-Bus contract").
//!
//! Keys are translated with kbvm in the layout the extension sends.
//! Subscribe is restricted to the active session's user, and events go out
//! only while that session is active and unlocked (logind watch, session.rs).
//! Devices are picked up when plugged in (inotify on /dev/input) and
//! dropped when they vanish. Key detail levels (detail.rs): each subscriber
//! chooses one with `SetDetail`, capped by `max-detail` from
//! /etc/rg-helper.conf. Touchpad gestures (touchpad.rs): `Tap`, `PadButton`
//! (a clickpad press, instead of `Button`), `Scroll`, `Swipe`, `Pinch`.
//!
//! Usage: rg-helper [--exit-idle] [--session] [--demo] [--max-detail D] [--layout L] [--variant V] [--options O]
//!   --exit-idle   exit after IDLE_TIMEOUT without subscribers (the systemd
//!                 unit; D-Bus activation starts it again when needed)
//!   --session     own the name on the session bus instead of the system bus
//!                 (development without the D-Bus policy file)
//!   --demo        emit a synthetic key every second instead of reading evdev
//!   --max-detail  ceiling instead of the config file's (development)
//!
//! Never logs key values.

mod detail;
mod session;
mod touchpad;
mod xkb;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use evdev::{
    AbsoluteAxisCode, Device, EventSummary, KeyCode, PropType, RelativeAxisCode, SynchronizationCode,
};
use futures_util::StreamExt;
use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify};
use zbus::message::Header;
use zbus::names::{BusName, OwnedUniqueName};
use zbus::{Connection, fdo, interface};

use detail::Detail;

const NAME: &str = "io.github.zappoii.RidiculousGnome.Helper";
const PATH: &str = "/io/github/zappoii/RidiculousGnome/Helper";

/// At most one `Motion` signal per this interval, across all devices.
const MOTION_INTERVAL: Duration = Duration::from_millis(50);

/// Contract version, the `Version` property; the extension checks it.
const VERSION: u32 = 4;

/// With `--exit-idle`: how long without subscribers before exiting, and how
/// often that is checked.
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const IDLE_CHECK: Duration = Duration::from_secs(5);

struct Subscriber {
    /// UID the client connected as.
    uid: u32,
    /// Key detail it gets; `Off` until it calls `SetDetail`.
    detail: Detail,
}

/// Subscribed clients by unique bus name.
type Subscribers = Arc<Mutex<HashMap<OwnedUniqueName, Subscriber>>>;
type SharedTranslator = Arc<Mutex<xkb::Translator>>;

struct Helper {
    subscribers: Subscribers,
    translator: SharedTranslator,
    /// Connection to the system bus for logind queries.
    system: Connection,
    /// Ceiling for every subscriber's detail level.
    max_detail: Detail,
}

impl Helper {
    fn sender(header: &Header<'_>) -> fdo::Result<OwnedUniqueName> {
        header
            .sender()
            .map(|s| s.to_owned().into())
            .ok_or_else(|| fdo::Error::Failed("no sender".into()))
    }
}

#[interface(name = "io.github.zappoii.RidiculousGnome.Helper")]
impl Helper {
    async fn subscribe(
        &self,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] connection: &Connection,
    ) -> fdo::Result<()> {
        let sender = Self::sender(&header)?;
        let uid = fdo::DBusProxy::new(connection)
            .await?
            .get_connection_unix_user(BusName::from(sender.as_ref()))
            .await?;
        // Locked is fine here: nothing is sent until the session is unlocked
        // (session::watch), and gnome-shell re-enables extensions before it
        // clears LockedHint.
        if !session::owns_active(&self.system, uid).await {
            eprintln!("subscribe refused: {sender} (uid {uid})");
            return Err(fdo::Error::AccessDenied(
                "only the user of the active session on seat0 may subscribe".into(),
            ));
        }
        eprintln!("subscribe: {sender} (uid {uid})");
        self.subscribers.lock().unwrap().insert(sender, Subscriber { uid, detail: Detail::Off });
        Ok(())
    }

    /// Chooses the key detail level; answers the effective one, which is
    /// at most `MaxDetail`.
    fn set_detail(&self, #[zbus(header)] header: Header<'_>, detail: &str) -> fdo::Result<String> {
        let sender = Self::sender(&header)?;
        let requested: Detail = detail
            .parse()
            .map_err(|()| fdo::Error::InvalidArgs("detail must be off, activity, classes, shortcuts or characters".into()))?;
        let effective = requested.min(self.max_detail);
        match self.subscribers.lock().unwrap().get_mut(&sender) {
            Some(subscriber) => subscriber.detail = effective,
            None => return Err(fdo::Error::AccessDenied("subscribe first".into())),
        }
        eprintln!("detail: {sender} {effective}");
        Ok(effective.to_string())
    }

    fn unsubscribe(&self, #[zbus(header)] header: Header<'_>) -> fdo::Result<()> {
        let sender = Self::sender(&header)?;
        eprintln!("unsubscribe: {sender}");
        self.subscribers.lock().unwrap().remove(&sender);
        Ok(())
    }

    fn set_keyboard_layout(
        &self,
        #[zbus(header)] header: Header<'_>,
        layout: &str,
        variant: &str,
        options: &str,
    ) -> fdo::Result<()> {
        let sender = Self::sender(&header)?;
        if !self.subscribers.lock().unwrap().contains_key(&sender) {
            return Err(fdo::Error::AccessDenied("subscribe first".into()));
        }
        if !valid_layout_names(layout, variant, options) {
            return Err(fdo::Error::InvalidArgs("invalid layout, variant or options".into()));
        }
        eprintln!("layout: {layout} variant: {variant:?} options: {options:?}");
        *self.translator.lock().unwrap() = xkb::Translator::new(layout, variant, options);
        Ok(())
    }

    #[zbus(property)]
    fn version(&self) -> u32 {
        VERSION
    }

    /// The ceiling from /etc/rg-helper.conf (`max-detail`).
    #[zbus(property)]
    fn max_detail(&self) -> String {
        self.max_detail.to_string()
    }
}

/// The names end up as XKB include names: no paths, no surprises.
fn valid_layout_names(layout: &str, variant: &str, options: &str) -> bool {
    let valid = |s: &str, extra: &str| {
        s.len() <= 256
            && s.chars().all(|c| c.is_ascii_alphanumeric() || "_-".contains(c) || extra.contains(c))
    };
    !layout.is_empty() && valid(layout, "") && valid(variant, "") && valid(options, ":,")
}

/// Everything a device thread needs to turn events into signals.
#[derive(Clone)]
struct Sink {
    connection: Connection,
    subscribers: Subscribers,
    receiver: session::Receiver,
    translator: SharedTranslator,
    last_motion: Arc<Mutex<Option<Instant>>>,
}

impl Sink {
    /// Sends a signal to every subscriber of the active, unlocked session's
    /// user, never as a broadcast. Nobody gets anything while locked.
    fn emit<B>(&self, member: &str, body: &B)
    where
        B: serde::Serialize + zbus::zvariant::DynamicType,
    {
        for (target, _) in self.targets() {
            self.send(&target, member, body);
        }
    }

    /// `Key(pressed, label)`, the label cut down to each subscriber's level.
    fn key(&self, pressed: bool, key: &xkb::Key) {
        for (target, detail) in self.targets() {
            if let Some(label) = detail::label(detail, key) {
                self.send(&target, "Key", &(pressed, label.as_str()));
            }
        }
    }

    /// Subscribers of the active, unlocked session's user with their level.
    fn targets(&self) -> Vec<(OwnedUniqueName, Detail)> {
        let Some(receiver) = *self.receiver.lock().unwrap() else {
            return Vec::new();
        };
        self.subscribers
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, s)| s.uid == receiver)
            .map(|(name, s)| (name.clone(), s.detail))
            .collect()
    }

    fn send<B>(&self, target: &OwnedUniqueName, member: &str, body: &B)
    where
        B: serde::Serialize + zbus::zvariant::DynamicType,
    {
        let _ = zbus::block_on(self.connection.emit_signal(Some(target.as_ref()), PATH, NAME, member, body));
    }

    /// `Motion()`, throttled to one per MOTION_INTERVAL.
    fn motion(&self) {
        {
            let mut last = self.last_motion.lock().unwrap();
            let now = Instant::now();
            if last.is_some_and(|t| now.duration_since(t) < MOTION_INTERVAL) {
                return;
            }
            *last = Some(now);
        }
        self.emit("Motion", &());
    }

    fn handle(&self, event: EventSummary, now_ms: u64, touch: &mut Touch, pad: Option<&mut Pad>) {
        match event {
            EventSummary::Synchronization(_, SynchronizationCode::SYN_REPORT, _) => {
                if let Some((touching, fingers)) = touch.frame_done() {
                    self.emit("Touch", &(touching, fingers));
                }
                if let Some(pad) = pad {
                    for output in pad.recognizer.frame(now_ms) {
                        self.gesture(output);
                    }
                }
            }
            // value: 0 release, 1 press, 2 autorepeat (ignored)
            EventSummary::Key(_, code, value @ 0..=1) => {
                let pressed = value == 1;
                if touch.key(code, pressed) {
                    // touchpad contact / finger count, emitted at SYN_REPORT
                    if let Some(pad) = pad {
                        pad.recognizer.set_touching(touch.touching);
                        pad.recognizer.set_fingers(touch.fingers);
                    }
                } else if let (Some(pad), KeyCode::BTN_LEFT) = (pad.filter(|p| p.buttonpad), code) {
                    // The whole pad is the button: which one is up to the
                    // click method, so it is reported with fingers and area
                    pad.recognizer.set_button(pressed);
                } else if let Some(button) = button_number(code) {
                    self.emit("Button", &(pressed, button));
                } else if !is_other_button(code) {
                    let key = self.translator.lock().unwrap().key(code.code().into(), pressed);
                    if let Some(key) = key {
                        self.key(pressed, &key);
                    }
                }
            }
            EventSummary::RelativeAxis(_, code, value) if value != 0 => match code {
                RelativeAxisCode::REL_WHEEL => self.emit("Wheel", &(if value > 0 { "up" } else { "down" },)),
                RelativeAxisCode::REL_HWHEEL => {
                    self.emit("Wheel", &(if value > 0 { "right" } else { "left" },))
                }
                RelativeAxisCode::REL_X | RelativeAxisCode::REL_Y => self.motion(),
                _ => {}
            },
            EventSummary::AbsoluteAxis(_, code, value) => {
                if let Some(pad) = pad {
                    let r = &mut pad.recognizer;
                    match code {
                        AbsoluteAxisCode::ABS_MT_SLOT => r.set_slot(value),
                        AbsoluteAxisCode::ABS_MT_TRACKING_ID => r.set_tracking_id(value),
                        AbsoluteAxisCode::ABS_MT_POSITION_X => r.set_x(value),
                        AbsoluteAxisCode::ABS_MT_POSITION_Y => r.set_y(value),
                        AbsoluteAxisCode::ABS_X => r.set_single(Some(value), None),
                        AbsoluteAxisCode::ABS_Y => r.set_single(None, Some(value)),
                        _ => {}
                    }
                }
                if matches!(code, AbsoluteAxisCode::ABS_X | AbsoluteAxisCode::ABS_Y) {
                    self.motion();
                }
            }
            _ => {}
        }
    }

    fn gesture(&self, output: touchpad::Output) {
        use touchpad::Output;
        match output {
            Output::Tap { fingers } => self.emit("Tap", &(fingers,)),
            Output::PadButton { pressed, fingers, area } => self.emit("PadButton", &(pressed, fingers, area)),
            Output::Scroll { dir } => self.emit("Scroll", &(dir,)),
            Output::Swipe { fingers, dir } => self.emit("Swipe", &(fingers, dir)),
            Output::Pinch { fingers, dir } => self.emit("Pinch", &(fingers, dir)),
        }
    }
}

/// Gesture state of a touchpad.
struct Pad {
    recognizer: touchpad::Recognizer,
    buttonpad: bool,
}

impl Pad {
    /// For touchpads (INPUT_PROP_POINTER with absolute position): axis
    /// ranges and resolution from the multitouch axes, else ABS_X/Y.
    fn for_device(device: &Device) -> Option<Pad> {
        let axes = device.supported_absolute_axes()?;
        if !device.properties().contains(PropType::POINTER) || !axes.contains(AbsoluteAxisCode::ABS_X) {
            return None;
        }
        let multitouch = axes.contains(AbsoluteAxisCode::ABS_MT_POSITION_X) && axes.contains(AbsoluteAxisCode::ABS_MT_SLOT);
        let (want_x, want_y) = if multitouch {
            (AbsoluteAxisCode::ABS_MT_POSITION_X, AbsoluteAxisCode::ABS_MT_POSITION_Y)
        } else {
            (AbsoluteAxisCode::ABS_X, AbsoluteAxisCode::ABS_Y)
        };
        let (mut x, mut y) = (None, None);
        for (code, info) in device.get_absinfo().ok()? {
            let range = Some((info.minimum(), info.maximum(), info.resolution()));
            if code == want_x {
                x = range;
            } else if code == want_y {
                y = range;
            }
        }
        let buttonpad = device.properties().contains(PropType::BUTTONPAD);
        let geometry = touchpad::Geometry::new(x?, y?);
        Some(Pad { recognizer: touchpad::Recognizer::new(geometry, multitouch), buttonpad })
    }
}

/// Raw touchpad contact state of one device: whether it is touched and by
/// how many fingers (BTN_TOUCH, BTN_TOOL_*). Changes within one evdev frame
/// are reported once, at SYN_REPORT.
#[derive(Default)]
struct Touch {
    touching: bool,
    fingers: u32,
    reported: (bool, u32),
}

impl Touch {
    /// Takes BTN_TOUCH / BTN_TOOL_* codes; false for anything else.
    fn key(&mut self, code: KeyCode, pressed: bool) -> bool {
        let fingers = match code {
            KeyCode::BTN_TOUCH => {
                self.touching = pressed;
                return true;
            }
            KeyCode::BTN_TOOL_FINGER => 1,
            KeyCode::BTN_TOOL_DOUBLETAP => 2,
            KeyCode::BTN_TOOL_TRIPLETAP => 3,
            KeyCode::BTN_TOOL_QUADTAP => 4,
            KeyCode::BTN_TOOL_QUINTTAP => 5,
            _ => return false,
        };
        if pressed {
            self.fingers = fingers;
        } else if self.fingers == fingers {
            self.fingers = 0;
        }
        true
    }

    /// At the end of a frame: Some((touching, fingers)) if that changed.
    /// A release reports the finger count that was lifted.
    fn frame_done(&mut self) -> Option<(bool, u32)> {
        let now = if self.touching {
            (true, self.fingers.max(1))
        } else {
            (false, self.reported.1)
        };
        if now == self.reported || (!now.0 && !self.reported.0) {
            return None;
        }
        self.reported = now;
        Some(now)
    }
}

/// X11/GNOME button numbers, as mutter maps them.
fn button_number(code: KeyCode) -> Option<u32> {
    match code {
        KeyCode::BTN_LEFT => Some(1),
        KeyCode::BTN_MIDDLE => Some(2),
        KeyCode::BTN_RIGHT => Some(3),
        KeyCode::BTN_SIDE => Some(8),
        KeyCode::BTN_EXTRA => Some(9),
        _ => None,
    }
}

/// Button-type codes that are not keyboard keys (touch tools, gamepad and
/// joystick buttons, other mouse buttons); never fed to the XKB translator.
fn is_other_button(code: KeyCode) -> bool {
    matches!(code.code(), 0x100..=0x15f | 0x220..=0x22f | 0x2c0..=0x2e7)
}

/// Drops subscribers whose connection left the bus (e.g. gnome-shell exited).
async fn forget_vanished(connection: Connection, subscribers: Subscribers) -> zbus::Result<()> {
    let mut changes = fdo::DBusProxy::new(&connection).await?.receive_name_owner_changed().await?;
    while let Some(change) = changes.next().await {
        let args = change.args()?;
        if let (BusName::Unique(name), None) = (args.name(), args.new_owner().as_ref())
            && subscribers.lock().unwrap().remove(&OwnedUniqueName::from(name.to_owned())).is_some()
        {
            eprintln!("subscriber gone: {name}");
        }
    }
    Ok(())
}

/// Exits once nobody has been subscribed for IDLE_TIMEOUT, e.g. after the
/// extension was disabled for a screen lock or turned off. The name goes
/// first, so a call from then on activates a new instance instead of
/// reaching this one; systemd stops a Type=dbus unit that drops its name
/// anyway. A Subscribe that slips in just before is lost with this process:
/// the client sees the name vanish and starts the helper again.
fn exit_when_idle(connection: Connection, subscribers: Subscribers) {
    let mut idle_since = Instant::now();
    loop {
        std::thread::sleep(IDLE_CHECK);
        if !subscribers.lock().unwrap().is_empty() {
            idle_since = Instant::now();
        } else if idle_since.elapsed() >= IDLE_TIMEOUT {
            break;
        }
    }
    eprintln!("no subscribers for {} s, exiting", IDLE_TIMEOUT.as_secs());
    if let Err(e) = zbus::block_on(connection.release_name(NAME)) {
        eprintln!("releasing {NAME}: {e}");
    }
    std::process::exit(0);
}

/// `max-detail` from /etc/rg-helper.conf; the default when there is none.
fn read_config() -> Detail {
    let text = match std::fs::read_to_string(detail::CONFIG_PATH) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return detail::DEFAULT_MAX,
        Err(e) => {
            eprintln!("{}: {e}", detail::CONFIG_PATH);
            return detail::DEFAULT_MAX;
        }
    };
    let (max, problems) = detail::parse_config(&text);
    for problem in problems {
        eprintln!("{}: {problem}", detail::CONFIG_PATH);
    }
    max
}

fn arg(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1).cloned())
}

fn is_keyboard(device: &Device) -> bool {
    device
        .supported_keys()
        .is_some_and(|keys| keys.contains(KeyCode::KEY_A) && keys.contains(KeyCode::KEY_ENTER))
}

/// Mice (relative motion + left button), absolute pointers (left button +
/// absolute position, e.g. the QEMU/SPICE tablet that carries the pointer
/// in VMs) and touchpads (INPUT_PROP_POINTER with absolute position).
/// Touchscreens (INPUT_PROP_DIRECT) and gamepads are left out.
fn is_pointer(device: &Device) -> bool {
    let left_button = device.supported_keys().is_some_and(|k| k.contains(KeyCode::BTN_LEFT));
    let abs_xy = device
        .supported_absolute_axes()
        .is_some_and(|a| a.contains(AbsoluteAxisCode::ABS_X) && a.contains(AbsoluteAxisCode::ABS_Y));
    let mouse = left_button
        && device
            .supported_relative_axes()
            .is_some_and(|r| r.contains(RelativeAxisCode::REL_X) && r.contains(RelativeAxisCode::REL_Y));
    let absolute = left_button && abs_xy && !device.properties().contains(PropType::DIRECT);
    let touchpad = device.properties().contains(PropType::POINTER) && abs_xy;
    mouse || absolute || touchpad
}

/// Open input devices by path, each with the generation it was opened in,
/// so a reader thread that ends late cannot drop a newer device that took
/// over its path.
#[derive(Clone)]
struct Devices {
    open: Arc<Mutex<HashMap<PathBuf, u64>>>,
    generation: Arc<Mutex<u64>>,
    sink: Sink,
}

impl Devices {
    /// Opens `path` if it is a keyboard or pointer not read yet, and starts
    /// its reader thread. Returns true if it was opened. `quiet` hides open
    /// errors: on hotplug udev sets group and mode in several steps, so the
    /// first IN_CREATE/IN_ATTRIB attempts fail and a later one succeeds.
    fn try_open(&self, path: &Path, quiet: bool) -> bool {
        let is_event_node = path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("event"));
        if !is_event_node || self.open.lock().unwrap().contains_key(path) {
            return false;
        }
        let device = match Device::open(path) {
            Ok(device) => device,
            Err(e) => {
                if !quiet {
                    eprintln!("{}: {e}", path.display());
                }
                return false;
            }
        };
        if !is_keyboard(&device) && !is_pointer(&device) {
            return false;
        }
        let generation = {
            let mut generation = self.generation.lock().unwrap();
            *generation += 1;
            *generation
        };
        {
            let mut open = self.open.lock().unwrap();
            if open.contains_key(path) {
                return false; // another event opened it meanwhile
            }
            open.insert(path.to_owned(), generation);
        }
        eprintln!("reading {} ({})", path.display(), device.name().unwrap_or("?"));
        let (devices, path) = (self.clone(), path.to_owned());
        std::thread::spawn(move || {
            read_device(device, devices.sink.clone());
            let mut open = devices.open.lock().unwrap();
            if open.get(&path) == Some(&generation) {
                open.remove(&path);
            }
        });
        true
    }

    /// The node is gone; its reader ends on its own with ENODEV.
    fn forget(&self, path: &Path) {
        self.open.lock().unwrap().remove(path);
    }

    /// Opens what is there now, then follows /dev/input forever.
    fn watch(&self) -> nix::Result<()> {
        let dir = Path::new("/dev/input");
        // Watch first, then enumerate, so no device falls in between
        let inotify = Inotify::init(InitFlags::IN_CLOEXEC)?;
        inotify.add_watch(
            dir,
            AddWatchFlags::IN_CREATE | AddWatchFlags::IN_ATTRIB | AddWatchFlags::IN_DELETE,
        )?;
        let mut found = 0;
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                found += usize::from(self.try_open(&entry.path(), false));
            }
        }
        if found == 0 {
            eprintln!("no readable keyboards or pointers yet (input group / permissions?)");
        }
        loop {
            for event in inotify.read_events()? {
                let Some(name) = event.name else { continue };
                let path = dir.join(name);
                if event.mask.contains(AddWatchFlags::IN_DELETE) {
                    self.forget(&path);
                } else {
                    self.try_open(&path, true);
                }
            }
        }
    }
}

fn read_device(mut device: Device, sink: Sink) {
    let name = device.name().unwrap_or("?").to_string();
    let mut touch = Touch::default();
    let mut pad = Pad::for_device(&device);
    if pad.is_some() {
        eprintln!("{name}: touchpad gestures");
    }
    loop {
        let events = match device.fetch_events() {
            Ok(events) => events,
            Err(e) => {
                eprintln!("{name}: {e}");
                return;
            }
        };
        for event in events {
            let now_ms = event
                .timestamp()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
            sink.handle(event.destructure(), now_ms, &mut touch, pad.as_mut());
        }
    }
}

fn main() -> zbus::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let layout = arg(&args, "--layout").unwrap_or_else(|| "us".into());
    let variant = arg(&args, "--variant").unwrap_or_default();
    let options = arg(&args, "--options").unwrap_or_default();

    let max_detail = arg(&args, "--max-detail")
        .map(|d| d.parse().unwrap_or_else(|()| panic!("--max-detail: unknown level {d:?}")))
        .unwrap_or_else(read_config);
    eprintln!("key detail ceiling: {max_detail}");

    let subscribers: Subscribers = Arc::default();
    let translator = Arc::new(Mutex::new(xkb::Translator::new(&layout, &variant, &options)));
    let system = zbus::block_on(Connection::system())?;

    let helper = Helper {
        subscribers: subscribers.clone(),
        translator: translator.clone(),
        system: system.clone(),
        max_detail,
    };
    let builder = if args.iter().any(|a| a == "--session") {
        zbus::connection::Builder::session()
    } else {
        zbus::connection::Builder::system()
    };
    let connection = zbus::block_on(builder.name(NAME).serve_at(PATH, helper).build())?;
    eprintln!("owning {NAME}");

    {
        let (connection, subscribers) = (connection.clone(), subscribers.clone());
        std::thread::spawn(move || {
            if let Err(e) = zbus::block_on(forget_vanished(connection, subscribers)) {
                eprintln!("name watch: {e}");
            }
        });
    }

    if args.iter().any(|a| a == "--exit-idle") {
        let (connection, subscribers) = (connection.clone(), subscribers.clone());
        std::thread::spawn(move || exit_when_idle(connection, subscribers));
    }

    let receiver = session::Receiver::default();
    {
        let receiver = receiver.clone();
        std::thread::spawn(move || {
            if let Err(e) = zbus::block_on(session::watch(system, receiver)) {
                // Without the watch the receiver stays None: fail closed
                eprintln!("session watch: {e}");
            }
        });
    }

    let sink = Sink {
        connection,
        subscribers,
        receiver,
        translator,
        last_motion: Arc::default(),
    };

    if args.iter().any(|a| a == "--demo") {
        loop {
            std::thread::sleep(Duration::from_secs(1));
            sink.key(true, &xkb::Key { full: "demo".into(), base: "demo".into(), command: false });
            sink.emit("Button", &(true, 1u32));
            sink.emit("Wheel", &("up",));
            sink.motion();
            sink.emit("Touch", &(true, 2u32));
            sink.emit("Tap", &(1u32,));
            sink.emit("Scroll", &("down",));
        }
    }

    let devices = Devices {
        open: Arc::default(),
        generation: Arc::default(),
        sink,
    };
    if let Err(e) = devices.watch() {
        eprintln!("watching /dev/input: {e}");
        std::process::exit(1);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{Touch, button_number, is_other_button, valid_layout_names};
    use evdev::KeyCode;

    #[test]
    fn buttons() {
        assert_eq!(button_number(KeyCode::BTN_LEFT), Some(1));
        assert_eq!(button_number(KeyCode::BTN_MIDDLE), Some(2));
        assert_eq!(button_number(KeyCode::BTN_RIGHT), Some(3));
        assert_eq!(button_number(KeyCode::BTN_SIDE), Some(8));
        assert_eq!(button_number(KeyCode::BTN_EXTRA), Some(9));
        assert_eq!(button_number(KeyCode::KEY_A), None);
        // Touchpad tool codes are neither buttons nor keys
        assert!(is_other_button(KeyCode::BTN_TOUCH));
        assert!(is_other_button(KeyCode::BTN_TOOL_FINGER));
        assert!(!is_other_button(KeyCode::KEY_A));
        assert!(!is_other_button(KeyCode::KEY_VOLUMEUP));
    }

    #[test]
    fn touch_frames() {
        let mut t = Touch::default();
        // one finger down
        t.key(KeyCode::BTN_TOUCH, true);
        t.key(KeyCode::BTN_TOOL_FINGER, true);
        assert_eq!(t.frame_done(), Some((true, 1)));
        // motion frame, nothing changes
        assert_eq!(t.frame_done(), None);
        // second finger: FINGER off, DOUBLETAP on in the same frame
        t.key(KeyCode::BTN_TOOL_FINGER, false);
        t.key(KeyCode::BTN_TOOL_DOUBLETAP, true);
        assert_eq!(t.frame_done(), Some((true, 2)));
        // all fingers up
        t.key(KeyCode::BTN_TOOL_DOUBLETAP, false);
        t.key(KeyCode::BTN_TOUCH, false);
        assert_eq!(t.frame_done(), Some((false, 2)));
        assert_eq!(t.frame_done(), None);
        // a non-touch key is not taken
        assert!(!t.key(KeyCode::BTN_LEFT, true));
    }

    #[test]
    fn layout_names() {
        assert!(valid_layout_names("de", "nodeadkeys", ""));
        assert!(valid_layout_names("us", "", "ctrl:nocaps,compose:ralt"));
        assert!(!valid_layout_names("", "", ""));
        assert!(!valid_layout_names("../../etc/passwd", "", ""));
        assert!(!valid_layout_names("de", "nodeadkeys(evil)", ""));
        assert!(!valid_layout_names("de", "", "a/b"));
        assert!(!valid_layout_names(&"x".repeat(257), "", ""));
    }
}
