// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

//! evdev keycode -> label translation via kbvm (pure-Rust XKB).
//!
//! One keymap and one modifier state for all keyboards, fed with every key
//! event like a compositor does. Labels are the typed character for
//! printable keys and the keysym name otherwise; the extension's
//! keyLabels.js formatKey() turns names like "Return" into display labels.
//! A release carries the label of its press, so the extension can pair them
//! (held keys and modifiers in presentation mode).
//!
//! Each key also gets its level-1 label (no modifiers: `t` for Ctrl+Shift+T)
//! and whether Ctrl, Alt or Super were held — the `shortcuts` detail level
//! shows that label for shortcuts only. AltGr is not among them: on most
//! layouts it is ISO_Level3 (Mod5) and types characters like `@`.

use std::collections::HashMap;

use kbvm::lookup::LookupTable;
use kbvm::state_machine::{Direction, Event, State, StateMachine};
use kbvm::xkb::Context;
use kbvm::xkb::diagnostic::Diagnostic;
use kbvm::xkb::rmlvo::Group;
use kbvm::{Components, Keycode, ModifierMask};

/// Modifiers that make a key a shortcut.
const COMMAND_MODS: u32 = ModifierMask::CONTROL.0 | ModifierMask::ALT.0 | ModifierMask::SUPER.0;

/// One key press as the detail levels need it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Key {
    /// Typed character, or keysym name for non-printing keys.
    pub full: String,
    /// The same without any modifier (level 1 of the first group).
    pub base: String,
    /// Ctrl, Alt or Super held at the press.
    pub command: bool,
}

pub struct Translator {
    state_machine: StateMachine,
    state: State,
    lookup: LookupTable,
    components: Components,
    events: Vec<Event>,
    /// Each key held down, by evdev code
    held: HashMap<u32, Key>,
}

impl Translator {
    /// Builds a keymap from layout / variant / comma-separated xkb options,
    /// e.g. ("de", "nodeadkeys", "").
    pub fn new(layout: &str, variant: &str, options: &str) -> Self {
        let mut builder = Context::builder();
        // The helper runs as a system service: never pick up keymap paths
        // or defaults from the environment.
        builder.enable_environment(false);
        let context = builder.build();

        let groups = [Group { layout, variant }];
        let options: Vec<&str> = options.split(',').filter(|o| !o.is_empty()).collect();
        let mut diagnostics: Vec<Diagnostic> = Vec::new();
        let keymap = context.keymap_from_names(
            &mut diagnostics,
            None,
            None,
            Some(&groups),
            Some(&options),
        );
        let builder = keymap.to_builder();
        let state_machine = builder.build_state_machine();
        let state = state_machine.create_state();
        Self {
            state_machine,
            state,
            lookup: builder.build_lookup_table(),
            components: Components::default(),
            events: Vec::new(),
            held: HashMap::new(),
        }
    }

    /// Feeds one evdev key event (code from linux/input-event-codes.h).
    /// Returns the key on press, and the same key again on release.
    pub fn key(&mut self, evdev_code: u32, down: bool) -> Option<Key> {
        let direction = if down { Direction::Down } else { Direction::Up };
        self.events.clear();
        self.state_machine.handle_key(
            &mut self.state,
            &mut self.events,
            Keycode::from_evdev(evdev_code),
            direction,
        );

        let mut key = None;
        for &event in &self.events {
            self.components.apply_event(event);
            if let Event::KeyDown(keycode) = event {
                key = self.label(keycode, self.components.mods).map(|full| Key {
                    base: self.label(keycode, ModifierMask::NONE).unwrap_or_else(|| full.clone()),
                    command: self.components.mods_pressed.0 & COMMAND_MODS != 0,
                    full,
                });
            }
        }
        if !down {
            return self.held.remove(&evdev_code);
        }
        if let Some(key) = &key {
            self.held.insert(evdev_code, key.clone());
        }
        key
    }

