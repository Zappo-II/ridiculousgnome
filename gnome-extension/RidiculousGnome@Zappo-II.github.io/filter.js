// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

/*
 * Event-type filter and per-window key detail.
 *
 * Settings are cached here and refreshed via reload(), so apply() does no
 * GSettings or Meta lookups per event.
 *
 * Window rules map a WM class to a detail level, `mouse` or `global`; windows
 * without a rule, or with `global`, get the global key-detail. `off` drops
 * all events while that window has the focus, `mouse` only keys (clicks,
 * drags and the wheel still show), in both modes; the other levels only
 * change key labels. The extension also asks rg-helper for the same level
 * (detailFor, `off` for `mouse` too), so keys of an `off` or `mouse`
 * window never leave the helper; cutting the labels here as well covers the
 * moment between a focus change and the helper's answer, and sources that
 * see full labels (limited mode).
 */

import {anyOn, loadEffects} from './effects.js';
import {COMMAND_KEYS, DETAILS, MODIFIERS, labelForDetail, sortedMods} from './keyLabels.js';

/**
 * Presentation mode: the event kinds its triggers need (effects.js).
 * Releases follow the press (modifiers, held keys, drags).
 *
 * @param {Object<string, boolean[]>} effects - from loadEffects(…, 'presentation')
 * @returns {Set<string>}
 */
function presentationKinds(effects) {
    const kinds = new Set();
    const on = id => anyOn(effects, id);
    if (on('keys'))
        kinds.add('key-down').add('key-up');
    // A drag starts with a press, also with the click's switches off
    if (on('click') || on('drag'))
        kinds.add('mouse-button-down').add('mouse-button-up');
    if (on('scroll'))
        kinds.add('mouse-wheel');
    if (on('gesture'))
        kinds.add('touch-swipe').add('touch-pinch');
    return kinds;
}

/**
 * Ridiculous mode: the event kinds its triggers need (effects.js). Keys
 * always, for XP; key-ups are not shown.
 *
 * @param {Object<string, boolean[]>} effects - from loadEffects()
 * @returns {Set<string>}
 */
function ridiculousKinds(effects) {
    const kinds = new Set(['key-down']);
    const on = id => anyOn(effects, id);
    // Motion: buttons too, for "not while a button is held"
    if (on('click') || on('drag') || on('motion'))
        kinds.add('mouse-button-down').add('mouse-button-up');
    // Motion also for the window a drag enters (shake)
    if (on('motion') || on('drag'))
        kinds.add('mouse-motion');
    if (on('scroll'))
        kinds.add('mouse-wheel');
    if (on('swipe'))
        kinds.add('touch-swipe');
    if (on('pinch'))
        kinds.add('touch-pinch');
    if (on('touch'))
        kinds.add('touch-down').add('touch-up');
    return kinds;
}

export class Filter {
    constructor(settings) {
        this._settings = settings;
        // Ctrl, Alt, Super held, for the shortcuts level
        this._commandKeys = new Set();
        // All modifiers held, as display names, for ridiculous mode's
        // shortcuts (it gets no key-ups)
        this._mods = new Set();
        // Mouse buttons held, so a touchpad tap cannot end a real press
        this._buttons = new Set();
        this.reload();
    }

    reload() {
        this._enabledKinds = this._settings.get_string('effect-mode') === 'presentation'
            ? presentationKinds(loadEffects(this._settings, 'presentation'))
            : ridiculousKinds(loadEffects(this._settings));
        this._detail = this._settings.get_string('key-detail');
        this._rules = this._settings.get_value('window-rules').deep_unpack();
    }

    /** Forgets modifiers held, e.g. when the input source changes. */
    reset() {
        this._commandKeys.clear();
        this._mods.clear();
        this._buttons.clear();
    }

    /**
     * @param {{wmClass: string|null}} focusContext - from FocusTracker.getCurrent()
     * @returns {string} detail level for the focused window (keyLabels.js DETAILS)
     */
    detailFor(focusContext) {
        const rule = this._ruleFor(focusContext);
        return rule === 'mouse' ? 'off' : rule;
    }

    /**
     * @returns {string} the focused window's rule: a detail level, or
     *   `mouse`; the global level for windows without a rule
     */
    _ruleFor(focusContext) {
        const rule = this._rules[focusContext.wmClass];
        return rule && rule !== 'global' ? rule : this._detail;
    }

    /**
     * @param {object} event - InputSource event
     * @param {{wmClass: string|null}} focusContext - from FocusTracker.getCurrent()
     * @returns {object|null} the event to show (key cut down), or null
     */
    apply(event, focusContext) {
        // Before anything is dropped: modifier state must follow every key
        if (COMMAND_KEYS.has(event.key)) {
            if (event.kind === 'key-down')
                this._commandKeys.add(event.key);
            else if (event.kind === 'key-up')
                this._commandKeys.delete(event.key);
        }
        // A tap comes as down and up at once; with its button already held
        // (mouse) the down would be ignored and the up end the real press
        if (event.kind === 'mouse-button-down' || event.kind === 'mouse-button-up') {
            if (event.tap) {
                if (this._buttons.has(event.button))
                    return null;
            } else if (event.kind === 'mouse-button-down') {
                this._buttons.add(event.button);
            } else {
                this._buttons.delete(event.button);
            }
        }
        if (event.key in MODIFIERS) {
            if (event.kind === 'key-down')
                this._mods.add(MODIFIERS[event.key]);
            else if (event.kind === 'key-up')
                this._mods.delete(MODIFIERS[event.key]);
        }
        if (!this._enabledKinds.has(event.kind))
            return null;
        const rule = this._ruleFor(focusContext);
        if (rule === 'off')
            return null;
        if (event.key === undefined)
            return event;
        if (rule === 'mouse')
            return null;
        const command = this._commandKeys.size > 0;
        const key = labelForDetail(rule, event.key, command);
        // The source's level (the helper's grant) when lower than the rule
        const detail = DETAILS.indexOf(event.detail) >= 0 && DETAILS.indexOf(event.detail) < DETAILS.indexOf(rule)
            ? event.detail : rule;
        // command: Ctrl, Alt or Super held; mods: all modifiers held;
        // detail: the level the key was cut down to
        return key ? {...event, key, command, mods: sortedMods(this._mods), detail} : null;
    }
}
