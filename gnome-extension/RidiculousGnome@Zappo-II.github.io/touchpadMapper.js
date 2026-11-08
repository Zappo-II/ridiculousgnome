// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

/*
 * rg-helper's touchpad facts (contract 4: Tap, PadButton, Scroll, Swipe,
 * Pinch) -> InputSource events, the way libinput would turn them into
 * input with the user's GNOME touchpad settings:
 *
 * - Tap: a click if tap-to-click is on; 1/2/3 fingers -> left/right/middle
 *   (tap-button-map lrm, the default) or left/middle/right (lmr).
 * - PadButton: a clickpad press. click-method fingers: 1/2/3 fingers ->
 *   left/right/middle; areas (and default, libinput's choice for most
 *   pads): right in the bottom-right area, else left; none: left.
 *   left-handed swaps left and right. The release goes to the button
 *   the press went to.
 * - Scroll: the helper reports the fingers' direction; with natural
 *   scrolling the content follows the fingers, so fingers up scroll down.
 *   Dropped when two-finger scrolling is off.
 * - Swipe / Pinch: touch-swipe / touch-pinch with fingers and direction.
 *
 * Settings come through a getter so this runs without GNOME in tests.
 */

const TAP_BUTTONS = {
    lrm: {1: 1, 2: 3, 3: 2},
    lmr: {1: 1, 2: 2, 3: 3},
};
const FINGER_BUTTONS = {1: 1, 2: 3, 3: 2};
const OPPOSITE = {up: 'down', down: 'up', left: 'right', right: 'left'};

export class TouchpadMapper {
    /**
     * @param {object} settings - {touchpad: Gio.Settings-like or null,
     *   mouse: Gio.Settings-like or null} for
     *   org.gnome.desktop.peripherals.touchpad / .mouse
     */
    constructor(settings) {
        this._touchpad = settings.touchpad;
        this._mouse = settings.mouse;
        this._padButton = null; // button the current pad press went to
    }

    _bool(key, fallback) {
        try {
            return this._touchpad?.get_boolean(key) ?? fallback;
        } catch {
            return fallback;
        }
    }

    _string(key, fallback) {
        try {
            return this._touchpad?.get_string(key) ?? fallback;
        } catch {
            return fallback;
        }
    }

    _leftHanded() {
        const value = this._string('left-handed', 'mouse');
        if (value === 'left')
            return true;
        if (value === 'right')
            return false;
        try {
            return this._mouse?.get_boolean('left-handed') ?? false;
        } catch {
            return false;
        }
    }

    /**
     * @param {string} signal - helper signal name
     * @param {Array} args - unpacked signal arguments
     * @returns {object[]|null} events, or null for a signal not handled here
     */
    map(signal, args) {
        switch (signal) {
        case 'Tap': {
            const [fingers] = args;
            if (!this._bool('tap-to-click', true))
                return [];
            const map = TAP_BUTTONS[this._string('tap-button-map', 'default')] ?? TAP_BUTTONS.lrm;
            const button = map[fingers];
            if (!button)
                return [];
            return [
                {kind: 'mouse-button-down', button, tap: true},
                {kind: 'mouse-button-up', button, tap: true},
            ];
        }
        case 'PadButton': {
            const [pressed, fingers, area] = args;
            if (!pressed) {
                const button = this._padButton;
                this._padButton = null;
                return button ? [{kind: 'mouse-button-up', button}] : [];
            }
            let button;
            switch (this._string('click-method', 'default')) {
            case 'fingers':
                button = FINGER_BUTTONS[fingers] ?? 1;
                break;
            case 'none':
                button = 1;
                break;
            default: // areas, default
                button = area === 'right' ? 3 : 1;
            }
            if (this._leftHanded() && (button === 1 || button === 3))
                button = 4 - button;
            this._padButton = button;
            return [{kind: 'mouse-button-down', button}];
        }
        case 'Scroll': {
            const [dir] = args;
            if (!this._bool('two-finger-scrolling-enabled', true) || !OPPOSITE[dir])
                return [];
            const wheelDir = this._bool('natural-scroll', true) ? OPPOSITE[dir] : dir;
            return [{kind: 'mouse-wheel', wheelDir, touchpad: true}];
        }
        case 'Swipe': {
            const [fingers, dir] = args;
            return [{kind: 'touch-swipe', fingers, dir}];
        }
        case 'Pinch': {
            const [fingers, dir] = args;
            return [{kind: 'touch-pinch', fingers, dir}];
        }
        default:
            return null;
        }
    }

    /** Forgets a pad press, e.g. when the helper went away. */
    reset() {
        this._padButton = null;
    }
}
