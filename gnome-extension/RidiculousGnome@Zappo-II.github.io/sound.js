// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

/*
 * Ridiculous mode: sounds, in the spirit of Ridiculous Coding.
 *
 * One per effect (sprites.js), from sounds/ (made by
 * gnome-extension/make-sounds.sh): blip, boom, newline, combo, nav for
 * keys, pop, sparkle (drag), motion, scroll, swipe, pinch-in / pinch-out
 * for the pointer and the touchpad, fireworks for an XP level-up. Blips
 * rise in pitch while typing fast, as in the VS Code original: every blip
 * one step of 0.05 up, to at most 2.0, back to the start after
 * RAMP_RESET_MS without one. The shell cannot change pitch, so each step
 * is its own file.
 *
 * Drag and motion sound now and then, only while the pointer moves
 * briskly (moving(), MOVING); both as wind chimes from several variants,
 * picked at random. Scrolling at most every SCROLL_GAP_MS.
 *
 * Played with the shell's sound player (Meta.SoundPlayer, libcanberra in a
 * worker thread): nothing to install, the call does not block the
 * compositor, and it follows the system's event-sound setting.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {pointer, scale} from './placement.js';

const RAMP_STEPS = 20;
const RAMP_RESET_MS = 180;
// Per effect: at most every gapMs, from briskPxPerS (logical px per
// second, measured over at least gapMs)
const MOVING = {
    sparkle: {gapMs: 150, briskPxPerS: 250},
    motion: {gapMs: 220, briskPxPerS: 700},
};
// Wind chimes: files <effect>-1.wav … played at random
const VARIANTS = {motion: 5, sparkle: 4};
const SCROLL_GAP_MS = 100;
const EFFECTS = ['boom', 'newline', 'combo', 'nav', 'pop', 'scroll', 'swipe',
    'pinch-in', 'pinch-out', 'fireworks'];

function now() {
    return GLib.get_monotonic_time() / 1000;
}

export class Sound {
    /**
     * @param {string} extensionPath - for the WAVs in sounds/
     */
    constructor(extensionPath) {
        const file = name => Gio.File.new_for_path(`${extensionPath}/sounds/${name}.wav`);
        this._blips = [];
        for (let i = 0; i <= RAMP_STEPS; i++)
            this._blips.push(file(`blip-${String(i).padStart(2, '0')}`));
        this._files = Object.fromEntries(EFFECTS.map(name => [name, file(name)]));
        this._variants = {};
        for (const [name, n] of Object.entries(VARIANTS))
            this._variants[name] = Array.from({length: n}, (_, i) => file(`${name}-${i + 1}`));
        this._player = global.display.get_sound_player();
        this._ramp = 0;
        this._rampResetId = 0;
        this._scrollAt = -Infinity;
        // Effect -> {x, y, at}: where the pointer was when the speed was
        // last taken
        this._movedFrom = new Map();
    }

    /**
     * The pointer moved during a drag or on its own: a sound now and then
     * while it moves briskly.
     *
     * @param {string} effect - 'sparkle' or 'motion'
     */
    moving(effect) {
        const {gapMs, briskPxPerS} = MOVING[effect];
        const [x, y] = pointer();
        const at = now();
        const from = this._movedFrom.get(effect);
        if (from && at - from.at < gapMs)
            return;
        this._movedFrom.set(effect, {x, y, at});
        if (from && Math.hypot(x - from.x, y - from.y) / scale() / (at - from.at) * 1000 >= briskPxPerS)
            this.play(effect);
    }

    /** A scroll step; quiet ticks, not more often than SCROLL_GAP_MS. */
    scroll() {
        const at = now();
        if (at - this._scrollAt < SCROLL_GAP_MS)
            return;
        this._scrollAt = at;
        this.play('scroll');
    }

    /**
     * An effect's sound.
     *
     * @param {string} effect - an effect name, 'pinch-in', 'pinch-out' or
     *   'fireworks'
     */
    play(effect) {
        let file = this._files[effect];
        const variants = this._variants[effect];
        if (variants) {
            file = variants[Math.floor(Math.random() * variants.length)];
        } else if (effect === 'blip') {
            this._ramp = Math.min(RAMP_STEPS, this._ramp + 1);
            file = this._blips[this._ramp];
            this._restartRampReset();
        }
        if (file)
            this._player.play_from_file(file, 'Ridiculous Gnome', null);
    }

    destroy() {
        if (this._rampResetId) {
            GLib.source_remove(this._rampResetId);
            this._rampResetId = 0;
        }
        this._player = null;
    }

    _restartRampReset() {
        if (this._rampResetId)
            GLib.source_remove(this._rampResetId);
        this._rampResetId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RAMP_RESET_MS, () => {
            this._rampResetId = 0;
            this._ramp = 0;
            return GLib.SOURCE_REMOVE;
        });
    }
}
