// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

//! How much a subscriber learns about keys (CONTRIBUTING.md, "The helper").
//! Any process of the active session's user can subscribe, so
//! the default ceiling hides the typed characters; only root can raise it
//! in /etc/rg-helper.conf.

use std::fmt;
use std::str::FromStr;

use crate::xkb::Key;

/// Ordered from least to most revealing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Detail {
    /// No `Key` signals.
    Off,
    /// `key` for every key.
    Activity,
    /// `letter`, `digit`, `symbol`, `space`, names of non-printing keys.
    Classes,
    /// As `Classes`, but with Ctrl, Alt or Super held the key without
    /// modifiers (`t` for Ctrl+Shift+T): shortcuts, not typed text.
    Shortcuts,
    /// The typed character or keysym name.
    Characters,
}

/// Ceiling when nothing is configured.
pub const DEFAULT_MAX: Detail = Detail::Shortcuts;

pub const CONFIG_PATH: &str = "/etc/rg-helper.conf";

impl FromStr for Detail {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, ()> {
        match s {
            "off" => Ok(Self::Off),
            "activity" => Ok(Self::Activity),
            "classes" => Ok(Self::Classes),
            "shortcuts" => Ok(Self::Shortcuts),
            "characters" => Ok(Self::Characters),
            _ => Err(()),
        }
    }
}

impl fmt::Display for Detail {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Off => "off",
            Self::Activity => "activity",
            Self::Classes => "classes",
            Self::Shortcuts => "shortcuts",
            Self::Characters => "characters",
        })
    }
}

/// Non-printing keys whose name is shown at `classes`: editing, navigation,
/// modifiers, function keys. They tell what the user does, not what they type.
const NAMED_KEYS: &[&str] = &[
    "Return", "KP_Enter", "BackSpace", "Tab", "ISO_Left_Tab", "Escape", "Delete", "Insert",
    "Home", "End", "Prior", "Next", "Page_Up", "Page_Down", "Left", "Right", "Up", "Down", "Menu",
    "KP_Delete", "KP_Insert", "KP_Home", "KP_End", "KP_Prior", "KP_Next", "KP_Page_Up", "KP_Page_Down",
    "KP_Left", "KP_Right", "KP_Up", "KP_Down",
    "Shift_L", "Shift_R", "Control_L", "Control_R", "Alt_L", "Alt_R", "Meta_L", "Meta_R",
    "Super_L", "Super_R", "ISO_Level3_Shift", "ISO_Level5_Shift", "Caps_Lock", "Num_Lock",
];

/// The `Key` label for a subscriber at `detail`, from the translator's
/// key; None means send nothing.
pub fn label(detail: Detail, key: &Key) -> Option<String> {
    match detail {
        Detail::Off => None,
        Detail::Activity => Some("key".into()),
        Detail::Characters => Some(key.full.clone()),
        Detail::Shortcuts if key.command => Some(key.base.clone()),
        Detail::Classes | Detail::Shortcuts => Some(class(&key.full).into()),
    }
}

fn class(full: &str) -> &str {
    let mut chars = full.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        return if c == ' ' {
            "space"
        } else if c.is_alphabetic() {
            "letter"
        } else if c.is_numeric() {
            "digit"
        } else {
            "symbol"
        };
    }
    let function_key = full
        .strip_prefix('F')
        .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()));
    if NAMED_KEYS.contains(&full) || function_key {
        full
    } else if full.starts_with("dead_") {
        // An accent being typed
        "symbol"
    } else {
        "key"
    }
}

/// Reads `max-detail` from the config text; anything unreadable leaves the
/// default. Problems are returned as messages for the log.
pub fn parse_config(text: &str) -> (Detail, Vec<String>) {
    let mut max = DEFAULT_MAX;
    let mut problems = Vec::new();
    for (number, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        match line.split_once('=').map(|(k, v)| (k.trim(), v.trim())) {
            Some(("max-detail", value)) => match value.parse() {
                Ok(detail) => max = detail,
                Err(()) => problems.push(format!("line {}: unknown max-detail {value:?}", number + 1)),
            },
            _ => problems.push(format!("line {}: ignored", number + 1)),
        }
    }
    (max, problems)
}

#[cfg(test)]
mod tests {
    use super::{DEFAULT_MAX, Detail, label, parse_config};
    use crate::xkb::Key;

    fn typed(full: &str) -> Key {
        Key { full: full.into(), base: full.to_lowercase(), command: false }
    }

    fn shortcut(full: &str, base: &str) -> Key {
        Key { full: full.into(), base: base.into(), command: true }
    }

    #[test]
    fn levels() {
        assert_eq!(label(Detail::Off, &typed("a")), None);
        assert_eq!(label(Detail::Activity, &typed("a")).as_deref(), Some("key"));
        assert_eq!(label(Detail::Activity, &typed("Return")).as_deref(), Some("key"));
        assert_eq!(label(Detail::Characters, &typed("ä")).as_deref(), Some("ä"));
        assert!(Detail::Off < Detail::Activity && Detail::Classes < Detail::Shortcuts);
        assert!(Detail::Shortcuts < Detail::Characters);
    }

    #[test]
    fn shortcuts() {
        let at = |key| label(Detail::Shortcuts, &key).unwrap();
        assert_eq!(at(typed("a")), "letter");
        assert_eq!(at(typed("@")), "symbol");
        assert_eq!(at(typed("Return")), "Return");
        assert_eq!(at(shortcut("a", "a")), "a");
        assert_eq!(at(shortcut("\"", "2")), "2");
        assert_eq!(at(shortcut("Tab", "Tab")), "Tab");
        // Classes never shows a shortcut's key
        assert_eq!(label(Detail::Classes, &shortcut("a", "a")).as_deref(), Some("letter"));
    }

    #[test]
    fn classes() {
        let class = |s| label(Detail::Classes, &typed(s)).unwrap();
        assert_eq!(class("a"), "letter");
        assert_eq!(class("Ä"), "letter");
        assert_eq!(class("7"), "digit");
        assert_eq!(class("#"), "symbol");
        assert_eq!(class("€"), "symbol");
        assert_eq!(class(" "), "space");
        assert_eq!(class("Return"), "Return");
        assert_eq!(class("Shift_L"), "Shift_L");
        assert_eq!(class("F12"), "F12");
        assert_eq!(class("KP_Delete"), "KP_Delete");
        assert_eq!(class("KP_Left"), "KP_Left");
        assert_eq!(class("dead_acute"), "symbol");
        assert_eq!(class("XF86AudioPlay"), "key");
        assert_eq!(class("Fabc"), "key");
    }

    #[test]
    fn config() {
        assert_eq!(parse_config("").0, DEFAULT_MAX);
        assert_eq!(parse_config("# c\nmax-detail = characters\n").0, Detail::Characters);
        assert_eq!(parse_config("max-detail=activity").0, Detail::Activity);
        assert_eq!(parse_config("max-detail = shortcuts").0, Detail::Shortcuts);
        let (max, problems) = parse_config("max-detail=everything\nfoo=bar");
        assert_eq!(max, DEFAULT_MAX);
        assert_eq!(problems.len(), 2);
    }
}
