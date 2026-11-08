// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

/*
 * Ridiculous mode: fireworks at a level-up, in the spirit of Ridiculous
 * Coding (80 particles for 1.5 s there, in its side panel).
 *
 * Here across the focused window's monitor: BURSTS bursts, a little apart
 * in time and place, each a ring of coloured dots that fly out, fall and
 * fade. One Clutter.Timeline moves all dots, which are small St.Widgets in
 * a layer above everything else; the layer goes when it is done.
 *
 * With reduced motion a calm "Level 4!" instead (calm()): large text in
 * the centre of the focused window that fades out.
 */

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BURSTS = 3;
const PARTICLES_PER_BURST = 32;
const BURST_GAP_MS = 280;
const PARTICLE_MS = 1300;
const DURATION_MS = (BURSTS - 1) * BURST_GAP_MS + PARTICLE_MS;
// Logical px per second, px per second squared, logical px
const SPEED_MIN = 180;
const SPEED_MAX = 420;
const GRAVITY = 260;
const DOT_PX = 7;
// The calm level-up text: shown this long, fading over the second half
const CALM_MS = 1500;

/**
 * @param {number} h - hue 0…360
 * @returns {string} a bright colour as #rrggbb
 */
function brightColor(h) {
    const hue = ((h % 360) + 360) % 360;
    const f = n => {
        const k = (n + hue / 30) % 12;
        const v = 0.6 - 0.9 * 0.4 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
        return Math.round(v * 255).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

export class Fireworks {
    constructor() {
        this._layer = null;
        this._timeline = null;
    }

    /** Starts fireworks on the focused window's monitor (or the pointer's). */
    launch() {
        this.stop();
        const parent = Main.layoutManager.uiGroup;
        const display = global.display;
        const index = display.focus_window?.get_monitor() ?? display.get_current_monitor();
        const monitor = Main.layoutManager.monitors[index] ?? Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;

        const layer = new St.Widget({
            x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height,
            reactive: false,
        });
        parent.add_child(layer);
        this._layer = layer;
        // Also gone with the shell's UI on shutdown
        layer.connect('destroy', () => {
            if (this._layer === layer)
                this._forget();
        });

        const particles = [];
        for (let b = 0; b < BURSTS; b++) {
            const cx = monitor.width * (0.2 + 0.6 * Math.random());
            const cy = monitor.height * (0.15 + 0.35 * Math.random());
            const hue = Math.random() * 360;
            for (let i = 0; i < PARTICLES_PER_BURST; i++) {
                const angle = (i + Math.random() * 0.6) / PARTICLES_PER_BURST * 2 * Math.PI;
                const speed = (SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN)) * scale;
                const dot = new St.Widget({
                    style_class: 'rc-firework',
                    style: `background-color: ${brightColor(hue + Math.random() * 60 - 30)};`,
                    visible: false,
                });
                layer.add_child(dot);
                particles.push({
                    dot, cx, cy,
                    vx: Math.cos(angle) * speed,
                    vy: Math.sin(angle) * speed,
                    startMs: b * BURST_GAP_MS,
                    lifeMs: PARTICLE_MS * (0.7 + 0.3 * Math.random()),
                });
            }
        }

        const half = DOT_PX * scale / 2;
        const gravity = GRAVITY * scale;
        const timeline = new Clutter.Timeline({actor: layer, duration: DURATION_MS});
        timeline.connect('new-frame', (_t, elapsed) => {
            for (const p of particles) {
                const t = (elapsed - p.startMs) / 1000;
                if (t < 0 || t * 1000 > p.lifeMs) {
                    p.dot.visible = false;
                    continue;
                }
                p.dot.visible = true;
                p.dot.set_position(
                    Math.round(p.cx + p.vx * t - half),
                    Math.round(p.cy + p.vy * t + gravity * t * t / 2 - half));
                // Fade out over the last half of its life
                p.dot.opacity = Math.round(255 * Math.min(1, 2 * (1 - t * 1000 / p.lifeMs)));
            }
        });
        timeline.connect('completed', () => this.stop());
        this._timeline = timeline;
        timeline.start();
    }

    /**
     * Shows "Level 4!" in the centre of the focused window (or the
     * pointer's monitor) and fades it out; nothing moves.
     *
     * @param {number} level - the new level
     */
    calm(level) {
        this.stop();
        const parent = Main.layoutManager.uiGroup;
        const display = global.display;
        const window = display.focus_window;
        const index = window?.get_monitor() ?? display.get_current_monitor();
        const monitor = Main.layoutManager.monitors[index] ?? Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const label = new St.Label({
            text: _('Level %d!').replace('%d', `${level}`),
            style_class: 'rc-level-up',
            reactive: false,
            can_focus: false,
        });
        parent.add_child(label);
        this._layer = label;
        label.connect('destroy', () => {
            if (this._layer === label)
                this._forget();
        });
        const [, width] = label.get_preferred_width(-1);
        const [, height] = label.get_preferred_height(width);
        const rect = window?.get_frame_rect();
        const cx = rect ? rect.x + rect.width / 2 : monitor.x + monitor.width / 2;
        const cy = rect ? rect.y + rect.height / 2 : monitor.y + monitor.height / 2;
        // Whole on the monitor also for a window partly off it
        const clamp = (v, min, size) => Math.round(Math.max(min, Math.min(v, min + size)));
        label.set_position(
            clamp(cx - width / 2, monitor.x, monitor.width - width),
            clamp(cy - height / 2, monitor.y, monitor.height - height));

        // A timeline of its own: ease() ends at once while the shell does
        // not animate
        const timeline = new Clutter.Timeline({actor: label, duration: CALM_MS});
        timeline.connect('new-frame', () => {
            const p = timeline.get_progress();
            label.opacity = Math.round(255 * Math.min(1, 2 * (1 - p)));
        });
        timeline.connect('completed', () => this.stop());
        this._timeline = timeline;
        timeline.start();
    }

    /** Ends running fireworks or the calm text at once. */
    stop() {
        const layer = this._layer;
        this._forget();
        layer?.destroy();
    }

    destroy() {
        this.stop();
    }

    _forget() {
        this._timeline?.stop();
        this._timeline = null;
        this._layer = null;
    }
}
