// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

/*
 * Presentation mode: keys, shortcuts and the wheel at a fixed place on
 * screen, for screen recordings. Same interface as Renderer (fire,
 * destroy, animate) plus reset().
 *
 * Targets (presentation-target):
 * - subtitle / heading: one line of recent actions, bottom or top centre;
 * - card: a corner card with three rows — modifiers, key, scroll — each
 *   showing the latest of its kind.
 *
 * Input is paired press/release (the Filter passes key-up here): modifiers
 * held, keys held longer than HOLD_MS. The helper sends no auto-repeat, so
 * repeats count real presses.
 *
 * Clicks: a chip (`Click`, `Ctrl + Click`; a double click counts ×2) and
 * rings at the pointer (ClickRings). A button held and moved becomes
 * `Drag`, drawn from start to pointer. Each has its own switches for chip
 * and mark (presentation-effects, effects.js): a drag shows also with the
 * click's switches off.
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ClickRings} from './clickRings.js';
import {CHIP, MARK, anyOn, loadEffects} from './effects.js';
import {COMMAND_MODS, MODIFIERS, TYPING_CLASSES, keyName, sortedMods} from './keyLabels.js';
import {presentationLook, resolveAccent} from './look.js';
import {pointer} from './placement.js';

const MAX_CHIPS = 8;
const MAX_TYPED_CHARS = 24;
const HOLD_MS = 400;
const FADE_MS = 250;
const TICK_MS = 50;
// The line keeps its width while input goes on, so a centred line does not
// jump when its oldest chip goes; it shrinks after this pause
const SHRINK_PAUSE_MS = 600;
const MARGIN_PX = 48;

// Level5 is rare and only selects characters
const IGNORED_KEYS = new Set(['ISO_Level5_Shift']);

const WHEEL_ARROWS = {up: '↑', down: '↓', left: '←', right: '→'};

// Button numbers (X convention) -> chip text
const BUTTON_NAMES = {1: 'Click', 2: 'Middle click', 3: 'Right click', 8: 'Back', 9: 'Forward'};
const DRAG_NAMES = {1: 'Drag', 2: 'Middle drag', 3: 'Right drag'};

// Preview of a drag: from the pointer this far right and down, this long
const DEMO_DRAG_PX = [160, 40];
const DEMO_DRAG_MS = 700;

const SIZE_CLASSES = {small: 'rc-pres-small', medium: 'rc-pres-medium', large: 'rc-pres-large'};

/** @returns {boolean} whether a key label is typing rather than a command */
function isTyping(label) {
    return label in TYPING_CLASSES || [...label].length === 1;
}

/**
 * One chip: a key or shortcut, a typing burst, or wheel turns.
 * kind 'key': mods + key (key null: modifiers tapped alone);
 * kind 'typing': typed items, each with its own time;
 * kind 'scroll': mods + direction.
 *
 * Each chip, and each typed item, lives `ttl` ms from when it was last
 * touched; a held chip does not age until released.
 */
class Action {
    constructor(kind, mods = [], key = null) {
        this.kind = kind;
        this.mods = mods;
        this.key = key;
        this.count = 1;
        this.held = false;
        this.items = []; // typing: {label, time}
        this.touch();
    }

    touch() {
        this.time = Date.now();
    }

    /** @returns {boolean} whether another press of the same adds to this one */
    sameAs(kind, mods, key) {
        return this.kind === kind && this.key === key && this.mods.join() === mods.join();
    }

    addTyped(label) {
        this.items.push({label, time: Date.now()});
        this.touch();
    }

    /**
     * Drops what is older than ttl.
     *
     * @returns {number} 0 when gone, else its opacity (fading in the last FADE_MS)
     */
    age(now, ttl) {
        if (this.held)
            return 255;
        if (this.kind === 'typing') {
            this.items = this.items.filter(item => now - item.time < ttl);
            return this.items.length > 0 ? 255 : 0;
        }
        const left = ttl - (now - this.time);
        return left <= 0 ? 0 : Math.round(255 * Math.min(1, left / FADE_MS));
    }

    modsText() {
        return this.mods.join(' + ');
    }

