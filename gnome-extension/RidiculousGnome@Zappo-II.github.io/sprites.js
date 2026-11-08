// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

/*
 * Ridiculous mode: sprite effects, in the spirit of Ridiculous Coding.
 *
 * Keys: blip (typing), boom (deleting), newline (Return), combo (a
 * shortcut), nav (an arrow key); which key makes which is effects.js
 * keyEffect(). Pointer: pop (button down), sparkle (along a drag), motion
 * (light blue sparkles along the pointer's path), scroll (a small arrow),
 * swipe (a volley of three arrows across the monitor), pinch (a ring
 * contracting or expanding), smudges (where fingers rest on the
 * touchpad). Each is an SVG from icons/effects/ that grows, turns, floats
 * up and fades out; the arrows fly off in their direction instead. blip,
 * boom and combo can carry the key as a coloured label.
 *
 * Reduced motion ("Animate effects" off, GNOME "Reduce Animation" or the
 * user's shell animations off): a sprite stands still and fades out over
 * its lifetime, arrows pointing their way. When only the shell inhibits
 * animations (e.g. a VM without 3D) it stands still and vanishes at the
 * end, as the shell skips fades then too.
 *
 * Limits as in the VS Code original: at most MAX_ALIVE of each effect at a
 * time (the oldest goes), and blip / boom not more often than minGapMs.
 * All this runs in the compositor process.
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {formatKey, shortcutLabel} from './keyLabels.js';
import {clampedTopLeft, pointer, scatter, targetFor} from './placement.js';

// size: logical px; ttl: ms; turn: largest rotation in degrees; fly: px
// travelled in the effect's direction (arrows); icon: SVG if not the
// effect's name; max: how many may be alive (default MAX_ALIVE)
const EFFECTS = {
    blip: {size: 44, ttl: 400, minGapMs: 20, startScale: 0.5, endScale: 1.5, floatUp: 30, turn: 45},
    boom: {size: 68, ttl: 650, minGapMs: 100, startScale: 0.4, endScale: 1.7, floatUp: 12, turn: 25},
    newline: {size: 60, ttl: 450, minGapMs: 0, startScale: 0.6, endScale: 1.3, floatUp: 24, turn: 0},
    combo: {size: 56, ttl: 500, minGapMs: 0, startScale: 0.5, endScale: 1.4, floatUp: 20, turn: 30},
    nav: {size: 48, ttl: 400, minGapMs: 0, startScale: 1.0, endScale: 0.8, floatUp: 0, turn: 0, fly: 200},
    pop: {size: 52, ttl: 400, minGapMs: 0, startScale: 0.3, endScale: 1.4, floatUp: 0, turn: 60},
    sparkle: {size: 26, ttl: 550, minGapMs: 0, startScale: 1.0, endScale: 0.3, floatUp: 18, turn: 90, max: 16},
    motion: {size: 26, ttl: 550, minGapMs: 0, startScale: 1.0, endScale: 0.3, floatUp: 18, turn: 90, max: 10},
    scroll: {size: 36, ttl: 450, minGapMs: 80, startScale: 1.0, endScale: 0.9, floatUp: 0, turn: 0, fly: 80, icon: 'nav'},
    swipe: {size: 64, ttl: 500, minGapMs: 0, startScale: 1.0, endScale: 0.9, floatUp: 0, turn: 0, fly: 400, icon: 'nav', max: 6},
    pinch: {size: 120, ttl: 450, minGapMs: 0, startScale: 1.0, endScale: 1.0, floatUp: 0, turn: 0},
};
const MAX_ALIVE = 5;

// Pinch: the ring's scale from start to end
const PINCH_SCALES = {in: [1.3, 0.3], out: [0.3, 1.3]};
// Swipe: the volley's arrows side by side, px apart
const SWIPE_SPREAD_PX = 72;

// Smudges: one per finger, side by side in a slight arc at the pointer
// (the helper sends no finger positions), never overlapping; fading on
// release
const SMUDGE_PX = 36;
const SMUDGE_GAP_PX = 40;
const SMUDGE_ARC_PX = 8;
const SMUDGE_MOVE_MS = 120;
const SMUDGE_FADE_MS = 600;
const MAX_SMUDGES = 5;

// nav.svg points right; rotation for each direction
const DIR_ANGLES = {right: 0, down: 90, left: 180, up: 270};
const DIR_VECTORS = {right: [1, 0], down: [0, 1], left: [-1, 0], up: [0, -1]};

// The key label above blip and boom
const LABEL_FLOAT_UP = 48;
const LABEL_COLORS = ['#f8e45c', '#ffa348', '#f66151', '#dc8add', '#99c1f1', '#8ff0a4', '#93ddc2', '#ffffff'];

// Drag: pointer followed every frame once a button is down
const DRAG_PX = 8;
const SPARKLE_GAP_PX = 22;
const FRAME_MS = 16;
// Motion: one sparkle per this many px; a longer jump between two motion
// events starts a new path instead of a line of sparkles
const MOTION_GAP_PX = 40;
const MOTION_JUMP_PX = 400;
// Preview of a drag or motion: three quarters of a loop around the
// pointer, this wide and this long
const DEMO_RADIUS_PX = 70;
const DEMO_MS = 600;

export class Sprites {
    /**
     * @param {string} extensionPath - for the SVGs in icons/effects/
     */
    constructor(extensionPath) {
        const icon = name => Gio.FileIcon.new(Gio.File.new_for_path(`${extensionPath}/icons/effects/${name}.svg`));
        this._icons = {};
        for (const [name, spec] of Object.entries(EFFECTS))
            this._icons[name] = icon(spec.icon ?? name);
        this._smudgeIcon = icon('smudge');
        this._smudges = []; // actors, while fingers rest
        this._fadingSmudges = new Set(); // actors fading out after the fingers left
        this._smudgeAt = null; // [x, y]: the pointer when the first finger came
        this._motionAt = null; // [x, y] of the last motion sparkle
        // Effect name -> items (arrays of actors), oldest first
        this._alive = new Map(Object.keys(EFFECTS).map(name => [name, []]));
        this._lastAt = new Map();
        this._timeouts = new Set();
        this._press = null; // {button, x, y, lastX, lastY, dragging}
        this._frameId = 0;

        // Set by the renderer; drag: follow drags, dragSparkles: show sparkles
        this.animate = true;
        this.charLabels = true;
        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this.drag = true;
        this.dragSparkles = true;
        // Set by the renderer: (x, y) every frame while dragging
        this.onDragMove = null;

        // On shell shutdown the UI is torn down without disable() being called
        this._parent = Main.layoutManager.uiGroup;
        this._parentDestroyId = this._parent.connect('destroy', () => {
            this._parent = null;
            this._parentDestroyId = 0;
            this._alive.forEach(items => (items.length = 0));
            this._smudges.length = 0;
            this._fadingSmudges.clear();
            this.cancel();
        });
    }

    /** True while a button is held (followed for a drag). */
    get pressed() {
        return Boolean(this._press);
    }

    /** True while a button is held and the pointer moved far enough. */
    get dragging() {
        return Boolean(this._press?.dragging);
    }

    /**
     * A key went down.
     *
     * @param {object} event - key-down, key cut down by the Filter, with
     *   the modifiers held (mods) and whether they make a shortcut (command)
     * @param {{effect: string, dir?: string}} what - from keyEffect()
     */
    key(event, {effect, dir}) {
        if (effect === 'nav') {
            // From the target itself, so the direction reads clearly
            const {x, y} = targetFor(event);
            this._spawn('nav', x, y, {dir});
            return;
        }
        let label = null;
        if (effect !== 'newline' && this.charLabels) {
            label = event.command
                ? shortcutLabel(event.mods.filter(m => m !== 'AltGr'), event.key)
                : formatKey(event.key);
        }
        this._spawn(effect, ...scatter(targetFor(event)), {label});
    }

    /**
     * A mouse button went down: a pop (with pop set), and the pointer is
     * followed for a drag until the release (with drag set).
     *
     * @param {number} button - 1 left, 2 middle, 3 right, …
     * @param {boolean} pop - show the pop
     */
    press(button, pop) {
        const [x, y] = pointer();
        if (pop)
            this._spawn('pop', x, y);
        // One button at a time
        if (this._press)
            return;
        // Also without drags: no motion effects while a button is held
        this._press = {button, x, y, lastX: x, lastY: y, dragging: false};
        if (!this.drag)
            return;
        this._frameId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, () => {
            this._follow();
            return GLib.SOURCE_CONTINUE;
        });
    }

    /** A mouse button went up; ends a drag. */
    release(button) {
        if (this._press?.button === button)
            this.cancel();
    }

    /** The pointer moved: light blue sparkles along its path. */
    motion() {
        // A drag has its own sparkles
        if (this._press)
            return;
        const [x, y] = pointer();
        const scale = this._scale();
        const last = this._motionAt;
        if (!last || Math.hypot(x - last[0], y - last[1]) > MOTION_JUMP_PX * scale) {
            this._motionAt = [x, y];
            return;
        }
        this._motionAt = this._trail('motion', last, x, y, MOTION_GAP_PX * scale);
    }

    /**
     * Scrolling: a small arrow from the pointer in the scroll direction.
     *
     * @param {string} dir - 'up', 'down', 'left' or 'right'
     */
    scroll(dir) {
        const [x, y] = pointer();
        this._spawn('scroll', x, y, {dir});
    }

    /**
     * A touchpad swipe: three big arrows from the centre of the pointer's
     * monitor across it.
     *
     * @param {string} dir - 'up', 'down', 'left' or 'right'
     */
    swipe(dir) {
        const monitor = Main.layoutManager.monitors[global.display.get_current_monitor()];
        if (!monitor || !DIR_VECTORS[dir])
            return;
        const [dx, dy] = DIR_VECTORS[dir];
        const spread = SWIPE_SPREAD_PX * this._scale();
        const cx = monitor.x + monitor.width / 2;
        const cy = monitor.y + monitor.height / 2;
        // Side by side across the direction, the middle one a bit ahead
        for (const offset of [-1, 0, 1]) {
            const ahead = offset === 0 ? spread / 2 : 0;
            this._spawn('swipe', cx - dy * offset * spread + dx * ahead,
                cy + dx * offset * spread + dy * ahead, {dir});
        }
    }

    /**
     * A touchpad pinch: a ring at the pointer that contracts (in) or
     * expands (out).
     *
     * @param {string} dir - 'in' or 'out'
     */
    pinch(dir) {
        const [x, y] = pointer();
        this._spawn('pinch', x, y, {scales: PINCH_SCALES[dir] ?? PINCH_SCALES.out});
    }

    /**
     * Fingers rest on the touchpad: one smudge per finger around the
     * pointer. A changed count adds or fades smudges.
     *
     * @param {number} fingers - fingers touching
     */
    touch(fingers) {
        if (!this._parent)
            return;
        const want = Math.min(Math.max(fingers, 0), MAX_SMUDGES);
        if (want === this._smudges.length)
            return;
        while (this._smudges.length > want)
            this._fadeSmudge(this._smudges.pop());
        if (!this._smudgeAt)
            this._smudgeAt = pointer();
        while (this._smudges.length < want) {
            const smudge = new St.Icon({
                gicon: this._smudgeIcon,
                icon_size: SMUDGE_PX,
                reactive: false,
                can_focus: false,
            });
            this._parent.add_child(smudge);
            smudge.set_pivot_point(0.5, 0.5);
            // A little turned, like a finger
            smudge.rotation_angle_z = (Math.random() - 0.5) * 30;
            smudge._rgNew = true;
            this._smudges.push(smudge);
        }
        this._layoutSmudges();
    }

    /** Smudges in a row centred on where the first finger came, a slight arc. */
    _layoutSmudges() {
        const scale = this._scale();
        const size = SMUDGE_PX * scale;
        const gap = SMUDGE_GAP_PX * scale;
        const [cx, cy] = this._smudgeAt;
        const n = this._smudges.length;
        const animate = this.animate && St.Settings.get().enable_animations;
        this._smudges.forEach((smudge, i) => {
            const offset = i - (n - 1) / 2;
            // The middle fingers reach a bit further up
            const lift = n > 1 ? SMUDGE_ARC_PX * scale * (1 - (2 * offset / (n - 1)) ** 2) : 0;
            const [left, top] = clampedTopLeft(cx + offset * gap, cy - lift, size, size, 1, 0);
            if (smudge._rgNew || !animate) {
                delete smudge._rgNew;
                smudge.set_position(left, top);
            } else {
                smudge.ease({x: left, y: top, duration: SMUDGE_MOVE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            }
        });
    }

    /** All fingers left the touchpad: the smudges fade. */
    untouch() {
        this._smudges.splice(0).forEach(smudge => this._fadeSmudge(smudge));
        this._smudgeAt = null;
    }

    /**
     * Preview of a drag or mouse motion (prefs): its sprites along three
     * quarters of a loop around the pointer, as if it moved there.
     *
     * @param {string} name - 'sparkle' or 'motion'
     * @param {function} [onStep] - (elapsed ms) on each frame
     */
    demoPath(name, onStep = null) {
        const [cx, cy] = pointer();
        const scale = this._scale();
        const radius = DEMO_RADIUS_PX * scale;
        const gap = (name === 'motion' ? MOTION_GAP_PX : SPARKLE_GAP_PX) * scale;
        const at = angle => [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
        let last = at(0);
        let elapsed = 0;
        const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, () => {
            elapsed = Math.min(DEMO_MS, elapsed + FRAME_MS);
            last = this._trail(name, last, ...at(elapsed / DEMO_MS * 1.5 * Math.PI), gap);
            onStep?.(elapsed);
            if (elapsed < DEMO_MS)
                return GLib.SOURCE_CONTINUE;
            this._timeouts.delete(timeoutId);
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(timeoutId);
    }

    /** Stops following the pointer, e.g. when the input source changes. */
    cancel() {
        if (this._frameId) {
            GLib.source_remove(this._frameId);
            this._frameId = 0;
        }
        this._press = null;
        this._motionAt = null;
        this._smudges.splice(0).forEach(smudge => smudge.destroy());
        this._smudgeAt = null;
    }

    destroy() {
        this.onDragMove = null;
        this.cancel();
        if (this._parentDestroyId) {
            this._parent.disconnect(this._parentDestroyId);
            this._parentDestroyId = 0;
        }
        this._parent = null;
        this._timeouts.forEach(id => GLib.source_remove(id));
        this._timeouts.clear();
        const fading = [...this._fadingSmudges];
        this._fadingSmudges.clear();
        fading.forEach(smudge => smudge.destroy());
        const items = [...this._alive.values()].flat();
        this._alive.forEach(list => (list.length = 0));
        items.forEach(actors => {
            actors.rgFade?.stop();
            actors.forEach(actor => actor.destroy());
        });
        this._interfaceSettings = null;
    }

    /**
     * How sprites appear now: 'move' animated, 'fade' still and fading
     * (reduced motion), 'still' still and vanishing at the end (only the
     * shell inhibits animations).
     */
    _motionMode() {
        if (this.animate && St.Settings.get().enable_animations)
            return 'move';
        return this.animate && this._interfaceSettings.get_boolean('enable-animations') ? 'still' : 'fade';
    }

    _scale() {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    /** Every frame while a button is held: sparkles along the drag. */
    _follow() {
        const press = this._press;
        const [x, y] = pointer();
        const scale = this._scale();
        if (!press.dragging) {
            if (Math.hypot(x - press.x, y - press.y) < DRAG_PX * scale)
                return;
            press.dragging = true;
        }
        this.onDragMove?.(x, y);
        if (this.dragSparkles)
            [press.lastX, press.lastY] = this._trail('sparkle', [press.lastX, press.lastY], x, y, SPARKLE_GAP_PX * scale);
    }

    /**
     * One sprite per gap travelled from `from` towards (x, y), on the path.
     *
     * @returns {number[]} [x, y] of the last sprite, or `from` if none
     */
    _trail(name, from, x, y, gap) {
        let [lastX, lastY] = from;
        let dx = x - lastX;
        let dy = y - lastY;
        let distance = Math.hypot(dx, dy);
        while (distance >= gap) {
            lastX += dx / distance * gap;
            lastY += dy / distance * gap;
            this._spawn(name, lastX, lastY);
            dx = x - lastX;
            dy = y - lastY;
            distance = Math.hypot(dx, dy);
        }
        return [lastX, lastY];
    }

    /** Fades a smudge out and destroys it. */
    _fadeSmudge(smudge) {
        if (!this.animate || !St.Settings.get().enable_animations) {
            smudge.destroy();
            return;
        }
        this._fadingSmudges.add(smudge);
        smudge.ease({
            opacity: 0,
            duration: SMUDGE_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            // Also when destroy() ended it early
            onStopped: () => {
                if (this._fadingSmudges.delete(smudge))
                    smudge.destroy();
            },
        });
    }

    /**
     * Shows one effect centred on (x, y).
     *
     * @param {string} name - key of EFFECTS
     * @param {number} x - stage coordinates
     * @param {number} y - stage coordinates
     * @param {object} [opts] - label: text above the sprite; dir: 'left',
     *   'right', 'up' or 'down' for the arrows; scales: [start, end]
     *   instead of the spec's (pinch)
     */
    _spawn(name, x, y, {label = null, dir = null, scales = null} = {}) {
        if (!this._parent)
            return;
        const spec = EFFECTS[name];
        const now = GLib.get_monotonic_time() / 1000;
        if (spec.minGapMs && now - (this._lastAt.get(name) ?? -Infinity) < spec.minGapMs)
            return;
        this._lastAt.set(name, now);

        const alive = this._alive.get(name);
        const max = spec.max ?? MAX_ALIVE;
        while (alive.length >= max)
            this._remove(name, alive[0]);

        const scale = this._scale();
        const mode = this._motionMode();
        const animate = mode === 'move';
        const actors = [];

        const icon = new St.Icon({
            gicon: this._icons[name],
            icon_size: spec.size,
            reactive: false,
            can_focus: false,
        });
        this._parent.add_child(icon);
        actors.push(icon);
        const size = spec.size * scale;
        const [startScale, endScale] = scales ?? [spec.startScale, spec.endScale];
        // A flying sprite may leave the monitor: it fades on its way
        const [left, top] = clampedTopLeft(x, y, size, size,
            animate && !spec.fly ? Math.max(startScale, endScale) : 1, animate ? spec.floatUp * scale : 0);
        icon.set_position(left, top);
        icon.set_pivot_point(0.5, 0.5);
        // Pointing its way also when it stands still
        if (dir)
            icon.rotation_angle_z = DIR_ANGLES[dir];

        let text = null;
        if (label) {
            const color = LABEL_COLORS[Math.floor(Math.random() * LABEL_COLORS.length)];
            text = new St.Label({
                text: label,
                style_class: 'rc-sprite-label',
                style: `color: ${color};`,
                reactive: false,
                can_focus: false,
            });
            this._parent.add_child(text);
            actors.push(text);
            const [, width] = text.get_preferred_width(-1);
            const [, height] = text.get_preferred_height(width);
            // Just above the sprite, which is drawn below it
            const [labelLeft, labelTop] = clampedTopLeft(left + size / 2, top - height / 3,
                width, height, 1, animate ? LABEL_FLOAT_UP * scale : 0);
            text.set_position(labelLeft, labelTop);
            text.set_pivot_point(0.5, 0.5);
        }
        alive.push(actors);

        if (mode === 'fade') {
            // A timeline of its own: ease() ends at once while the shell
            // does not animate
            const fade = new Clutter.Timeline({actor: icon, duration: spec.ttl});
            fade.connect('new-frame', () => {
                const p = fade.get_progress();
                actors.forEach(actor => (actor.opacity = Math.round(255 * (1 - p * p))));
            });
            fade.connect('completed', () => this._remove(name, actors));
            actors.rgFade = fade;
            fade.start();
            return;
        }
        if (!animate) {
            // Static for the same time; ease() would end at once without
            // shell animations and the sprite would never be drawn
            const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, spec.ttl, () => {
                this._timeouts.delete(timeoutId);
                this._remove(name, actors);
                return GLib.SOURCE_REMOVE;
            });
            this._timeouts.add(timeoutId);
            return;
        }

        if (dir) {
            const [dx, dy] = DIR_VECTORS[dir];
            icon.set({scale_x: spec.startScale, scale_y: spec.startScale});
            // Fully visible for the first half of its way
            icon.ease({
                opacity: 0,
                delay: spec.ttl / 2,
                duration: spec.ttl / 2,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
            });
            icon.ease({
                scale_x: spec.endScale,
                scale_y: spec.endScale,
                translation_x: dx * spec.fly * scale,
                translation_y: dy * spec.fly * scale,
                duration: spec.ttl,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onStopped: () => this._remove(name, actors),
            });
            return;
        }
        icon.set({
            scale_x: startScale,
            scale_y: startScale,
            rotation_angle_z: (Math.random() - 0.5) * spec.turn,
        });
        icon.ease({
            opacity: 0,
            scale_x: endScale,
            scale_y: endScale,
            translation_y: -spec.floatUp * scale,
            rotation_angle_z: (Math.random() - 0.5) * 2 * spec.turn,
            duration: spec.ttl,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => this._remove(name, actors),
        });
        text?.set({scale_x: 0.8, scale_y: 0.8});
        text?.ease({
            opacity: 0,
            scale_x: 1.2,
            scale_y: 1.2,
            translation_y: -LABEL_FLOAT_UP * scale,
            duration: spec.ttl,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _remove(name, actors) {
        // Also reached when destroy() or the cap ends a running animation
        const alive = this._alive.get(name);
        const index = alive.indexOf(actors);
        if (index < 0)
            return;
        alive.splice(index, 1);
        actors.rgFade?.stop();
        actors.forEach(actor => actor.destroy());
    }
}
