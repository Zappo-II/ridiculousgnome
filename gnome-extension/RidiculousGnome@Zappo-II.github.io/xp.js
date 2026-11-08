// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

/*
 * Ridiculous mode: experience points, as in Ridiculous Coding.
 *
 * +1 XP per key that adds text, −1 per key that deletes it (effects.js
 * keyEffect); never below the start of the current level, so deleting
 * does not take a level away. The curve is the VS Code original's: level 1 needs
 * 2 * BASE_XP, then each level BASE_XP * level more (rounded to tens):
 * level 2 +100, level 3 +150, …
 *
 * The state (xp, level, levelStart, next) is kept in GSettings
 * (ridiculous-xp-state), but not written on every key: a change is saved
 * at the latest SAVE_DELAY_MS later, on level-up and on destroy. Prefs
 * resets it by resetting the key; a value the extension did not write
 * itself is taken over.
 */

import GLib from 'gi://GLib';

const BASE_XP = 50;
const SAVE_DELAY_MS = 5000;
const KEY = 'ridiculous-xp-state';

/**
 * The XP target after a level-up, as in the original.
 *
 * @param {number} xp - total XP at the level-up
 * @param {number} level - the new level
 * @returns {number}
 */
function nextTarget(xp, level) {
    return xp + Math.round(BASE_XP * level / 10) * 10;
}

export class Xp {
    /**
     * @param {Gio.Settings} settings - extension settings
     */
    constructor(settings) {
        this._settings = settings;
        this._saveId = 0;
        // Set by the renderer: () => void
        this.onChanged = null;
        this.onLevelUp = null;

        this._load();
        this._writing = false;
        this._changedId = settings.connect(`changed::${KEY}`, () => {
            // Our own write (GSettings emits it during set_value)
            if (this._writing)
                return;
            // Not compared with the last save: a reset to the value saved
            // last must still drop XP not yet saved
            const value = settings.get_value(KEY).deep_unpack();
            if (value.every((v, i) => v === this._state()[i]))
                return;
            this._cancelSave();
            this._load();
            this.onChanged?.();
        });
    }

    /** Total XP. */
    get xp() {
        return this._xp;
    }

    get level() {
        return this._level;
    }

    /** XP within the current level. */
    get current() {
        return this._xp - this._levelStart;
    }

    /** XP the current level needs. */
    get max() {
        return this._next - this._levelStart;
    }

    /** One key that added text; level-up when the target is reached. */
    add() {
        this._xp++;
        if (this._xp >= this._next) {
            this._level++;
            this._levelStart = this._xp;
            this._next = nextTarget(this._xp, this._level);
            this._save();
            this.onChanged?.();
            this.onLevelUp?.();
            return;
        }
        this._scheduleSave();
        this.onChanged?.();
    }

    _scheduleSave() {
        if (this._saveId)
            return;
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
            this._saveId = 0;
            this._save();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** One key that deleted text; not below the level's start. */
    remove() {
        if (this._xp <= this._levelStart)
            return;
        this._xp--;
        this._scheduleSave();
        this.onChanged?.();
    }

    destroy() {
        this._settings.disconnect(this._changedId);
        this._changedId = 0;
        if (this._saveId)
            this._save();
        this._cancelSave();
        this._settings = null;
        this.onChanged = null;
        this.onLevelUp = null;
    }

    _load() {
        let [xp, level, levelStart, next] = this._settings.get_value(KEY).deep_unpack();
        // A broken value (written by hand) starts over
        if (level < 1 || levelStart > xp || next <= xp)
            [xp, level, levelStart, next] = [0, 1, 0, 2 * BASE_XP];
        this._xp = xp;
        this._level = level;
        this._levelStart = levelStart;
        this._next = next;
    }

    _state() {
        return [this._xp, this._level, this._levelStart, this._next];
    }

    _save() {
        this._cancelSave();
        this._writing = true;
        try {
            this._settings.set_value(KEY, new GLib.Variant('(uuuu)', this._state()));
        } finally {
            this._writing = false;
        }
    }

    _cancelSave() {
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
        }
    }
}
