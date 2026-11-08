// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

/*
 * Key labels: cut down to a detail level, then made display-ready.
 *
 * InputSources emit what they get — a character, a keysym name, or a
 * class when rg-helper already cut it down. The Filter applies the
 * focused window's detail level with labelForDetail(), the renderer shows
 * the result through formatKey().
 */

// Keysym names that get a display label instead of the name itself.
const KEY_LABELS = {
    'space': 'SPACE',
    'Tab': '↹',
    'ISO_Left_Tab': '↹',
    'Return': '⏎',
    'KP_Enter': '⏎',
    'BackSpace': 'BACKSPACE',
    'Escape': 'ESC',
};

// What the helper sends below `characters`; never a real character or
// keysym name
const CLASS_LABELS = {
    'key': '⌨',
    'letter': 'abc',
    'digit': '123',
    'symbol': '#!?',
};

// Key detail levels, least revealing first
export const DETAILS = ['off', 'activity', 'classes', 'shortcuts', 'characters'];

// Modifiers that make a shortcut (as COMMAND_MODS in the helper's xkb.rs);
// AltGr (ISO_Level3_Shift) types characters
export const COMMAND_KEYS = new Set([
    'Control_L', 'Control_R', 'Alt_L', 'Alt_R', 'Meta_L', 'Meta_R', 'Super_L', 'Super_R',
]);

// Non-printing keys named at `classes`, as in the helper's detail.rs
const NAMED_KEYS = new Set([
    'Return', 'KP_Enter', 'BackSpace', 'Tab', 'ISO_Left_Tab', 'Escape', 'Delete', 'Insert',
    'Home', 'End', 'Prior', 'Next', 'Page_Up', 'Page_Down', 'Left', 'Right', 'Up', 'Down', 'Menu',
    'KP_Delete', 'KP_Insert', 'KP_Home', 'KP_End', 'KP_Prior', 'KP_Next', 'KP_Page_Up', 'KP_Page_Down',
    'KP_Left', 'KP_Right', 'KP_Up', 'KP_Down',
    'Shift_L', 'Shift_R', 'Control_L', 'Control_R', 'Alt_L', 'Alt_R', 'Meta_L', 'Meta_R',
    'Super_L', 'Super_R', 'ISO_Level3_Shift', 'ISO_Level5_Shift', 'Caps_Lock', 'Num_Lock',
]);

/**
 * Cuts a label down to a detail level, like the helper does for its
 * subscribers. Also for labels the helper already cut down (classes), and
 * for sources that see full labels themselves (the shell's limited mode).
 *
 * @param {string} detail - one of DETAILS
 * @param {string} label - printable character, keysym name or class
 * @param {boolean} command - Ctrl, Alt or Super held (shortcuts level)
 * @returns {string|null} null: show nothing
 */
export function labelForDetail(detail, label, command = false) {
    switch (detail) {
    case 'characters':
        return label;
    case 'shortcuts':
        // The helper sends a shortcut's key without Shift (t for
        // Ctrl+Shift+T); a source with full labels gets lower case here
        if (command)
            return [...label].length === 1 ? label.toLowerCase() : label;
        return labelForDetail('classes', label);
    case 'classes': {
        if (label in CLASS_LABELS || label === 'space')
            return label;
        const chars = [...label];
        if (chars.length === 1) {
            if (label === ' ')
                return 'space';
            if (/\p{L}/u.test(label))
                return 'letter';
            if (/\p{N}/u.test(label))
                return 'digit';
            return 'symbol';
        }
        if (NAMED_KEYS.has(label) || /^F\d+$/.test(label))
            return label;
        return label.startsWith('dead_') ? 'symbol' : 'key';
    }
    case 'activity':
        return 'key';
    default:
        return null;
    }
}

/**
 * Turn a key event string into the display-ready `key` value.
 *
 * @param {string} eventString - printable character, keysym name, or a
 *   class from a reduced detail level
 * @returns {string}
 */
export function formatKey(eventString) {
    if (eventString in KEY_LABELS)
        return KEY_LABELS[eventString];
    if (eventString in CLASS_LABELS)
        return CLASS_LABELS[eventString];
    if (eventString === ' ')
        return 'SPACE';
    // Printable single characters and all other keysym names pass through
    return eventString;
}

// Display names, shared by presentation mode and ridiculous mode's
// shortcut labels

// Modifier keysyms -> display name; the order of MOD_ORDER is the order shown
export const MODIFIERS = {
    'Control_L': 'Ctrl', 'Control_R': 'Ctrl',
    'Shift_L': 'Shift', 'Shift_R': 'Shift',
    'Alt_L': 'Alt', 'Alt_R': 'Alt', 'Meta_L': 'Alt', 'Meta_R': 'Alt',
    'Super_L': 'Super', 'Super_R': 'Super',
    'ISO_Level3_Shift': 'AltGr',
};
const MOD_ORDER = ['Super', 'Ctrl', 'Alt', 'AltGr', 'Shift'];
// Modifiers that make a shortcut; Shift and AltGr select characters
// (capitals, @ € { on many layouts), so typing with them stays typing
export const COMMAND_MODS = new Set(['Super', 'Ctrl', 'Alt']);
// What the helper sends below `characters` for typing keys
export const TYPING_CLASSES = {
    'letter': 'abc',
    'digit': '123',
    'symbol': '#!?',
    'space': '␣',
    'key': '⌨',
};

const KEY_NAMES = {
    'Return': 'Enter', 'KP_Enter': 'Enter',
    'BackSpace': 'Backspace', 'Escape': 'Esc',
    'Tab': 'Tab', 'ISO_Left_Tab': 'Tab',
    'Delete': 'Del', 'Insert': 'Ins',
    'Prior': 'PgUp', 'Page_Up': 'PgUp', 'Next': 'PgDn', 'Page_Down': 'PgDn',
    'Left': '←', 'Right': '→', 'Up': '↑', 'Down': '↓',
    'Caps_Lock': 'Caps Lock', 'Num_Lock': 'Num Lock',
    'space': 'Space', ' ': 'Space',
};

/** @returns {string} display name of a non-modifier key */
export function keyName(label) {
    if (label in KEY_NAMES)
        return KEY_NAMES[label];
    if (label in TYPING_CLASSES)
        return TYPING_CLASSES[label];
    // Shortcuts read like menus: Ctrl + T, not Ctrl + t
    return [...label].length === 1 ? label.toUpperCase() : label;
}

/** @returns {string[]} modifier names in display order */
export function sortedMods(mods) {
    return MOD_ORDER.filter(m => mods.has(m));
}

/**
 * A shortcut as presentation mode shows it: Ctrl + Shift + Z.
 *
 * @param {string[]} mods - display names in MOD_ORDER (sortedMods)
 * @param {string} label - the key, cut down by the Filter
 * @returns {string}
 */
export function shortcutLabel(mods, label) {
    return [...mods, keyName(label)].join(' + ');
}