    keyText() {
        let text;
        if (this.kind === 'typing')
            text = this._typedText();
        else if (this.kind === 'scroll')
            text = `Scroll ${this.key}`;
        else
            text = this.key ?? '';
        if (this.count > 1)
            text += ` ×${this.count}`;
        if (this.held)
            text += ' …';
        return text;
    }

    /** Characters as typed, or below `characters` the classes seen and a count. */
    _typedText() {
        const labels = this.items.map(item => item.label);
        if (labels.length > 0 && labels[0] in TYPING_CLASSES) {
            // Spaces count, but the chip names only what is typed between
            const classes = [...new Set(labels.filter(l => l !== 'space').map(l => TYPING_CLASSES[l]))];
            const text = classes.join(' ') || TYPING_CLASSES.space;
            return labels.length > 1 ? `${text} ×${labels.length}` : text;
        }
        return labels.join('').slice(-MAX_TYPED_CHARS).replaceAll(' ', TYPING_CLASSES.space);
    }

    display() {
        return [this.modsText(), this.keyText()].filter(Boolean).join(' + ');
    }
}

export class PresentationRenderer {
    /** @param {Gio.Settings} settings - extension settings (presentation-*) */
    constructor(settings) {
        this._settings = settings;
        this._actor = null;
        this._timeouts = new Map(); // name -> source id
        this._held = new Map(); // key label -> Action held down
        this._mods = new Set();
        this._modsAlone = false;
        this._chips = []; // line targets: recent actions, oldest first
        this._dying = new Set(); // removed actors waiting for the next frame
        this._rows = {mods: null, key: null, scroll: null}; // card target
        this._rings = new ClickRings();
        this._button = null; // {button, action} while a mouse button is held
        this._lastInput = 0;
        this._minWidth = 0;
        this._animate = true;

        // The desktop's accent colour (GNOME 47+), followed live
        const schema = Gio.SettingsSchemaSource.get_default()?.lookup('org.gnome.desktop.interface', true);
        this._interfaceSettings = schema?.has_key('accent-color')
            ? new Gio.Settings({schema_id: 'org.gnome.desktop.interface'})
            : null;
        this._accentChangedId = this._interfaceSettings?.connect('changed::accent-color', () => {
            this._removeActor();
            this._readSettings();
        }) ?? 0;

        this._readSettings();
        this._settingsChangedId = settings.connect('changed', (_s, key) => {
            if (key.startsWith('presentation-')) {
                this._removeActor();
                this._readSettings();
            }
        });

        // On shell shutdown the UI is torn down without disable() being called
        this._parent = Main.layoutManager.uiGroup;
        this._parentDestroyId = this._parent.connect('destroy', () => {
            this._parent = null;
            this._parentDestroyId = 0;
            this._actor = null;
            this._removeTimeout('tick');
            // Gone with their parent; only the waiting is left to stop
            [...this._dying].forEach(pending => this._finishDying(pending, false));
        });
    }

    /** Set from the animate-labels setting by the extension. */
    get animate() {
        return this._animate;
    }

    set animate(value) {
        this._animate = value;
        this._rings.animate = value;
    }

    fire(event) {
        switch (event.kind) {
        case 'mouse-button-down':
            this._click(event.button);
            break;
        case 'mouse-button-up':
            this._release(event.button);
            break;
        case 'key-down':
            this._keyDown(event.key);
            break;
        case 'key-up':
            this._keyUp(event.key);
            break;
        case 'mouse-wheel':
            this._scroll(WHEEL_ARROWS[event.wheelDir] ?? event.wheelDir);
            break;
        case 'touch-swipe':
            this._gesture(`${event.fingers}-finger swipe ${WHEEL_ARROWS[event.dir] ?? event.dir}`);
            break;
        case 'touch-pinch':
            this._gesture(event.dir === 'out' ? 'Pinch out' : 'Pinch in');
            break;
        }
    }

