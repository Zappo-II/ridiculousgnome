// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

//! Touchpad gestures from raw evdev: what libinput would make of the
//! contacts, as far as the extension needs it to show them (contract 4).
//!
//! libinput turns taps into clicks, two fingers into scrolling and a
//! clickpad press into left, right or middle; none of that reaches evdev.
//! This module recognises the same from slot positions, finger count and
//! the pad button, and reports *facts* — the extension applies the user's
//! GNOME touchpad settings (tap-to-click, click method, natural scrolling).
//!
//! One contact runs from the first finger down to the last one up. Within
//! it, each finger count is one gesture: undecided until a finger moved
//! MOVE_MM, then decided by how the fingers moved — all alike (similar
//! distance, similar direction): scroll (2 fingers) or swipe (3+); the
//! spread changing: pinch, also with one finger resting. That holds until
//! the finger count changes. Scroll and pinch report in steps, so a
//! change of direction within one gesture shows. Thresholds are in millimetres
//! (axis resolution), so they hold on any pad size. Pure logic, no I/O:
//! the caller feeds events and gets `Output`s back.

/// A contact this short and still, without a pad press, is a tap
/// (libinput's tap timeout is 180 ms).
pub const TAP_MS: u64 = 180;
pub const TAP_MOVE_MM: f64 = 1.5;
/// Travel of the most-moved finger that decides a two- or more-finger
/// gesture.
pub const MOVE_MM: f64 = 2.5;
/// Fingers move "alike" when each moved at least this share of the
/// most-moved one, with directions within ~45° (cosine).
const ALIKE_SHARE: f64 = 0.5;
const ALIKE_COS: f64 = 0.7;
/// A pinch: the spread changed by at least this share of the most-moved
/// finger's travel (one finger resting: 0.5, both moving apart: 1).
const PINCH_SHARE: f64 = 0.35;
/// No decision after this much travel: give the gesture up.
const UNDECIDED_MAX_MM: f64 = 10.0;
/// One `Pinch` per this much change of the spread (mean distance from the
/// fingers' centre).
pub const PINCH_STEP_MM: f64 = 4.0;
/// One `Scroll` per this much two-finger travel.
pub const SCROLL_STEP_MM: f64 = 10.0;
/// Travel after which a swipe is reported (once per gesture).
pub const SWIPE_MM: f64 = 12.0;
/// Height of the software button area at the bottom of a clickpad.
pub const BUTTON_AREA_MM: f64 = 10.0;
/// Most slots tracked; pads have 2–5, ten fingers is the limit anyway.
const MAX_SLOTS: usize = 10;

/// Axis ranges and resolution (units per mm) of a touchpad.
#[derive(Clone, Copy, Debug)]
pub struct Geometry {
    pub x_min: i32,
    pub x_max: i32,
    pub y_min: i32,
    pub y_max: i32,
    pub x_res: f64,
    pub y_res: f64,
}

impl Geometry {
    /// Resolution 0 (unknown): assume a pad about 100 × 60 mm.
    pub fn new(x: (i32, i32, i32), y: (i32, i32, i32)) -> Self {
        let res = |(min, max, res): (i32, i32, i32), mm: f64| {
            if res > 0 { f64::from(res) } else { f64::from((max - min).max(1)) / mm }
        };
        Geometry { x_min: x.0, x_max: x.1, y_min: y.0, y_max: y.1, x_res: res(x, 100.0), y_res: res(y, 60.0) }
    }

    fn mm(&self, (x, y): (i32, i32)) -> (f64, f64) {
        (f64::from(x - self.x_min) / self.x_res, f64::from(y - self.y_min) / self.y_res)
    }

    fn height_mm(&self) -> f64 {
        f64::from(self.y_max - self.y_min) / self.y_res
    }

    fn width_mm(&self) -> f64 {
        f64::from(self.x_max - self.x_min) / self.x_res
    }
}