    fn label(&self, keycode: Keycode, mods: ModifierMask) -> Option<String> {
        let lookup = self.lookup.lookup(self.components.group, mods, keycode);
        let props = lookup.into_iter().next()?;
        match props.char() {
            Some(c) if !c.is_control() => Some(c.to_string()),
            _ => props.keysym().name().map(str::to_string),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Key, Translator};

    // evdev codes, linux/input-event-codes.h
    const KEY_ESC: u32 = 1;
    const KEY_2: u32 = 3;
    const KEY_EQUAL: u32 = 13;
    const KEY_BACKSPACE: u32 = 14;
    const KEY_TAB: u32 = 15;
    const KEY_Q: u32 = 16;
    const KEY_E: u32 = 18;
    const KEY_Y: u32 = 21;
    const KEY_ENTER: u32 = 28;
    const KEY_A: u32 = 30;
    const KEY_SEMICOLON: u32 = 39;
    const KEY_GRAVE: u32 = 41;
    const KEY_LEFTSHIFT: u32 = 42;
    const KEY_Z: u32 = 44;
    const KEY_SPACE: u32 = 57;
    const KEY_CAPSLOCK: u32 = 58;
    const KEY_F5: u32 = 63;
    const KEY_102ND: u32 = 86;
    const KEY_RIGHTALT: u32 = 100;
    const KEY_LEFTCTRL: u32 = 29;
    const KEY_LEFTALT: u32 = 56;
    const KEY_LEFTMETA: u32 = 125;
    const KEY_LEFT: u32 = 105;

    fn tap_key(t: &mut Translator, code: u32) -> Option<Key> {
        let key = t.key(code, true);
        assert_eq!(t.key(code, false), key, "release carries the press");
        key
    }

    fn tap(t: &mut Translator, code: u32) -> Option<String> {
        tap_key(t, code).map(|k| k.full)
    }

    fn with_key(t: &mut Translator, modifiers: &[u32], code: u32) -> Option<Key> {
        modifiers.iter().for_each(|&m| _ = t.key(m, true));
        let key = tap_key(t, code);
        modifiers.iter().for_each(|&m| _ = t.key(m, false));
        key
    }

    fn with(t: &mut Translator, modifier: u32, code: u32) -> Option<String> {
        with_key(t, &[modifier], code).map(|k| k.full)
    }

    fn full(k: Option<Key>) -> Option<String> {
        k.map(|k| k.full)
    }

    fn s(v: &str) -> Option<String> {
        Some(v.to_string())
    }

    #[test]
    fn us() {
        let mut t = Translator::new("us", "", "");
        assert_eq!(tap(&mut t, KEY_A), s("a"));
        assert_eq!(tap(&mut t, KEY_Z), s("z"));
        assert_eq!(tap(&mut t, KEY_Y), s("y"));
        assert_eq!(with(&mut t, KEY_LEFTSHIFT, KEY_A), s("A"));
        assert_eq!(with(&mut t, KEY_LEFTSHIFT, KEY_2), s("@"));
        assert_eq!(tap(&mut t, KEY_SPACE), s(" "));
        assert_eq!(tap(&mut t, KEY_ENTER), s("Return"));
        assert_eq!(tap(&mut t, KEY_BACKSPACE), s("BackSpace"));
        assert_eq!(tap(&mut t, KEY_TAB), s("Tab"));
        assert_eq!(tap(&mut t, KEY_ESC), s("Escape"));
        assert_eq!(tap(&mut t, KEY_LEFT), s("Left"));
        assert_eq!(tap(&mut t, KEY_F5), s("F5"));
        assert_eq!(full(t.key(KEY_LEFTSHIFT, true)), s("Shift_L"));
        t.key(KEY_LEFTSHIFT, false);
    }

    #[test]
    fn de() {
        let mut t = Translator::new("de", "", "");
        assert_eq!(tap(&mut t, KEY_Z), s("y"));
        assert_eq!(tap(&mut t, KEY_Y), s("z"));
        assert_eq!(tap(&mut t, KEY_SEMICOLON), s("ö"));
        assert_eq!(with(&mut t, KEY_LEFTSHIFT, KEY_SEMICOLON), s("Ö"));
        assert_eq!(with(&mut t, KEY_LEFTSHIFT, KEY_2), s("\""));
        assert_eq!(with(&mut t, KEY_RIGHTALT, KEY_Q), s("@"));
        assert_eq!(with(&mut t, KEY_RIGHTALT, KEY_E), s("€"));
        assert_eq!(tap(&mut t, KEY_102ND), s("<"));
        assert_eq!(tap(&mut t, KEY_GRAVE), s("dead_circumflex"));
        assert_eq!(tap(&mut t, KEY_EQUAL), s("dead_acute"));
    }

    #[test]
    fn release_keeps_press_label() {
        let mut t = Translator::new("us", "", "");
        t.key(KEY_LEFTSHIFT, true);
        assert_eq!(full(t.key(KEY_A, true)), s("A"));
        assert_eq!(full(t.key(KEY_LEFTSHIFT, false)), s("Shift_L"));
        // Shift is up by now; the release still names what was pressed
        assert_eq!(full(t.key(KEY_A, false)), s("A"));
        // A release without a press (held before the helper started)
        assert_eq!(t.key(KEY_Z, false), None);
    }

    #[test]
    fn shortcuts() {
        let key = |full: &str, base: &str, command| Some(Key { full: full.into(), base: base.into(), command });
        let mut t = Translator::new("de", "", "");
        assert_eq!(tap_key(&mut t, KEY_A), key("a", "a", false));
        assert_eq!(with_key(&mut t, &[KEY_LEFTSHIFT], KEY_A), key("A", "a", false));
        // Ctrl+A is a control character: the keysym name instead
        assert_eq!(with_key(&mut t, &[KEY_LEFTCTRL], KEY_A), key("a", "a", true));
        assert_eq!(with_key(&mut t, &[KEY_LEFTCTRL, KEY_LEFTSHIFT], KEY_2), key("\"", "2", true));
        assert_eq!(with_key(&mut t, &[KEY_LEFTALT], KEY_TAB), key("Tab", "Tab", true));
        assert_eq!(with_key(&mut t, &[KEY_LEFTMETA], KEY_E), key("e", "e", true));
        // AltGr types characters, it makes no shortcut
        assert_eq!(with_key(&mut t, &[KEY_RIGHTALT], KEY_Q), key("@", "q", false));
        // On us the right Alt is Alt
        let mut t = Translator::new("us", "", "");
        assert_eq!(with_key(&mut t, &[KEY_RIGHTALT], KEY_Q).map(|k| k.command), Some(true));
    }

    #[test]
    fn de_caps_lock() {
        let mut t = Translator::new("de", "", "");
        tap(&mut t, KEY_CAPSLOCK);
        assert_eq!(tap(&mut t, KEY_A), s("A"));
        assert_eq!(tap(&mut t, KEY_SEMICOLON), s("Ö"));
        // Caps Lock does not shift digits
        assert_eq!(tap(&mut t, KEY_2), s("2"));
        tap(&mut t, KEY_CAPSLOCK);
        assert_eq!(tap(&mut t, KEY_A), s("a"));
    }

    #[test]
    fn de_nodeadkeys() {
        let mut t = Translator::new("de", "nodeadkeys", "");
        assert_eq!(tap(&mut t, KEY_GRAVE), s("^"));
        assert_eq!(tap(&mut t, KEY_EQUAL), s("´"));
        assert_eq!(tap(&mut t, KEY_Z), s("y"));
    }

    #[test]
    fn option_caps_to_ctrl() {
        let mut t = Translator::new("us", "", "ctrl:nocaps");
        assert_eq!(full(t.key(KEY_CAPSLOCK, true)), s("Control_L"));
        assert_eq!(with(&mut t, KEY_LEFTSHIFT, KEY_A), s("A"));
    }
}