    /**
     * Preview of one trigger (prefs), with its switches, as if it happened
     * now: Ctrl + S, a click, a drag along a made-up path from the
     * pointer, a scroll down, a swipe.
     *
     * @param {string} trigger - id in effects.js PRESENTATION_TRIGGERS
     */
    preview(trigger) {
        const later = (ms, fn) => this._addTimeout(`preview:${trigger}:${ms}`, ms, fn);
        switch (trigger) {
        case 'keys':
            this.fire({kind: 'key-down', key: 'Control_L'});
            this.fire({kind: 'key-down', key: 's'});
            later(150, () => this.fire({kind: 'key-up', key: 's'}));
            later(250, () => this.fire({kind: 'key-up', key: 'Control_L'}));
            break;
        case 'click':
            this.fire({kind: 'mouse-button-down', button: 1});
            later(150, () => this.fire({kind: 'mouse-button-up', button: 1}));
            break;
        case 'drag': {
            if (this._button)
                return;
            const [x, y] = pointer();
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const start = GLib.get_monotonic_time() / 1000;
            this._rings.fakePointer = () => {
                const t = Math.min(1, (GLib.get_monotonic_time() / 1000 - start) / DEMO_DRAG_MS);
                const eased = 1 - (1 - t) ** 2;
                return [x + DEMO_DRAG_PX[0] * scale * eased, y + DEMO_DRAG_PX[1] * scale * eased];
            };
            this.fire({kind: 'mouse-button-down', button: 1});
            later(DEMO_DRAG_MS + 100, () => {
                this.fire({kind: 'mouse-button-up', button: 1});
                this._rings.fakePointer = null;
            });
            break;
        }
        case 'scroll':
            this.fire({kind: 'mouse-wheel', wheelDir: 'down'});
            break;
        case 'gesture':
            this.fire({kind: 'touch-swipe', fingers: 3, dir: 'right'});
            break;
        }
    }

    /** Forgets keys held, e.g. when the input source changes. */
    reset() {
        this._forgetKeys();
        this._button = null;
        this._rings.fakePointer = null;
        this._rings.cancel();
    }

    /**
     * Forgets keys held whose releases will not come (keys of an `off`
     * window); clicks and drags go on.
     */
    releaseKeys() {
        const shown = this._mods.size > 0 || this._held.size > 0;
        this._forgetKeys();
        // The live modifier chip goes; the rest fades as usual
        if (shown && this._actor)
            this._update();
    }

    _forgetKeys() {
        // A held chip does not age; as if released now
        for (const action of this._held.values()) {
            if (action.held) {
                action.held = false;
                action.touch();
            }
        }
        this._held.clear();
        this._mods.clear();
        this._modsAlone = false;
        for (const name of [...this._timeouts.keys()].filter(n => n.startsWith('hold:')))
            this._removeTimeout(name);
    }

    destroy() {
        this._settings.disconnect(this._settingsChangedId);
        this._settings = null;
        if (this._accentChangedId)
            this._interfaceSettings.disconnect(this._accentChangedId);
        this._interfaceSettings = null;
        if (this._parentDestroyId) {
            this._parent.disconnect(this._parentDestroyId);
            this._parentDestroyId = 0;
        }
        this._parent = null;
        this._rings.destroy();
        this._rings = null;
        this._removeActor();
        // Disabled: nothing may stay behind
        [...this._dying].forEach(pending => this._finishDying(pending));
        this._timeouts.forEach(id => GLib.source_remove(id));
        this._timeouts.clear();
    }

    _readSettings() {
        this._target = this._settings.get_string('presentation-target');
        this._corner = this._settings.get_string('presentation-corner');
        this._monitorChoice = this._settings.get_string('presentation-monitor');
        this._sizeClass = SIZE_CLASSES[this._settings.get_string('presentation-size')] ?? SIZE_CLASSES.medium;
        this._idleMs = this._settings.get_uint('presentation-idle-ms');
        this._effects = loadEffects(this._settings, 'presentation');
        this._rings.clicks = this._effects.click[MARK];
        this._rings.dragLine = this._effects.drag[MARK];
        this._rings.drag = anyOn(this._effects, 'drag');
        const accent = resolveAccent(
            this._settings.get_string('presentation-accent'),
            this._settings.get_string('presentation-accent-color'),
            this._interfaceSettings?.get_string('accent-color') ?? '');
        this._rings.color = accent;
        this._look = presentationLook({
            style: this._settings.get_string('presentation-style'),
            custom: {
                panel: this._settings.get_string('presentation-custom-panel'),
                opacity: this._settings.get_uint('presentation-custom-opacity'),
                text: this._settings.get_string('presentation-custom-text'),
                chip: this._settings.get_string('presentation-custom-chip'),
            },
            accent,
        });
    }

    // --- Input -----------------------------------------------------------

