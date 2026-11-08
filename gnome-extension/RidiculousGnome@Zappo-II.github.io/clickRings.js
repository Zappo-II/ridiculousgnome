// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

/*
 * Presentation mode: what the mouse does, where it happens.
 *
 * Click: rings expanding and fading at the pointer — left button one ring,
 * right two, middle three (concentric). A second click of the same button
 * within GNOME's double-click time draws thicker rings, as apps would take
 * it for a double click.
 *
 * Drag: while a button is held, the pointer is followed every frame; once
 * it moved DRAG_PX, an anchor stays at the start, a line runs from there to
 * rings following the pointer, and the drop gets rings again. Anchor and
 * follower have as many rings as a click of that button.
 *
 * The helper sends no coordinates; the pointer position is read here.
 * `clicks` draws the click rings, `dragLine` the drag's anchor, line,
 * followers and drop rings. Drags are detected also with `dragLine` off,
 * only nothing is drawn; with `drag` off they are not followed at all (a
 * long press then).
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DEFAULT_ACCENT, parseHex} from './look.js';
import {pointer} from './placement.js';

// Button numbers as the helper and Clutter send them (X convention)
const RING_COUNTS = {1: 1, 3: 2, 2: 3};

const START_SIZE_PX = 16;
const END_SIZE_PX = 72;
const RING_GAP = 0.28; // inner rings, as a share of the outer size
const DURATION_MS = 450;

const DRAG_PX = 8;
const FRAME_MS = 16;
const ANCHOR_PX = 28;
const FOLLOWER_PX = 36;
const LINE_PX = 3;

// Fill of each kind of actor, as alpha of the ring colour
const FILL_ALPHA = {'rc-ring': 0.12, 'rc-drag-anchor': 0.35, 'rc-drag-follower': 0.12, 'rc-drag-line': 0.7};

export class ClickRings {
    constructor() {
        this._rings = new Set();
        this._timeouts = new Set();
        this._lastClick = {button: 0, time: 0};
        this._press = null; // {button, x, y, onDrag, dragging, actors, line, followers}
        this._frameId = 0;
        this._mouseSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.peripherals.mouse'});

        // Set by the renderer: false for reduced motion; what to draw; drag:
        // follow drags at all
        this.animate = true;
        this.clicks = true;
        this.dragLine = true;
        this.drag = true;
        this.color = DEFAULT_ACCENT;
        // A preview's made-up pointer: () => [x, y], or null for the real one
        this.fakePointer = null;

        // On shell shutdown the UI is torn down without disable() being called
        this._parent = Main.layoutManager.uiGroup;
        this._parentDestroyId = this._parent.connect('destroy', () => {
            this._parent = null;
            this._parentDestroyId = 0;
            this._rings.clear();
            // Also stops the follow timer, which would read the press
            this.cancel();
        });
    }

    /** @returns {boolean} whether the button gets rings (side buttons do not) */
    static handles(button) {
        return button in RING_COUNTS;
    }

    /**
     * A button went down: rings, and the pointer is followed until release.
     *
     * @param {number} button - 1 left, 2 middle, 3 right
     * @param {Function} onDrag - called once the pointer moved far enough
     */
    press(button, onDrag) {
        const now = Date.now();
        const double = button === this._lastClick.button &&
            now - this._lastClick.time <= this._mouseSettings.get_int('double-click');
        // A third click starts over, as in apps
        this._lastClick = {button: double ? 0 : button, time: now};

        const [x, y] = this._pointer();
        if (this.clicks)
            this._burst(x, y, button, double);

        // One button at a time; a second one pressed meanwhile only rings
        if (this._press || !this.drag)
            return;
        this._press = {button, x, y, onDrag, dragging: false};
        this._frameId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, () => {
            this._follow();
            return GLib.SOURCE_CONTINUE;
        });
    }

    /** A button went up; a drag ends with rings at the drop. */
    release(button) {
        if (this._press?.button !== button)
            return;
        if (this._press.dragging && this.dragLine) {
            const [x, y] = this._pointer();
            this._burst(x, y, button, false);
        }
        this.cancel();
    }

    /** Stops following the pointer, e.g. when the input source changes. */
    cancel() {
        if (this._frameId) {
            GLib.source_remove(this._frameId);
            this._frameId = 0;
        }
        const press = this._press;
        this._press = null;
        press?.actors?.forEach(actor => this._fadeOut(actor));
    }

    destroy() {
        this.cancel();
        if (this._parentDestroyId) {
            this._parent.disconnect(this._parentDestroyId);
            this._parentDestroyId = 0;
        }
        this._parent = null;
        this._mouseSettings = null;
        this._timeouts.forEach(id => GLib.source_remove(id));
        this._timeouts.clear();
        const rings = [...this._rings];
        this._rings.clear();
        rings.forEach(ring => ring.destroy());
    }

    _pointer() {
        return this.fakePointer?.() ?? pointer();
    }

    _scale() {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    /** Every frame while a button is held: detect and draw the drag. */
    _follow() {
        const press = this._press;
        const [x, y] = this._pointer();
        const dx = x - press.x;
        const dy = y - press.y;
        const distance = Math.hypot(dx, dy);
        if (!press.dragging) {
            if (distance < DRAG_PX * this._scale())
                return;
            press.dragging = true;
            press.onDrag();
            if (this.dragLine && this._parent)
                this._startDrawing(press);
        }
        if (!press.line)
            return;
        press.line.set_size(Math.round(distance), press.line.height);
        press.line.rotation_angle_z = Math.atan2(dy, dx) * 180 / Math.PI;
        for (const ring of press.followers) {
            const half = ring.width / 2;
            ring.set_position(Math.round(x - half), Math.round(y - half));
        }
    }

    _startDrawing(press) {
        const scale = this._scale();
        const lineHeight = Math.round(LINE_PX * scale);
        press.line = this._actor('rc-drag-line', 0, lineHeight, press.x, press.y - lineHeight / 2);
        // Rotate around the start point
        press.line.set_pivot_point(0, 0.5);
        // Concentric rings, as many as a click of this button
        const rings = (px, styleClass) => Array.from({length: RING_COUNTS[press.button]}, (_, i) => {
            const size = Math.round(px * scale * (1 - i * RING_GAP));
            return this._actor(styleClass, size, size, press.x - size / 2, press.y - size / 2);
        });
        const anchors = rings(ANCHOR_PX, 'rc-ring rc-drag-anchor');
        press.followers = rings(FOLLOWER_PX, 'rc-ring rc-drag-follower');
        press.actors = [press.line, ...anchors, ...press.followers];
    }

    _actor(styleClass, width, height, x, y) {
        // The colour comes from the settings, the shapes from the stylesheet
        const [r, g, b] = parseHex(this.color) ?? parseHex(DEFAULT_ACCENT);
        const kind = styleClass.split(' ').at(-1);
        const fill = `background-color: rgba(${r}, ${g}, ${b}, ${FILL_ALPHA[kind] ?? FILL_ALPHA['rc-ring']});`;
        const actor = new St.Widget({
            style_class: styleClass,
            style: kind === 'rc-drag-line' ? fill : `border-color: rgb(${r}, ${g}, ${b}); ${fill}`,
            reactive: false,
            width,
            height,
            x: Math.round(x),
            y: Math.round(y),
        });
        this._parent.add_child(actor);
        this._rings.add(actor);
        return actor;
    }

    _remove(actor) {
        if (this._rings.delete(actor))
            actor.destroy();
    }

    _fadeOut(actor) {
        if (!actor || !this._rings.has(actor))
            return;
        if (!St.Settings.get().enable_animations) {
            this._remove(actor);
            return;
        }
        actor.ease({
            opacity: 0,
            duration: DURATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => this._remove(actor),
        });
    }

    /** Rings for one click at (x, y). */
    _burst(x, y, button, double) {
        if (!this._parent || !ClickRings.handles(button))
            return;
        const scale = this._scale();
        for (let i = 0; i < RING_COUNTS[button]; i++)
            this._ring(x, y, scale * (1 - i * RING_GAP), double);
    }

    /** One ring centred on (x, y); scale shrinks the inner rings. */
    _ring(x, y, scale, double) {
        const box = size => {
            const px = Math.round(size * scale);
            return [px, px, x - px / 2, y - px / 2];
        };
        // Reduced motion: no expansion, only the fade
        const animate = this.animate;
        const ring = this._actor(double ? 'rc-ring rc-ring-double' : 'rc-ring',
            ...box(animate ? START_SIZE_PX : END_SIZE_PX));

        // Shell animations off (setting, or inhibited in a VM without 3D):
        // ease() would end at once, before the ring is ever drawn
        if (!St.Settings.get().enable_animations) {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DURATION_MS, () => {
                this._timeouts.delete(id);
                this._remove(ring);
                return GLib.SOURCE_REMOVE;
            });
            this._timeouts.add(id);
            return;
        }
        // Width and height rather than scale, so the border keeps its width
        const [width, height, left, top] = box(END_SIZE_PX);
        ring.ease({
            ...(animate ? {width, height, x: Math.round(left), y: Math.round(top)} : {}),
            opacity: 0,
            duration: DURATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => this._remove(ring),
        });
    }
}
