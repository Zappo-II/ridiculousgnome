// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

/*
 * Ridiculous mode: screen shake, in the spirit of Ridiculous Coding.
 *
 * Keys shake the focused window, the pointer the window under it
 * (trigger() / window()): its Meta.WindowActor is moved by a few px in a
 * random direction, a new one every frame. Each trigger keeps the shake
 * going for a while after it (DECAY_MS); a shake sequence never runs
 * longer than MAX_TOTAL_MS from its start, as in the VS Code original.
 * A level-up shakes the focused window harder and longer, dying away
 * (levelUp()). Afterwards the window is put back where it was. One window
 * shakes at a time.
 *
 * Nothing shakes while the shell has the input (overview, menus), with
 * "Animate effects" off, reduced motion or the user's shell animations off.
 * The translation only moves the picture; input still goes to the window's
 * real place, which is at most LEVEL_UP_AMPLITUDE_PX away.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {shellHasInput} from './placement.js';

const KEY_AMPLITUDE_PX = 6;
const POINTER_AMPLITUDE_PX = 4;
// How long each effect keeps the shake going after it
const DECAY_MS = {blip: 120, boom: 180, newline: 140, combo: 150, nav: 120};
// Pointer triggers: a click, or the pointer entering a window
export const CLICK_DECAY_MS = 120;
export const ENTER_DECAY_MS = 150;
const MAX_TOTAL_MS = 400;
// Level-up: strong, the amplitude falling to nothing over the time
const LEVEL_UP_AMPLITUDE_PX = 12;
const LEVEL_UP_MS = 600;
// 20 fps as in the original: a new offset every frame at 60 fps blurs
const FRAME_MS = 50;

function now() {
    return GLib.get_monotonic_time() / 1000;
}

export class Shake {
    constructor() {
        // Set by the renderer
        this.animate = true;

        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        // {actor, destroyId, x, y, startAt, endAt, maxEndAt, amplitude,
        // focused, fading}
        this._run = null;
        this._frameId = 0;
        // A key shake belongs to the focused window; a click may move the
        // focus to the window it shakes
        this._focusChangedId = global.display.connect('notify::focus-window', () => {
            if (this._run?.focused)
                this.stop();
        });
    }

    /**
     * An effect was shown for a typed key.
     *
     * @param {string} effect - 'blip', 'boom', 'newline', 'combo' or 'nav'
     */
    trigger(effect) {
        const decay = DECAY_MS[effect];
        const actor = global.display.focus_window?.get_compositor_private();
        if (decay && actor)
            this._shake(actor, KEY_AMPLITUDE_PX, decay, true);
    }

    /**
     * A pointer trigger: shakes the given window a little.
     *
     * @param {Meta.WindowActor} actor - the window under the pointer
     * @param {number} decay - CLICK_DECAY_MS or ENTER_DECAY_MS
     */
    window(actor, decay) {
        this._shake(actor, POINTER_AMPLITUDE_PX, decay, false);
    }

    /** A level-up: shakes the focused window hard, dying away. */
    levelUp() {
        const actor = global.display.focus_window?.get_compositor_private();
        if (!actor || !this._allowed())
            return;
        // A new run, so the time starts now and the cap is the level-up's
        this.stop();
        this._shake(actor, LEVEL_UP_AMPLITUDE_PX, LEVEL_UP_MS, true, LEVEL_UP_MS);
        this._run.fading = true;
    }

    _shake(actor, amplitude, decay, focused, maxTotal = MAX_TOTAL_MS) {
        if (!this._allowed())
            return;
        if (this._run && this._run.actor !== actor)
            this.stop();

        const at = now();
        if (!this._run) {
            this._run = {
                actor,
                destroyId: actor.connect('destroy', () => this._forget()),
                x: actor.translation_x,
                y: actor.translation_y,
                startAt: at,
                endAt: at,
                maxEndAt: at + maxTotal,
                amplitude,
                focused,
                fading: false,
            };
            this._frameId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, () => this._frame());
            this._offset();
        }
        const run = this._run;
        run.amplitude = Math.max(run.amplitude, amplitude);
        run.focused &&= focused;
        run.endAt = Math.min(Math.max(run.endAt, at + decay), run.maxEndAt);
    }

    /** Ends a running shake and puts the window back. */
    stop() {
        if (!this._run)
            return;
        const {actor, x, y} = this._run;
        this._forget();
        actor.set_translation(x, y, 0);
    }

    destroy() {
        this.stop();
        global.display.disconnect(this._focusChangedId);
        this._focusChangedId = 0;
        this._interfaceSettings = null;
    }

    _allowed() {
        return this.animate &&
            this._interfaceSettings.get_boolean('enable-animations') && !shellHasInput();
    }

    _frame() {
        if (!this._run)
            return GLib.SOURCE_REMOVE;
        if (now() >= this._run.endAt || !this._allowed()) {
            this._frameId = 0;
            this.stop();
            return GLib.SOURCE_REMOVE;
        }
        this._offset();
        return GLib.SOURCE_CONTINUE;
    }

    /** A new random offset of the run's amplitude from the window's place. */
    _offset() {
        const {actor, x, y, amplitude, fading, startAt, maxEndAt} = this._run;
        // A level-up dies away; keys pressed meanwhile do not renew it
        const left = fading ? Math.max(0, (maxEndAt - now()) / (maxEndAt - startAt)) : 1;
        const radius = amplitude * left * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const angle = Math.random() * 2 * Math.PI;
        actor.set_translation(
            x + Math.round(radius * Math.cos(angle)),
            y + Math.round(radius * Math.sin(angle)), 0);
    }

    /** Drops the run without touching the actor (also when it is gone). */
    _forget() {
        if (this._frameId) {
            GLib.source_remove(this._frameId);
            this._frameId = 0;
        }
        if (this._run) {
            this._run.actor.disconnect(this._run.destroyId);
            this._run = null;
        }
    }
}