/// What a frame produced, in order.
#[derive(Clone, Debug, PartialEq)]
pub enum Output {
    Tap { fingers: u32 },
    /// A clickpad press or release; `area` is where the lowest finger is:
    /// "right" in the right half of the button area, else "left".
    PadButton { pressed: bool, fingers: u32, area: &'static str },
    /// Two fingers moved this way (finger direction, not scroll direction).
    Scroll { dir: &'static str },
    Swipe { fingers: u32, dir: &'static str },
    /// One step of the spread changing, `out` or `in`.
    Pinch { fingers: u32, dir: &'static str },
}

#[derive(Clone, Copy, Default)]
struct Slot {
    active: bool,
    pos: (i32, i32),
    /// Where this finger touched down (mm), for the tap's travel.
    origin: Option<(f64, f64)>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    Undecided,
    Scroll,
    Swipe { reported: bool },
    Pinch,
    /// One finger moving the pointer, or a gesture given up
    None,
}

pub struct Recognizer {
    geometry: Geometry,
    slots: [Slot; MAX_SLOTS],
    slot: usize,
    /// Single-touch pads (no ABS_MT_*): ABS_X/Y is the one finger.
    multitouch: bool,
    /// Finger count from BTN_TOOL_*, can exceed the slots.
    fingers: u32,
    touching: bool,
    /// The current contact: start time, most fingers, pad pressed in it,
    /// most travel of any finger.
    contact: Option<Contact>,
    /// The current gesture (one finger count within the contact).
    gesture: Gesture,
    /// Button pressed: what was reported, so the release matches.
    pressed: Option<(u32, &'static str)>,
    pending_button: Option<bool>,
}

struct Contact {
    start_ms: u64,
    max_fingers: u32,
    pad_pressed: bool,
    travel_mm: f64,
}

struct Gesture {
    kind: Kind,
    fingers: u32,
    /// Active slots and their positions (mm) when the gesture started
    base: Vec<(usize, (f64, f64))>,
    base_spread: f64,
    /// Scroll travel not yet reported, along the axis that decided it
    scroll_rest: (f64, f64),
    last_centroid: (f64, f64),
    /// Spread at the last pinch step
    pinch_ref: f64,
}

impl Gesture {
    fn idle() -> Self {
        Gesture {
            kind: Kind::None,
            fingers: 0,
            base: Vec::new(),
            base_spread: 0.0,
            scroll_rest: (0.0, 0.0),
            last_centroid: (0.0, 0.0),
            pinch_ref: 0.0,
        }
    }
}

fn dir_of((dx, dy): (f64, f64)) -> &'static str {
    if dx.abs() >= dy.abs() {
        if dx > 0.0 { "right" } else { "left" }
    } else if dy > 0.0 {
        "down"
    } else {
        "up"
    }
}

fn dist((ax, ay): (f64, f64), (bx, by): (f64, f64)) -> f64 {
    ((ax - bx).powi(2) + (ay - by).powi(2)).sqrt()
}

impl Recognizer {
    pub fn new(geometry: Geometry, multitouch: bool) -> Self {
        Recognizer {
            geometry,
            slots: [Slot::default(); MAX_SLOTS],
            slot: 0,
            multitouch,
            fingers: 0,
            touching: false,
            contact: None,
            gesture: Gesture::idle(),
            pressed: None,
            pending_button: None,
        }
    }

    pub fn set_slot(&mut self, slot: i32) {
        self.slot = usize::try_from(slot).unwrap_or(0).min(MAX_SLOTS - 1);
    }

    /// ABS_MT_TRACKING_ID: -1 lifts the finger of the current slot.
    pub fn set_tracking_id(&mut self, id: i32) {
        let slot = &mut self.slots[self.slot];
        slot.active = id >= 0;
        if !slot.active {
            slot.origin = None;
        }
    }

    pub fn set_x(&mut self, x: i32) {
        self.slots[self.slot].pos.0 = x;
    }

    pub fn set_y(&mut self, y: i32) {
        self.slots[self.slot].pos.1 = y;
    }

    /// ABS_X / ABS_Y; only used on pads without multitouch.
    pub fn set_single(&mut self, x: Option<i32>, y: Option<i32>) {
        if self.multitouch {
            return;
        }
        if let Some(x) = x {
            self.slots[0].pos.0 = x;
        }
        if let Some(y) = y {
            self.slots[0].pos.1 = y;
        }
    }

    pub fn set_touching(&mut self, touching: bool) {
        self.touching = touching;
        if !self.multitouch {
            self.slots[0].active = touching;
            if !touching {
                self.slots[0].origin = None;
            }
        }
    }

    /// BTN_TOOL_* already counted into `fingers` by the caller.
    pub fn set_fingers(&mut self, fingers: u32) {
        self.fingers = fingers;
    }

    /// BTN_LEFT on a buttonpad.
    pub fn set_button(&mut self, pressed: bool) {
        self.pending_button = Some(pressed);
    }

    fn active(&self) -> Vec<(usize, (f64, f64))> {
        self.slots
            .iter()
            .enumerate()
            .filter(|(_, s)| s.active)
            .map(|(i, s)| (i, self.geometry.mm(s.pos)))
            .collect()
    }

    /// At SYN_REPORT, with the frame's time in ms.
    pub fn frame(&mut self, now_ms: u64) -> Vec<Output> {
        let mut out = Vec::new();
        let fingers = if self.touching { self.fingers.max(1) } else { 0 };
        let active = self.active();

        // Contact start and finger travel
        if fingers > 0 && self.contact.is_none() {
            self.contact = Some(Contact { start_ms: now_ms, max_fingers: 0, pad_pressed: false, travel_mm: 0.0 });
        }
        for &(i, pos) in &active {
            let origin = *self.slots[i].origin.get_or_insert(pos);
            if let Some(contact) = &mut self.contact {
                contact.travel_mm = contact.travel_mm.max(dist(origin, pos));
            }
        }
        if let Some(contact) = &mut self.contact {
            contact.max_fingers = contact.max_fingers.max(fingers);
        }

        // Pad button: report where the lowest finger is
        if let Some(pressed) = self.pending_button.take() {
            if pressed {
                let lowest = active.iter().map(|&(_, p)| p).max_by(|a, b| a.1.total_cmp(&b.1));
                let area = match lowest {
                    Some((x, y)) if y >= self.geometry.height_mm() - BUTTON_AREA_MM && x > self.geometry.width_mm() / 2.0 => "right",
                    _ => "left",
                };
                let fingers = fingers.max(1);
                self.pressed = Some((fingers, area));
                if let Some(contact) = &mut self.contact {
                    contact.pad_pressed = true;
                }
                out.push(Output::PadButton { pressed: true, fingers, area });
            } else if let Some((fingers, area)) = self.pressed.take() {
                out.push(Output::PadButton { pressed: false, fingers, area });
            }
        }

        // Gestures: a new one whenever the finger count changes
        if fingers != self.gesture.fingers {
            self.gesture = if fingers >= 2 && self.pressed.is_none() {
                let centroid = centroid(&active);
                Gesture {
                    kind: Kind::Undecided,
                    fingers,
                    base_spread: spread(&active, centroid),
                    base: active.clone(),
                    scroll_rest: (0.0, 0.0),
                    last_centroid: centroid,
                    pinch_ref: 0.0,
                }
            } else {
                Gesture { fingers, ..Gesture::idle() }
            };
        } else if self.gesture.kind != Kind::None && active.len() >= 2 {
            self.gesture_frame(&active, &mut out);
        }

        // Contact end: a tap if short, still, not pressed, no gesture
        if fingers == 0 {
            if let Some(contact) = self.contact.take()
                && now_ms.saturating_sub(contact.start_ms) < TAP_MS
                && contact.travel_mm < TAP_MOVE_MM
                && !contact.pad_pressed
                && contact.max_fingers <= 3
            {
                out.push(Output::Tap { fingers: contact.max_fingers.max(1) });
            }
            self.gesture = Gesture::idle();
        }
        out
    }

    fn gesture_frame(&mut self, active: &[(usize, (f64, f64))], out: &mut Vec<Output>) {
        // Only the fingers that were there at the start count; a slot that
        // came or went without a change of BTN_TOOL_* starts over
        let same: Vec<_> = active.iter().filter(|(i, _)| self.gesture.base.iter().any(|(b, _)| b == i)).copied().collect();
        if same.len() != self.gesture.base.len() {
            let centroid = centroid(active);
            self.gesture.base = active.to_vec();
            self.gesture.base_spread = spread(active, centroid);
            self.gesture.last_centroid = centroid;
            return;
        }
        let base_centroid = centroid(&self.gesture.base);
        let now_centroid = centroid(&same);
        let travel = (now_centroid.0 - base_centroid.0, now_centroid.1 - base_centroid.1);
        let spread_change = spread(&same, now_centroid) - self.gesture.base_spread;
        let fingers = self.gesture.fingers;

        if self.gesture.kind == Kind::Undecided {
            // Each finger's way since the gesture started
            let moves: Vec<(f64, f64)> = same
                .iter()
                .map(|(i, p)| {
                    let base = self.gesture.base.iter().find(|(b, _)| b == i).map_or(*p, |(_, b)| *b);
                    (p.0 - base.0, p.1 - base.1)
                })
                .collect();
            let lengths: Vec<f64> = moves.iter().map(|m| dist(*m, (0.0, 0.0))).collect();
            let most = lengths.iter().copied().fold(0.0, f64::max);
            if most >= MOVE_MM {
                let least = lengths.iter().copied().fold(f64::INFINITY, f64::min);
                let alike = least >= ALIKE_SHARE * most
                    && moves.iter().enumerate().all(|(a, ma)| {
                        moves[a + 1..].iter().all(|mb| {
                            (ma.0 * mb.0 + ma.1 * mb.1) >= ALIKE_COS * dist(*ma, (0.0, 0.0)) * dist(*mb, (0.0, 0.0))
                        })
                    });
                if alike {
                    self.gesture.kind = if fingers == 2 { Kind::Scroll } else { Kind::Swipe { reported: false } };
                } else if spread_change.abs() >= PINCH_SHARE * most {
                    self.gesture.kind = Kind::Pinch;
                    self.gesture.pinch_ref = self.gesture.base_spread;
                } else if most >= UNDECIDED_MAX_MM {
                    self.gesture.kind = Kind::None;
                }
            }
        }
        match self.gesture.kind {
            Kind::Scroll => {
                let step = (now_centroid.0 - self.gesture.last_centroid.0, now_centroid.1 - self.gesture.last_centroid.1);
                self.gesture.last_centroid = now_centroid;
                let rest = &mut self.gesture.scroll_rest;
                rest.0 += step.0;
                rest.1 += step.1;
                // Report the dominant axis in steps; the other one decays
                // so a slightly diagonal scroll does not add sideways steps
                while rest.0.abs().max(rest.1.abs()) >= SCROLL_STEP_MM {
                    let dir = dir_of(*rest);
                    out.push(Output::Scroll { dir });
                    match dir {
                        "left" => rest.0 += SCROLL_STEP_MM,
                        "right" => rest.0 -= SCROLL_STEP_MM,
                        "up" => rest.1 += SCROLL_STEP_MM,
                        _ => rest.1 -= SCROLL_STEP_MM,
                    }
                    if matches!(dir, "left" | "right") {
                        rest.1 = 0.0;
                    } else {
                        rest.0 = 0.0;
                    }
                }
            }
            Kind::Swipe { reported: false } if dist(travel, (0.0, 0.0)) >= SWIPE_MM => {
                out.push(Output::Swipe { fingers, dir: dir_of(travel) });
                self.gesture.kind = Kind::Swipe { reported: true };
            }
            Kind::Pinch => {
                // In steps, so going back and forth shows both ways
                let now = self.gesture.base_spread + spread_change;
                while (now - self.gesture.pinch_ref).abs() >= PINCH_STEP_MM {
                    let out_ward = now > self.gesture.pinch_ref;
                    out.push(Output::Pinch { fingers, dir: if out_ward { "out" } else { "in" } });
                    self.gesture.pinch_ref += if out_ward { PINCH_STEP_MM } else { -PINCH_STEP_MM };
                }
            }
            _ => {}
        }
    }
}

fn centroid(points: &[(usize, (f64, f64))]) -> (f64, f64) {
    if points.is_empty() {
        return (0.0, 0.0);
    }
    let n = points.len() as f64;
    let (sx, sy) = points.iter().fold((0.0, 0.0), |(sx, sy), (_, (x, y))| (sx + x, sy + y));
    (sx / n, sy / n)
}

/// Mean distance of the fingers from their centroid.
fn spread(points: &[(usize, (f64, f64))], centroid: (f64, f64)) -> f64 {
    if points.is_empty() {
        return 0.0;
    }
    points.iter().map(|(_, p)| dist(*p, centroid)).sum::<f64>() / points.len() as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 100 × 60 mm pad, 10 units per mm
    fn pad() -> Recognizer {
        Recognizer::new(Geometry::new((0, 1000, 10), (0, 600, 10)), true)
    }

    /// Puts fingers (slot, x mm, y mm) down or moves them, then a frame.
    fn frame(r: &mut Recognizer, t: u64, fingers: &[(i32, f64, f64)]) -> Vec<Output> {
        for slot in 0..MAX_SLOTS as i32 {
            let found = fingers.iter().find(|(s, _, _)| *s == slot);
            r.set_slot(slot);
            match found {
                Some(&(_, x, y)) => {
                    if !r.slots[slot as usize].active {
                        r.set_tracking_id(slot + 100);
                    }
                    r.set_x((x * 10.0) as i32);
                    r.set_y((y * 10.0) as i32);
                }
                None if r.slots[slot as usize].active => r.set_tracking_id(-1),
                None => {}
            }
        }
        r.set_touching(!fingers.is_empty());
        r.set_fingers(fingers.len() as u32);
        r.frame(t)
    }

    #[test]
    fn one_finger_tap() {
        let mut r = pad();
        assert!(frame(&mut r, 0, &[(0, 50.0, 30.0)]).is_empty());
        assert!(frame(&mut r, 50, &[(0, 50.3, 30.2)]).is_empty());
        assert_eq!(frame(&mut r, 100, &[]), vec![Output::Tap { fingers: 1 }]);
    }

    #[test]
    fn two_finger_tap_with_fingers_landing_apart() {
        let mut r = pad();
        frame(&mut r, 0, &[(0, 40.0, 30.0)]);
        frame(&mut r, 30, &[(0, 40.0, 30.0), (1, 60.0, 30.0)]);
        assert_eq!(frame(&mut r, 120, &[]), vec![Output::Tap { fingers: 2 }]);
    }

    #[test]
    fn slow_or_moving_touch_is_no_tap() {
        let mut r = pad();
        frame(&mut r, 0, &[(0, 50.0, 30.0)]);
        assert!(frame(&mut r, 300, &[]).is_empty());
        frame(&mut r, 1000, &[(0, 50.0, 30.0)]);
        frame(&mut r, 1050, &[(0, 55.0, 30.0)]);
        assert!(frame(&mut r, 1100, &[]).is_empty());
    }

    #[test]
    fn press_is_no_tap_and_reports_area() {
        let mut r = pad();
        frame(&mut r, 0, &[(0, 80.0, 55.0)]);
        r.set_button(true);
        assert_eq!(
            frame(&mut r, 20, &[(0, 80.0, 55.0)]),
            vec![Output::PadButton { pressed: true, fingers: 1, area: "right" }]
        );
        r.set_button(false);
        assert_eq!(
            frame(&mut r, 60, &[(0, 80.0, 55.0)]),
            vec![Output::PadButton { pressed: false, fingers: 1, area: "right" }]
        );
        assert!(frame(&mut r, 90, &[]).is_empty());
        // Upper half, two fingers: left area, finger count for clickfinger
        frame(&mut r, 1000, &[(0, 80.0, 20.0), (1, 60.0, 20.0)]);
        r.set_button(true);
        assert_eq!(
            frame(&mut r, 1020, &[(0, 80.0, 20.0), (1, 60.0, 20.0)]),
            vec![Output::PadButton { pressed: true, fingers: 2, area: "left" }]
        );
    }

    #[test]
    fn two_finger_scroll() {
        let mut r = pad();
        frame(&mut r, 0, &[(0, 40.0, 20.0), (1, 55.0, 20.0)]);
        let mut out = Vec::new();
        for step in 1..=25 {
            let y = 20.0 + f64::from(step);
            out.extend(frame(&mut r, step as u64 * 10, &[(0, 40.0, y), (1, 55.0, y)]));
        }
        assert_eq!(out, vec![Output::Scroll { dir: "down" }, Output::Scroll { dir: "down" }]);
        assert!(frame(&mut r, 400, &[]).is_empty());
    }

    #[test]
    fn three_finger_swipe_once() {
        let mut r = pad();
        frame(&mut r, 0, &[(0, 30.0, 30.0), (1, 45.0, 30.0), (2, 60.0, 30.0)]);
        let mut out = Vec::new();
        for step in 1..=30 {
            let dx = -f64::from(step);
            out.extend(frame(&mut r, step as u64 * 10, &[(0, 30.0 + dx, 30.0), (1, 45.0 + dx, 30.0), (2, 60.0 + dx, 30.0)]));
        }
        assert_eq!(out, vec![Output::Swipe { fingers: 3, dir: "left" }]);
    }

    fn pinches(out: &[Output]) -> Vec<&'static str> {
        out.iter()
            .map(|o| match o {
                Output::Pinch { dir, .. } => *dir,
                other => panic!("not a pinch: {other:?}"),
            })
            .collect()
    }

    #[test]
    fn pinch_out_then_in() {
        let mut r = pad();
        frame(&mut r, 0, &[(0, 45.0, 30.0), (1, 55.0, 30.0)]);
        let mut out = Vec::new();
        let mut t = 0;
        // apart by 10 mm each (spread +10), then back by 10 mm each
        for d in (1..=10).chain((0..10).rev()) {
            t += 10;
            let d = f64::from(d);
            out.extend(frame(&mut r, t, &[(0, 45.0 - d, 30.0), (1, 55.0 + d, 30.0)]));
        }
        assert_eq!(pinches(&out), vec!["out", "out", "in", "in"]);
    }

    #[test]
    fn pinch_with_one_finger_resting_is_no_scroll() {
        let mut r = pad();
        frame(&mut r, 0, &[(0, 30.0, 40.0), (1, 40.0, 35.0)]);
        let mut out = Vec::new();
        // the thumb rests, the other finger moves away diagonally 20 mm
        for step in 1..=20 {
            let d = f64::from(step) * 0.7;
            out.extend(frame(&mut r, step as u64 * 10, &[(0, 30.0, 40.0), (1, 40.0 + d, 35.0 - d)]));
        }
        assert!(!out.is_empty());
        assert!(pinches(&out).iter().all(|d| *d == "out"));
    }

    #[test]
    fn scroll_with_uneven_fingers_is_still_scroll() {
        let mut r = pad();
        frame(&mut r, 0, &[(0, 40.0, 40.0), (1, 55.0, 40.0)]);
        let mut out = Vec::new();
        for step in 1..=25 {
            let y = f64::from(step);
            out.extend(frame(&mut r, step as u64 * 10, &[(0, 40.0, 40.0 - y), (1, 55.3, 40.0 - y * 0.8)]));
        }
        assert!(!out.is_empty());
        assert!(out.iter().all(|o| *o == Output::Scroll { dir: "up" }), "{out:?}");
    }

    #[test]
    fn unknown_resolution_is_estimated() {
        let g = Geometry::new((0, 2000, 0), (0, 1200, 0));
        assert!((g.x_res - 20.0).abs() < 1e-9);
        assert!((g.y_res - 20.0).abs() < 1e-9);
    }
}
