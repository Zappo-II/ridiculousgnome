// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

/*
 * The triggers of both modes and their switches. Ridiculous mode: image,
 * sound, shake, stored in ridiculous-effects as trigger id -> (bbb).
 * Presentation mode: chip, mark (rings or a line at the pointer), stored in
 * presentation-effects as trigger id -> (bb). Ids missing there take the
 * built-in default. Shared by the extension and prefs, so nothing from the
 * shell here.
 */

import GLib from 'gi://GLib';

// Marks a string for translation; prefs translates it when shown
const N_ = s => s;

export const IMAGE = 0;
export const SOUND = 1;
export const SHAKE = 2;

/**
 * In the order prefs shows them. defaults: [image, sound, shake]; null
 * where the trigger has no such switch.
 */
export const TRIGGERS = [
    {id: 'typing', title: N_('Typing'), subtitle: N_('Letters, digits, Space, Tab; Ctrl + V'), defaults: [true, true, false]},
    {id: 'delete', title: N_('Deleting'), subtitle: N_('BackSpace, Delete, Escape; Ctrl + X, Ctrl + C, Ctrl + Z'), defaults: [true, true, true]},
    {id: 'return', title: N_('Return'), subtitle: null, defaults: [true, true, true]},
    {id: 'combo', title: N_('Shortcuts'), subtitle: N_('Other keys with Ctrl, Alt or Super held; F-keys'), defaults: [true, true, true]},
    {id: 'nav', title: N_('Navigation'), subtitle: N_('Arrow keys, Home, End, Page Up, Page Down'), defaults: [true, true, false]},
    {id: 'click', title: N_('Clicks'), subtitle: null, defaults: [true, true, true]},
    {id: 'drag', title: N_('Drags'), subtitle: null, defaults: [true, true, true]},
    {id: 'motion', title: N_('Mouse motion'), subtitle: null, defaults: [true, false, false]},
    {id: 'scroll', title: N_('Scrolling'), subtitle: N_('Mouse wheel and two-finger scrolling'), defaults: [true, true, false]},
    {id: 'swipe', title: N_('Swipes'), subtitle: N_('Three or four fingers on the touchpad'), defaults: [true, true, true]},
    {id: 'pinch', title: N_('Pinches'), subtitle: null, defaults: [true, true, true]},
    {id: 'touch', title: N_('Touchpad touch'), subtitle: N_('Smudges while fingers rest on the touchpad'), defaults: [true, null, null]},
    {id: 'levelup', title: N_('Level-up'), subtitle: N_('Fireworks'), defaults: [true, true, true]},
];

export const CHIP = 0;
export const MARK = 1;

/** Presentation mode, as TRIGGERS: defaults [chip, mark]. */
export const PRESENTATION_TRIGGERS = [
    {id: 'keys', title: N_('Keys'), subtitle: N_('Keys and shortcuts'), defaults: [true, null]},
    {id: 'click', title: N_('Clicks'), subtitle: N_('Rings: left button one, right two, middle three; thicker for a double click'), defaults: [true, true]},
    {id: 'drag', title: N_('Drags'), subtitle: N_('A line from the start to the pointer'), defaults: [true, true]},
    {id: 'scroll', title: N_('Scrolling'), subtitle: N_('Mouse wheel and two-finger scrolling'), defaults: [true, null]},
    {id: 'gesture', title: N_('Touchpad gestures'), subtitle: N_('Swipes with three or more fingers, pinches'), defaults: [true, null]},
];

// mode -> [settings key, triggers, variant type]
const STORES = {
    ridiculous: ['ridiculous-effects', TRIGGERS, 'a{s(bbb)}'],
    presentation: ['presentation-effects', PRESENTATION_TRIGGERS, 'a{s(bb)}'],
};

/**
 * @param {Gio.Settings} settings - extension settings
 * @param {string} [mode] - 'ridiculous' or 'presentation'
 * @returns {Object<string, boolean[]>} trigger id -> its switches
 *   ([image, sound, shake] or [chip, mark]); a switch the trigger does not
 *   have is false
 */
export function loadEffects(settings, mode = 'ridiculous') {
    const [key, triggers] = STORES[mode];
    const stored = settings.get_value(key).deep_unpack();
    const effects = {};
    for (const {id, defaults} of triggers) {
        const values = stored[id] ?? defaults;
        effects[id] = defaults.map((d, i) => d !== null && Boolean(values[i]));
    }
    return effects;
}

/** Sets one switch; only triggers the user changed are stored. */
export function setEffect(settings, id, index, value, mode = 'ridiculous') {
    const [key, , type] = STORES[mode];
    const stored = settings.get_value(key).deep_unpack();
    const values = loadEffects(settings, mode)[id];
    values[index] = value;
    settings.set_value(key, new GLib.Variant(type, {...stored, [id]: values}));
}

