// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

/*
 * Ridiculous mode: where an effect for an event appears.
 *
 * Keys show in the focused window, or while the shell has the input at its
 * key focus; mouse events at the pointer. The helper sends no coordinates,
 * so everything is read here when the event is shown.
 */

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Scatter of key effects around the window centre, in logical px, and as
// a share of the window's smaller side
const WINDOW_SCATTER_PX = 160;
const WINDOW_SCATTER_SHARE = 0.25;
const SHELL_SCATTER_PX = 16;

/**
 * True while the overview, a shell menu or another modal shell UI has the
 * input. focus_window then still points at the last app window, which is
 * not where the user is looking.
 *
 * @returns {boolean}
 */
export function shellHasInput() {
    return Main.overview.visible || Main.actionMode !== Shell.ActionMode.NORMAL;
}

/**
 * Where keys typed into the shell's own UI go: the text cursor of an
 * entry (overview search, run dialog), else the centre of the actor with
 * the key focus (menu item, app tile). Null without a key focus.
 *
 * @returns {number[] | null} [x, y] in stage coordinates
 */
function shellKeyFocusPosition() {
    const focus = global.stage.get_key_focus();
    if (!focus || focus === global.stage || !focus.is_mapped())
        return null;
    const [left, top] = focus.get_transformed_position();
    if (focus instanceof Clutter.Text) {
        const [ok, x, y, lineHeight] = focus.position_to_coords(focus.cursor_position);
        if (ok)
            return [left + x, top + y + lineHeight / 2];
    }
    const [width, height] = focus.get_transformed_size();
    return [left + width / 2, top + height / 2];
}

// Windows that never shake: the desktop and docks
const UNSHAKEN_TYPES = new Set([Meta.WindowType.DESKTOP, Meta.WindowType.DOCK]);

/**
 * The topmost window under a point, as its actor.
 *
 * @param {number} x - stage coordinates
 * @param {number} y - stage coordinates
 * @returns {Meta.WindowActor|null}
 */
export function windowActorAt(x, y) {
    const actors = global.get_window_actors();
    // The list is bottom to top in stacking order; look from the top
    for (let i = actors.length - 1; i >= 0; i--) {
        const actor = actors[i];
        const window = actor.meta_window;
        if (!actor.visible || !window || window.minimized || UNSHAKEN_TYPES.has(window.window_type))
            continue;
        const rect = window.get_frame_rect();
        if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height)
            return actor;
    }
    return null;
}

/** @returns {number} the stage's scale factor */
export function scale() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

/**
 * The pointer in stage coordinates. Use this, not global.get_pointer()
 * spread into arguments: that also returns the modifier mask (with Num
 * Lock on it is not 0).
 *
 * @returns {number[]} [x, y]
 */
export function pointer() {
    const [x, y] = global.get_pointer();
    return [x, y];
}

/**
 * Where an event's effect goes, and how far it may be scattered from there.
 * Keys: focused-window centre, or while the shell has the input its key
 * focus; the pointer when neither is there, and for everything else.
 *
 * @param {object} event - InputSource event
 * @returns {{x: number, y: number, radius: number}} stage coordinates, px
 */
export function targetFor(event) {
    if (event.kind.startsWith('key-')) {
        if (shellHasInput()) {
            const pos = shellKeyFocusPosition();
            if (pos)
                return {x: pos[0], y: pos[1], radius: SHELL_SCATTER_PX * scale()};
        } else {
            const rect = global.display.focus_window?.get_frame_rect();
            if (rect) {
                const radius = Math.min(WINDOW_SCATTER_PX * scale(),
                    Math.min(rect.width, rect.height) * WINDOW_SCATTER_SHARE);
                return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, radius};
            }
        }
    }
    const [x, y] = pointer();
    return {x, y, radius: 0};
}

/**
 * A random point within the target's radius, evenly spread over the disc.
 *
 * @param {{x: number, y: number, radius: number}} target - from targetFor()
 * @returns {number[]} [x, y]
 */
export function scatter(target) {
    if (!target.radius)
        return [target.x, target.y];
    const r = target.radius * Math.sqrt(Math.random());
    const angle = Math.random() * 2 * Math.PI;
    return [target.x + r * Math.cos(angle), target.y + r * Math.sin(angle)];
}

/**
 * Top-left position for an actor of the given size centred on (x, y), moved
 * so it stays inside the monitor containing (x, y) for its whole animation
 * (it grows to endScale and floats up by floatUp).
 *
 * @param {number} x - target centre, stage coordinates
 * @param {number} y - target centre, stage coordinates
 * @param {number} width - unscaled actor width
 * @param {number} height - unscaled actor height
 * @param {number} endScale - largest scale while animating
 * @param {number} floatUp - px it moves up while animating
 * @returns {number[]} [left, top]
 */
export function clampedTopLeft(x, y, width, height, endScale, floatUp) {
    let left = x - width / 2;
    let top = y - height / 2;

    const monitor = Main.layoutManager.findMonitorForPoint(Math.round(x), Math.round(y));
    if (!monitor)
        return [Math.round(left), Math.round(top)];

    // Extra space the actor needs around its unscaled box while animating
    const growX = Math.max(0, width * (endScale - 1) / 2);
    const growY = Math.max(0, height * (endScale - 1) / 2);

    const minLeft = monitor.x + growX;
    const maxLeft = monitor.x + monitor.width - width - growX;
    const minTop = monitor.y + growY + floatUp;
    const maxTop = monitor.y + monitor.height - height - growY;

    left = Math.min(Math.max(left, minLeft), maxLeft);
    top = Math.min(Math.max(top, minTop), maxTop);
    return [Math.round(left), Math.round(top)];
}