    _keyDown(label) {
        if (IGNORED_KEYS.has(label))
            return;
        const mod = MODIFIERS[label];
        if (mod) {
            this._mods.add(mod);
            this._modsAlone = true;
            this._update();
            return;
        }
        this._modsAlone = false;

        const mods = sortedMods(this._mods);
        const command = mods.some(m => COMMAND_MODS.has(m));
        let action;
        if (isTyping(label) && !command) {
            action = this._typing(label);
        } else {
            // Shift and AltGr count with commands and non-typing keys: Shift + Tab
            action = this._add('key', mods, keyName(label));
        }
        this._held.set(label, action);
        this._addTimeout(`hold:${label}`, HOLD_MS, () => {
            if (this._held.get(label) === action) {
                action.held = true;
                this._update();
            }
        });
    }

    _keyUp(label) {
        const mod = MODIFIERS[label];
        if (mod) {
            // A modifier tapped alone, e.g. Super for the overview
            if (this._modsAlone)
                this._add('key', sortedMods(this._mods), null);
            this._modsAlone = false;
            this._mods.delete(mod);
            this._update();
            return;
        }
        this._removeTimeout(`hold:${label}`);
        const action = this._held.get(label);
        this._held.delete(label);
        if (action?.held) {
            action.held = false;
            action.touch();
            this._update();
        }
    }

    _click(button) {
        this._modsAlone = false;
        // AltGr selects characters, it means nothing to a click
        const mods = sortedMods(this._mods).filter(m => m !== 'AltGr');
        const name = BUTTON_NAMES[button];
        if (!name)
            return;
        // No chip with the click's chip off; a drag may still get one
        const action = this._effects.click[CHIP] ? this._add('key', mods, name) : null;
        if (!ClickRings.handles(button) || this._button)
            return;

        // Held: `Click …` after HOLD_MS, `Drag …` once the pointer moves
        const held = {button, action};
        this._button = held;
        this._rings.press(button, () => this._drag(held, mods));
        this._addTimeout('hold:button', HOLD_MS, () => {
            if (this._button === held && held.action) {
                held.action.held = true;
                this._update();
            }
        });
    }

    _drag(held, mods) {
        // Drag chip off: the click's chip stays, held (a long press)
        if (this._button !== held || !this._effects.drag[CHIP])
            return;
        // A chip of its own, like a click's; a press counted into a chip
        // (Click ×2) is taken out of it
        if (!held.action || held.action.count > 1) {
            if (held.action)
                held.action.count--;
            held.action = new Action('key', mods, DRAG_NAMES[held.button]);
            this._push('key', held.action);
        } else {
            held.action.key = DRAG_NAMES[held.button];
            held.action.touch();
        }
        held.action.held = true;
        this._update();
    }

    _release(button) {
        if (this._button?.button !== button)
            return;
        this._rings.release(button);
        this._removeTimeout('hold:button');
        const {action} = this._button;
        this._button = null;
        if (action?.held) {
            action.held = false;
            action.touch();
            this._update();
        }
    }

    /** A touchpad swipe or pinch: a chip like a shortcut (Ctrl + Pinch out). */
    _gesture(name) {
        this._modsAlone = false;
        const mods = sortedMods(this._mods).filter(m => COMMAND_MODS.has(m));
        this._add('key', mods, name);
    }

    _scroll(arrow) {
        this._modsAlone = false;
        const mods = sortedMods(this._mods).filter(m => COMMAND_MODS.has(m));
        this._add('scroll', mods, arrow);
    }

    /** Adds to the typing chip, or starts one. */
    _typing(label) {
        const last = this._latest('key');
        if (last?.kind === 'typing') {
            last.addTyped(label);
            this._update();
            return last;
        }
        const action = new Action('typing');
        action.addTyped(label);
        this._push('key', action);
        return action;
    }

    /** Counts a repeat of the latest chip of its row, or adds a new one. */
    _add(kind, mods, key) {
        const row = kind === 'scroll' ? 'scroll' : 'key';
        const last = this._latest(row);
        if (last?.sameAs(kind, mods, key)) {
            last.count++;
            last.touch();
            this._update();
            return last;
        }
        const action = new Action(kind, mods, key);
        this._push(row, action);
        return action;
    }

