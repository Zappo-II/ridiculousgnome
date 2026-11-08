// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

/*
 * Ridiculous mode: an effect where the input happens.
 *
 * Each trigger (effects.js) has its own switches for image, sound and
 * shake (ridiculous-effects). Images are sprites (sprites.js) in
 * Main.layoutManager.uiGroup, above all windows and shell chrome. Keys
 * shake the focused window, a click the clicked one, swipes and pinches
 * the window under the pointer, as does the start of a scroll; drags and
 * motion the window under the pointer once when the pointer enters it
 * (shake.js). Each
 * trigger has its sound (sound.js). Keys earn XP
 * (xp.js), with fireworks at a level-up (fireworks.js); the extension
 * shows the level in the top bar (panelIndicator.js, via xp and
 * onXpChanged).
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {IMAGE, SHAKE, SOUND, keyEffect, loadEffects} from './effects.js';
import {Fireworks} from './fireworks.js';
import {pointer, windowActorAt} from './placement.js';
import {CLICK_DECAY_MS, ENTER_DECAY_MS, Shake} from './shake.js';
import {Sound} from './sound.js';
import {Sprites} from './sprites.js';
import {Xp} from './xp.js';

// A scroll starts after this long without a wheel step
const SCROLL_PAUSE_MS = 400;

export class Renderer {
    /**
     * @param {Gio.Settings} settings - extension settings
     * @param {string} extensionPath - for the sprites' SVGs and sounds
     */
    constructor(settings, extensionPath) {
        this._animate = true;
        // The window the pointer was last over, for the shake on entering
        this._underPointer = null;
        // Timers of previews
        this._previewIds = new Set();
        // Last wheel step, for the shake at the start of a scroll
        this._scrollAt = -Infinity;

        this._sprites = new Sprites(extensionPath);
        this._sprites.onDragMove = () => {
            if (this._effects.drag[SOUND])
                this._sound.moving('sparkle');
        };
        this._shake = new Shake();
        this._sound = new Sound(extensionPath);
        this._fireworks = new Fireworks();
        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        // Set by the extension, for the top bar
        this.onXpChanged = null;
        this._xp = new Xp(settings);
        this._xp.onChanged = () => this.onXpChanged?.();
        this._xp.onLevelUp = () => this._levelUp();
        this._settings = settings;
        this._settingsChangedId = settings.connect('changed', (_s, key) => {
            if (['ridiculous-char-labels', 'ridiculous-effects', 'ridiculous-sounds'].includes(key))
                this._loadSettings();
        });
        this._loadSettings();

        // On shell shutdown the UI is torn down without disable() being
        // called, while the input source may still deliver events
        this._parent = Main.layoutManager.uiGroup;
        this._parentDestroyId = this._parent.connect('destroy', () => {
            this._parent = null;
            this._parentDestroyId = 0;
        });
    }

    /** Set from the animate-labels setting and reduced motion by the extension. */
    set animate(value) {
        this._animate = value;
        this._sprites.animate = value;
        this._shake.animate = value;
    }

    get animate() {
        return this._animate;
    }

    _loadSettings() {
        this._effects = loadEffects(this._settings);
        // All sounds off without changing the per-trigger switches
        if (!this._settings.get_boolean('ridiculous-sounds'))
            Object.values(this._effects).forEach(switches => (switches[SOUND] = false));
        this._sprites.charLabels = this._settings.get_boolean('ridiculous-char-labels');
        this._sprites.drag = this._effects.drag.some(Boolean);
        this._sprites.dragSparkles = this._effects.drag[IMAGE];
    }

    /** The XP state, for the top bar. */
    get xp() {
        return this._xp;
    }

    /**
     * Fireworks sound; fireworks and a strong shake, or a calm "Level 4!"
     * with reduced motion. Fireworks and shake run on their own timers, so
     * also while only the shell inhibits animations.
     */
    _levelUp() {
        const [image, sound, shake] = this._effects.levelup;
        if (sound)
            this._sound.play('fireworks');
        const moving = this._animate && this._interfaceSettings.get_boolean('enable-animations');
        if (image && moving)
            this._fireworks.launch();
        else if (image)
            this._fireworks.calm(this._xp.level);
        // Shake knows itself when not to
        if (shake)
            this._shake.levelUp();
    }

    /** Forgets a held button, e.g. when the input source changes. */
    reset() {
        this._sprites.cancel();
        this._shake.stop();
        this._underPointer = null;
    }

    fire(event) {
        if (!this._parent)
            return;

        const effects = this._effects;
        switch (event.kind) {
        case 'key-down':
            this._key(event);
            break;
        case 'mouse-button-down': {
            const [image, sound, shake] = effects.click;
            // Always: the sprites tell motion whether a button is held
            this._sprites.press(event.button, image);
            if (sound)
                this._sound.play('pop');
            // The clicked window; entering it again later shakes nothing
            const actor = this._windowUnderPointer();
            if (shake && actor)
                this._shake.window(actor, CLICK_DECAY_MS);
            break;
        }
        case 'mouse-button-up':
            this._sprites.release(event.button);
            break;
        case 'mouse-motion':
            // The drag sound comes from the sprites, which follow every frame
            if (this._sprites.dragging) {
                this._enter('drag');
            } else {
                if (effects.motion[IMAGE])
                    this._sprites.motion();
                // Not while a button is held, like the sparkles
                if (effects.motion[SOUND] && !this._sprites.pressed)
                    this._moving('motion');
                this._enter('motion');
            }
            break;
        case 'mouse-wheel':
            if (effects.scroll[IMAGE])
                this._sprites.scroll(event.wheelDir);
            if (effects.scroll[SOUND])
                this._sound.scroll();
            this._scrollStart();
            break;
        case 'touch-swipe':
            if (effects.swipe[IMAGE])
                this._sprites.swipe(event.dir);
            if (effects.swipe[SOUND])
                this._sound.play('swipe');
            this._gesture('swipe');
            break;
        case 'touch-pinch':
            if (effects.pinch[IMAGE])
                this._sprites.pinch(event.dir);
            if (effects.pinch[SOUND])
                this._sound.play(event.dir === 'in' ? 'pinch-in' : 'pinch-out');
            this._gesture('pinch');
            break;
        case 'touch-down':
            if (effects.touch[IMAGE])
                this._sprites.touch(event.fingers);
            break;
        case 'touch-up':
            this._sprites.untouch();
            break;
        }
    }

    /** Motion sound, when the pointer moves briskly. */
    _moving(effect) {
        this._sound.moving(effect);
    }

    _scale() {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    /** The window under the pointer, remembered for _enter(). */
    _windowUnderPointer() {
        this._underPointer = windowActorAt(...pointer());
        return this._underPointer;
    }

    /**
     * A single gesture (swipe, pinch): shakes the window under the pointer
     * each time, the pointer usually stays where it is.
     *
     * @param {string} trigger - id in effects.js
     */
    _gesture(trigger) {
        const actor = this._windowUnderPointer();
        if (actor && this._effects[trigger][SHAKE])
            this._shake.window(actor, ENTER_DECAY_MS);
    }

    /**
     * Scrolling shakes the window under the pointer once at the start of a
     * scroll (the first step after SCROLL_PAUSE_MS without one), not on
     * every step: the pointer usually stays in one window, and motion has
     * already "entered" it.
     */
    _scrollStart() {
        const at = GLib.get_monotonic_time() / 1000;
        const start = at - this._scrollAt >= SCROLL_PAUSE_MS;
        this._scrollAt = at;
        const actor = this._windowUnderPointer();
        if (start && actor && this._effects.scroll[SHAKE])
            this._shake.window(actor, ENTER_DECAY_MS);
    }

    /**
     * A continuous pointer trigger (drag, motion): shakes the
     * window under the pointer if the
     * pointer just entered it and the trigger's shake is on.
     *
     * @param {string} trigger - id in effects.js
     */
    _enter(trigger) {
        const before = this._underPointer;
        const actor = this._windowUnderPointer();
        if (actor && actor !== before && this._effects[trigger][SHAKE])
            this._shake.window(actor, ENTER_DECAY_MS);
    }

    /**
     * Preview of one trigger (prefs): its effect as if it happened now,
     * with the trigger's switches; keys at the focused window (the prefs),
     * pointer effects at the pointer. Earns no XP.
     *
     * @param {string} trigger - id in effects.js
     */
    preview(trigger) {
        if (!this._parent || !(trigger in this._effects))
            return;
        const [image, sound, shake] = this._effects[trigger];
        const later = (ms, fn) => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._previewIds.delete(id);
                fn();
                return GLib.SOURCE_REMOVE;
            });
            this._previewIds.add(id);
        };
        const key = (k, mods = []) => this._key({kind: 'key-down', key: k, mods, command: mods.length > 0}, false);
        switch (trigger) {
        case 'typing':
            key('a');
            break;
        case 'delete':
            key('BackSpace');
            break;
        case 'return':
            key('Return');
            break;
        case 'combo':
            key('s', ['Ctrl']);
            break;
        case 'nav':
            key('Right');
            break;
        case 'click':
            this.fire({kind: 'mouse-button-down', button: 1});
            later(150, () => this.fire({kind: 'mouse-button-up', button: 1}));
            break;
        case 'drag':
        case 'motion': {
            const name = trigger === 'drag' ? 'sparkle' : 'motion';
            let sounds = 0;
            // The path, or only its sound and shake with the image off
            const step = elapsed => {
                if (sound && elapsed >= sounds * 220 && sounds < 3) {
                    sounds++;
                    this._sound.play(name);
                }
            };
            if (image)
                this._sprites.demoPath(name, step);
            else
                [0, 220, 440].forEach(ms => later(ms, () => step(ms)));
            this._previewShake(shake);
            break;
        }
        case 'scroll':
            if (image)
                this._sprites.scroll('down');
            if (sound)
                this._sound.scroll();
            this._previewShake(shake);
            break;
        case 'swipe':
            if (image)
                this._sprites.swipe('right');
            if (sound)
                this._sound.play('swipe');
            this._previewShake(shake);
            break;
        case 'pinch':
            if (image)
                this._sprites.pinch('in');
            if (sound)
                this._sound.play('pinch-in');
            this._previewShake(shake);
            break;
        case 'touch':
            if (image) {
                this._sprites.touch(3);
                later(1000, () => this._sprites.untouch());
            }
            break;
        case 'levelup':
            this._levelUp();
            break;
        }
    }

    /** The window under the pointer shakes as when the pointer enters it. */
    _previewShake(shake) {
        const actor = this._windowUnderPointer();
        if (shake && actor)
            this._shake.window(actor, ENTER_DECAY_MS);
    }

    /**
     * A key-down: its effect's image, sound and shake, and XP.
     *
     * @param {object} event - key-down from the Filter
     * @param {boolean} [earn] - count XP (not for a preview)
     */
    _key(event, earn = true) {
        const what = keyEffect(event.key, event.mods, event.detail);
        if (!what)
            return;
        const [image, sound, shake] = this._effects[what.trigger];
        if (image)
            this._sprites.key(event, what);
        if (shake)
            this._shake.trigger(what.effect);
        if (sound)
            this._sound.play(what.effect);
        // Also with all three switches off
        if (!earn)
            return;
        if (what.xp > 0)
            this._xp.add();
        else if (what.xp < 0)
            this._xp.remove();
    }

    destroy() {
        this._previewIds.forEach(id => GLib.source_remove(id));
        this._previewIds.clear();
        this._settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = 0;
        this._settings = null;
        this._sprites.destroy();
        this._sprites = null;
        this._shake.destroy();
        this._shake = null;
        this._sound.destroy();
        this._sound = null;
        this.onXpChanged = null;
        this._xp.destroy();
        this._xp = null;
        this._fireworks.destroy();
        this._fireworks = null;
        this._interfaceSettings = null;

        if (this._parentDestroyId) {
            this._parent.disconnect(this._parentDestroyId);
            this._parentDestroyId = 0;
        }
        this._parent = null;
        this._underPointer = null;
    }
}