/** Whether a trigger shows up at all: any of its switches on. */
export function anyOn(effects, id) {
    return effects[id].some(Boolean);
}

// Keys that make nothing on their own: they are not typing
const MODIFIER_KEYS = new Set([
    'Shift_L', 'Shift_R', 'Control_L', 'Control_R', 'Alt_L', 'Alt_R', 'Meta_L', 'Meta_R',
    'Super_L', 'Super_R', 'ISO_Level3_Shift', 'ISO_Level5_Shift', 'Caps_Lock', 'Num_Lock',
]);
const DELETE_KEYS = new Set(['BackSpace', 'Delete', 'KP_Delete']);
const NEWLINE_KEYS = new Set(['Return', 'KP_Enter']);
// Navigation keys -> the direction the nav arrow flies
const NAV_DIRS = {
    'Left': 'left', 'Right': 'right', 'Up': 'up', 'Down': 'down',
    'KP_Left': 'left', 'KP_Right': 'right', 'KP_Up': 'up', 'KP_Down': 'down',
    'Home': 'left', 'End': 'right', 'KP_Home': 'left', 'KP_End': 'right',
    'Page_Up': 'up', 'Prior': 'up', 'KP_Page_Up': 'up', 'KP_Prior': 'up',
    'Page_Down': 'down', 'Next': 'down', 'KP_Page_Down': 'down', 'KP_Next': 'down',
};
const COMBO_KEYS = new Set(['Insert', 'KP_Insert', 'Menu']);
// Keys that add text besides single characters: classes the helper sends
// below `characters` (`key` only at `activity`, see keyEffect), Tab
const TYPING_KEYS = new Set(['letter', 'digit', 'symbol', 'space', 'Tab', 'ISO_Left_Tab']);
// Ctrl (no Alt, no Super) + key, by the common meaning: [effect, xp]; with
// Shift the same, except Ctrl+Shift+Z (redo)
const CTRL_SHORTCUTS = {
    'v': ['blip', 1], 'y': ['blip', 1],
    'x': ['boom', -1], 'BackSpace': ['boom', -1], 'Delete': ['boom', -1], 'KP_Delete': ['boom', -1],
    'c': ['boom', 0], 'z': ['boom', 0], 'd': ['boom', 0], 'w': ['boom', 0],
};
// Effect -> its trigger in TRIGGERS
const EFFECT_TRIGGERS = {blip: 'typing', boom: 'delete', newline: 'return', combo: 'combo', nav: 'nav'};

/**
 * What a key-down makes in ridiculous mode (content review, table 1).
 * The key is as cut down by the Filter: where the detail level hides it
 * (letters at `classes`, everything at `activity`) the meaning is guessed
 * from what is left.
 *
 * Other keys (media and volume keys, Print, the class `key` at `classes`
 * and `shortcuts`) add no text: a combo without XP. At `activity` every key
 * is `key` and counts as typing.
 *
 * @param {string} key - character, keysym name or class
 * @param {string[]} mods - modifiers held, display names (Ctrl, Shift, …)
 * @param {string} [detail] - the detail level the key was cut down to
 * @returns {{effect: string, trigger: string, xp: number, dir?: string}|null}
 *   null for a modifier alone
 */
export function keyEffect(key, mods, detail) {
    if (MODIFIER_KEYS.has(key))
        return null;
    const result = (effect, xp, dir) => ({effect, trigger: EFFECT_TRIGGERS[effect], xp, dir});
    const command = mods.filter(m => m === 'Ctrl' || m === 'Alt' || m === 'Super');
    if (NEWLINE_KEYS.has(key))
        return result('newline', 1);
    if (command.length > 0) {
        if (command.length === 1 && command[0] === 'Ctrl') {
            const lower = [...key].length === 1 ? key.toLowerCase() : key;
            if (lower === 'z' && mods.includes('Shift'))
                return result('blip', 1);
            if (lower in CTRL_SHORTCUTS)
                return result(...CTRL_SHORTCUTS[lower]);
            // Word and line jumps
            if (key in NAV_DIRS)
                return result('nav', 0, NAV_DIRS[key]);
        }
        return result('combo', 0);
    }
    if (DELETE_KEYS.has(key))
        return result('boom', -1);
    if (key === 'Escape')
        return result('boom', 0);
    if (key in NAV_DIRS)
        return result('nav', 0, NAV_DIRS[key]);
    if (COMBO_KEYS.has(key) || /^F\d+$/.test(key))
        return result('combo', 0);
    const typing = [...key].length === 1 || TYPING_KEYS.has(key) || key.startsWith('dead_') ||
        (key === 'key' && detail === 'activity');
    return typing ? result('blip', 1) : result('combo', 0);
}