    /** The chip a repeat or more typing adds to: only the newest one. */
    _latest(row) {
        return this._target === 'card' ? this._rows[row] : this._chips.at(-1);
    }

    _push(row, action) {
        if (this._target === 'card') {
            this._rows[row] = action;
        } else {
            this._chips.push(action);
            if (this._chips.length > MAX_CHIPS)
                this._chips.shift();
        }
        this._update();
    }

    // --- Display ---------------------------------------------------------

    /** Redraws after input and keeps the ticker running. */
    _update() {
        if (!this._parent)
            return;
        this._lastInput = Date.now();
        if (!this._actor)
            this._createActor();
        this._actor.remove_all_transitions();
        this._actor.opacity = 255;
        this._render();
        if (!this._timeouts.has('tick')) {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => this._tick());
            this._timeouts.set('tick', id);
        }
    }

    /** Ages the chips; fades the whole when nothing is left. */
    _tick() {
        if (!this._actor) {
            // Torn down meanwhile (shell shutdown)
            this._timeouts.delete('tick');
            return GLib.SOURCE_REMOVE;
        }
        if (this._empty()) {
            this._timeouts.delete('tick');
            this._fadeOut(() => this._removeActor());
            return GLib.SOURCE_REMOVE;
        }
        this._render();
        return GLib.SOURCE_CONTINUE;
    }

    _empty() {
        const now = Date.now();
        if (this._target === 'card') {
            for (const name of ['key', 'scroll']) {
                if (this._rows[name]?.age(now, this._idleMs) === 0)
                    this._rows[name] = null;
            }
            return !this._rows.key && !this._rows.scroll && this._mods.size === 0;
        }
        this._chips = this._chips.filter(action => action.age(now, this._idleMs) > 0);
        return this._chips.length === 0 && this._mods.size === 0;
    }

    _render() {
        const now = Date.now();
        if (this._target === 'card')
            this._renderCard(now);
        else
            this._renderLine(now);
        this._place();
    }

    _renderLine(now) {
        this._actor.destroy_all_children();
        for (const action of this._chips) {
            const opacity = action.age(now, this._idleMs);
            if (opacity > 0)
                this._actor.add_child(this._chip(action.display(), action.held, '', opacity));
        }
        // Modifiers held: shown live and dimmed, like the card's first row
        const live = sortedMods(this._mods);
        if (live.length > 0)
            this._actor.add_child(this._chip(live.join(' + '), false, 'rc-pres-live'));
        this._actor.visible = this._actor.get_n_children() > 0;
    }

    _renderCard(now) {
        const key = this._rows.key;
        const scroll = this._rows.scroll;
        const keyOpacity = key?.age(now, this._idleMs) ?? 0;
        const scrollOpacity = scroll?.age(now, this._idleMs) ?? 0;
        // Modifiers row: those held live, else those of the latest key
        const held = sortedMods(this._mods);
        if (held.length > 0)
            this._setRow('mods', held.join(' + '));
        else
            this._setRow('mods', keyOpacity > 0 ? key.modsText() : '', false, keyOpacity);
        this._setRow('key', keyOpacity > 0 ? key.keyText() : '', key?.held, keyOpacity);
        this._setRow('scroll', scrollOpacity > 0 ? scroll.display() : '', false, scrollOpacity);
        this._actor.visible = Object.values(this._cardRows).some(r => r.visible);
    }

    _setRow(name, text, held = false, opacity = 255) {
        const row = this._cardRows[name];
        row.destroy_all_children();
        row.visible = text !== '';
        if (text)
            row.add_child(this._chip(text, held, '', opacity));
    }

    _chip(text, held, extraClass = '', opacity = 255) {
        // Inline styles in order, later ones win: custom chip, then live
        // (dimmed text) or held (accent)
        const look = this._look;
        return new St.Label({
            text,
            opacity,
            style_class: ['rc-pres-chip', held ? 'rc-pres-held' : '', extraClass].filter(Boolean).join(' '),
            style: [look.chip, extraClass === 'rc-pres-live' ? look.live : '', held ? look.held : ''].join(' ').trim() || null,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    _createActor() {
        const card = this._target === 'card';
        this._actor = new St.BoxLayout({
            style_class: `${card ? 'rc-pres-card' : 'rc-pres-line'} ${this._sizeClass} ${this._look.styleClass}`,
            style: this._look.panel || null,
            orientation: card ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
            reactive: false,
            can_focus: false,
        });
        if (card) {
            this._cardRows = {};
            for (const name of ['mods', 'key', 'scroll']) {
                const row = new St.BoxLayout({style_class: 'rc-pres-row', visible: false});
                this._cardRows[name] = row;
                this._actor.add_child(row);
            }
        }
        this._parent.add_child(this._actor);
    }

    _removeActor() {
        this._removeTimeout('tick');
        this._minWidth = 0;
        if (this._actor)
            this._destroyAfterFrame(this._actor);
        this._actor = null;
        this._cardRows = null;
        this._chips = [];
        this._rows = {mods: null, key: null, scroll: null};
    }

    /**
     * Hides the actor at once and destroys it after the next stage update:
     * a relayout it queued in this frame (the ticker redraws every
     * TICK_MS) would otherwise run on the destroyed actor, off the stage
     * ("st_widget_get_theme_node … not in the stage", "Spurious
     * clutter_actor_allocate"), e.g. when a setting changes while it shows.
     */
    _destroyAfterFrame(actor) {
        actor.remove_all_transitions();
        actor.visible = false;
        const pending = {actor, updateId: 0, idleId: 0, timeoutId: 0};
        this._dying.add(pending);
        pending.updateId = global.stage.connect('after-update', () => {
            global.stage.disconnect(pending.updateId);
            pending.updateId = 0;
            // Not inside the stage's update
            pending.idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                pending.idleId = 0;
                this._finishDying(pending);
                return GLib.SOURCE_REMOVE;
            });
        });
        // In case no frame comes (nothing else to draw)
        pending.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            pending.timeoutId = 0;
            this._finishDying(pending);
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Destroys an actor from _destroyAfterFrame() now, once.
     *
     * @param {object} pending - from _destroyAfterFrame()
     * @param {boolean} [destroy] - false when it is gone already
     */
    _finishDying(pending, destroy = true) {
        if (!this._dying.delete(pending))
            return;
        if (pending.updateId)
            global.stage.disconnect(pending.updateId);
        if (pending.idleId)
            GLib.source_remove(pending.idleId);
        if (pending.timeoutId)
            GLib.source_remove(pending.timeoutId);
        if (destroy)
            pending.actor.destroy();
    }

    /** Places the actor in the work area (no panel, no dock) of the monitor. */
    _place() {
        // Off the stage St cannot size it
        if (!this._actor.get_stage())
            return;
        const layout = Main.layoutManager;
        const index = this._monitorChoice === 'pointer'
            ? global.display.get_current_monitor()
            : layout.primaryIndex;
        if (index < 0 || !layout.monitors[index])
            return;
        const area = layout.getWorkAreaForMonitor(index);
        const margin = MARGIN_PX * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // Natural size first: a width set before must not count
        this._actor.set_width(-1);
        let [, width] = this._actor.get_preferred_width(-1);
        if (Date.now() - this._lastInput < SHRINK_PAUSE_MS)
            width = Math.max(width, this._minWidth);
        this._minWidth = width;
        this._actor.set_width(width);
        const [, height] = this._actor.get_preferred_height(width);

        let x = area.x + (area.width - width) / 2;
        let y = area.y + area.height - height - margin;
        if (this._target === 'heading') {
            y = area.y + margin;
        } else if (this._target === 'card') {
            x = this._corner.endsWith('left') ? area.x + margin : area.x + area.width - width - margin;
            y = this._corner.startsWith('top') ? area.y + margin : area.y + area.height - height - margin;
        }
        this._actor.set_position(Math.round(x), Math.round(y));
    }

    _fadeOut(done) {
        if (!this._actor)
            return;
        if (!this.animate || !St.Settings.get().enable_animations) {
            done();
            return;
        }
        this._actor.ease({
            opacity: 0,
            duration: FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: done,
        });
    }

    // --- Timeouts --------------------------------------------------------

    _addTimeout(name, ms, callback) {
        this._removeTimeout(name);
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(name);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.set(name, id);
    }

    _removeTimeout(name) {
        const id = this._timeouts.get(name);
        if (id) {
            GLib.source_remove(id);
            this._timeouts.delete(name);
        }
    }
}
