// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

/*
 * Tracks the focused window and its WM class.
 */

export class FocusTracker {
    constructor() {
        this._focusChangedId = 0;
        this._current = {wmClass: null, frameRect: null};
    }

    /** @param {Function} [onChange] - called after the focused window changed */
    start(onChange) {
        this._focusChangedId = global.display.connect('notify::focus-window', () => {
            this._update();
            onChange?.();
        });
        this._update();
    }

    stop() {
        if (this._focusChangedId) {
            global.display.disconnect(this._focusChangedId);
            this._focusChangedId = 0;
        }
        this._current = {wmClass: null, frameRect: null};
    }

    /**
     * frameRect is captured at focus time and goes stale if the window moves;
     * the renderer reads the live rect when positioning.
     *
     * @returns {{wmClass: string|null, frameRect: Mtk.Rectangle|null}}
     */
    getCurrent() {
        return this._current;
    }

    _update() {
        const window = global.display.focus_window;
        this._current = {
            wmClass: window?.get_wm_class() ?? null,
            frameRect: window?.get_frame_rect() ?? null,
        };
    }
}
