// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

/*
 * InputSource for the limited mode: what the shell itself sees, through a
 * Clutter event filter on the stage. Runs while rg-helper is missing or not
 * working, so a fresh install shows at least something.
 *
 * Mutter hands key and button events for app windows to the apps before
 * the stage filter sees them, so this only gets keys, clicks and wheel on
 * the shell's own UI (Activities overview and its search, dash, panel,
 * menus, shell dialogs), plus pointer motion everywhere and touchpad hold
 * gestures.
 *
 * Keys typed into a shell password entry (e.g. the polkit dialog) are
 * dropped, so a password never shows up as labels.
 */

import Clutter from 'gi://Clutter';
import St from 'gi://St';

// Same rate as the helper's Motion signal
const MOTION_INTERVAL_MS = 50;

// Non-printing keys shown by keysym name, as the helper does
const NAMED_KEYS = [
    'Return', 'KP_Enter', 'BackSpace', 'Tab', 'ISO_Left_Tab', 'Escape', 'Delete', 'Insert',
    'Home', 'End', 'Page_Up', 'Page_Down', 'Left', 'Right', 'Up', 'Down', 'Menu',
    'KP_Delete', 'KP_Insert', 'KP_Home', 'KP_End', 'KP_Page_Up', 'KP_Page_Down',
    'KP_Left', 'KP_Right', 'KP_Up', 'KP_Down',
    'Shift_L', 'Shift_R', 'Control_L', 'Control_R', 'Alt_L', 'Alt_R', 'Super_L', 'Super_R',
    'ISO_Level3_Shift', 'Caps_Lock',
    'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
];

const WHEEL_DIRECTIONS = {
    [Clutter.ScrollDirection.UP]: 'up',
    [Clutter.ScrollDirection.DOWN]: 'down',
    [Clutter.ScrollDirection.LEFT]: 'left',
    [Clutter.ScrollDirection.RIGHT]: 'right',
};

const KEYSYM_NAMES = new Map(NAMED_KEYS.map(name => [Clutter[`KEY_${name}`], name]));

/**
 * @param {Clutter.Event} event - key event
 * @returns {string|null} character or keysym name; null for keys not shown
 */
function keyLabel(event) {
    const name = KEYSYM_NAMES.get(event.get_key_symbol());
    if (name)
        return name;
    let char = event.get_key_unicode();
    // Ctrl+T gives a control character; the key's own character instead
    if ((char?.codePointAt(0) ?? 0) < 0x20)
        char = String.fromCodePoint(Clutter.keysym_to_unicode(event.get_key_symbol()));
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f ? char : null;
}

/** @returns {boolean} whether the shell's key focus is a password entry */
function typingPassword() {
    const focus = global.stage.get_key_focus();
    // get_password_char() returns a string in GJS, empty when unset; the
    // password_char property is a number but logs a "slow path" warning
    return focus instanceof Clutter.Text &&
        (focus.get_password_char() !== '' || focus.get_parent() instanceof St.PasswordEntry);
}

export class ShellInputSource {
    constructor() {
        this._filterId = 0;
    }

    start(onEvent) {
        this.stop();
        this._onEvent = onEvent;
        this._lastMotion = 0;
        this._filterId = Clutter.Event.add_filter(global.stage, event => {
            const result = this._eventFor(event);
            if (result)
                this._onEvent({...result, ts: Date.now()});
            return Clutter.EVENT_PROPAGATE;
        });
    }

    stop() {
        if (this._filterId) {
            Clutter.Event.remove_filter(this._filterId);
            this._filterId = 0;
        }
        this._onEvent = null;
    }

    /**
     * @param {Clutter.Event} event - any stage event
     * @returns {object|null} InputSource event without ts
     */
    _eventFor(event) {
        switch (event.type()) {
        case Clutter.EventType.KEY_PRESS:
        case Clutter.EventType.KEY_RELEASE: {
            // The Filter cuts it down to the window's detail level
            const label = typingPassword() ? null : keyLabel(event);
            if (!label)
                return null;
            const pressed = event.type() === Clutter.EventType.KEY_PRESS;
            return {kind: pressed ? 'key-down' : 'key-up', key: label};
        }
        case Clutter.EventType.BUTTON_PRESS:
            return {kind: 'mouse-button-down', button: event.get_button()};
        case Clutter.EventType.BUTTON_RELEASE:
            return {kind: 'mouse-button-up', button: event.get_button()};
        case Clutter.EventType.SCROLL: {
            // Touchpad scrolling is a gesture, not the wheel (as with the helper)
            if (event.get_scroll_source() !== Clutter.ScrollSource.WHEEL)
                return null;
            const wheelDir = WHEEL_DIRECTIONS[event.get_scroll_direction()];
            return wheelDir ? {kind: 'mouse-wheel', wheelDir} : null;
        }
        case Clutter.EventType.MOTION: {
            const now = Date.now();
            if (now - this._lastMotion < MOTION_INTERVAL_MS)
                return null;
            this._lastMotion = now;
            const [x, y] = event.get_coords();
            return {kind: 'mouse-motion', pos: {x: Math.round(x), y: Math.round(y)}};
        }
        case Clutter.EventType.TOUCHPAD_HOLD: {
            // Fingers resting on the touchpad; closest to the helper's raw touches
            const fingers = event.get_touchpad_gesture_finger_count();
            const phase = event.get_gesture_phase();
            if (phase === Clutter.TouchpadGesturePhase.BEGIN)
                return {kind: 'touch-down', fingers};
            if (phase === Clutter.TouchpadGesturePhase.END || phase === Clutter.TouchpadGesturePhase.CANCEL)
                return {kind: 'touch-up', fingers};
            return null;
        }
        default:
            return null;
        }
    }
}
