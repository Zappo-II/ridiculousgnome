// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

/*
 * RidiculousGnome@Zappo-II.github.io
 *
 * Wires InputSource -> Filter -> Renderer (ridiculous mode: sprites and
 * labels where the input happens) or PresentationRenderer (effect-mode). The input sources
 * (EvdevInputSource, ShellInputSource for the limited mode) share this shape:
 *
 * InputSource {
 *   start(onEvent, onStatus?): void   // begin emitting events to onEvent;
 *                                     // onStatus(status, detail?) if the
 *                                     // source can be unavailable
 *   stop(): void                      // stop, release any listeners
 *   setDetail?(detail): void          // key detail for the focused window,
 *                                     // if the source can cut labels itself
 * }
 *
 * Event {
 *   kind: 'key-down' | 'key-up'
 *        | 'mouse-button-down' | 'mouse-button-up'
 *        | 'mouse-motion' | 'mouse-wheel'
 *        | 'touch-down' | 'touch-up'
 *   ts:        number                     // ms timestamp
 *   key?:      string                     // key-down, key-up: character, keysym name or class
 *   button?:   number                     // mouse-button-down, mouse-button-up
 *   wheelDir?: 'up' | 'down' | 'left' | 'right'
 *   pos?:      { x: number, y: number }   // mouse-motion (stage coordinates)
 *   fingers?:  number                     // touch-down, touch-up (touchpad contacts)
 * }
 *
 * Console-Debug:
 *   `journalctl --user -f -o cat /usr/bin/gnome-shell | grep RidiculousGnome`
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {EvdevInputSource} from './evdevInputSource.js';
import {Filter} from './filter.js';
import {FocusTracker} from './focusTracker.js';
import {HelperNotice} from './helperNotice.js';
import {PanelIndicator} from './panelIndicator.js';
import {PresentationRenderer} from './presentation.js';
import {Renderer} from './renderer.js';
import {ShellInputSource} from './shellInputSource.js';

const LOG_PREFIX = '[RidiculousGnome]';
const INDICATOR_ROLE = 'ridiculous-gnome';

export default class RidiculousGnomeExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        this._focus = new FocusTracker();
        this._focus.start(() => this._updateDetail());
        this._detail = null;

        this._indicator = null;
        this._createRenderer();
        this._showIndicator(this._settings.get_boolean('panel-indicator'));
        // "Reduce Animation" in GNOME Settings (50, 51) only sets this key;
        // enable-animations stays true and the shell keeps animating
        this._a11ySettings = new Gio.Settings({schema_id: 'org.gnome.desktop.a11y.interface'});
        this._reducedMotionChangedId = this._a11ySettings.connect('changed::reduced-motion', () => {
            this._updateAnimate();
            this._updateAnimationStatus();
        });
        this._updateAnimate();
        this._filter = new Filter(this._settings);
        this._notice = new HelperNotice(this._settings, () => this.openPreferences());
        this._limitedSource = null;

        this._startBackend();

        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => {
            if (key === 'animate-labels') {
                this._updateAnimate();
            } else if (key === 'effect-mode') {
                this._renderer.destroy();
                this._createRenderer();
                this._updateAnimate();
                this._filter.reload();
            } else if (key === 'show-effects') {
                // Nothing held over the pause
                this._filter.reset();
                this._renderer.reset?.();
            } else if (key === 'panel-indicator') {
                this._showIndicator(this._settings.get_boolean('panel-indicator'));
            } else if (key === 'window-classes-request') {
                this._publishWindowClasses();
            } else if (key === 'effect-preview-request') {
                this._preview();
            } else if (!['animation-status', 'helper-status', 'open-window-classes', 'helper-notices-shown',
                'ridiculous-xp-state'].includes(key)) {
                this._filter.reload();
                this._updateDetail();
            }
        });

        // Publish whether the shell allows animations, for the prefs window
        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._animationsChangedId = St.Settings.get().connect('notify::enable-animations',
            () => this._updateAnimationStatus());
        this._updateAnimationStatus();
    }

    disable() {
        this._stopBackend();
        this._notice.hide();
        this._notice = null;

        St.Settings.get().disconnect(this._animationsChangedId);
        this._animationsChangedId = 0;
        this._interfaceSettings = null;
        this._a11ySettings.disconnect(this._reducedMotionChangedId);
        this._reducedMotionChangedId = 0;
        this._a11ySettings = null;

        this._settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = 0;
        this._setAnimationStatus('unknown');
        this._setHelperStatus('unknown');

        this._focus.stop();
        this._focus = null;

        this._showIndicator(false);
        this._renderer.destroy();
        this._renderer = null;

        this._filter = null;
        this._settings = null;
    }

    _startBackend() {
        // Limited mode until the helper is subscribed
        this._setLimitedMode(true);
        this._setHelperStatus('connecting');
        const source = new EvdevInputSource();
        try {
            source.start(event => this._onEvent(event),
                (status, detail) => this._onBackendStatus(status, detail));
        } catch (e) {
            console.error(`${LOG_PREFIX} evdev helper source failed to start: ${e.message}`);
            this._setHelperStatus('failed', e.message);
            return;
        }
        this._source = source;
        this._updateDetail();
    }

    /** Asks the helper for the focused window's key detail. */
    _updateDetail() {
        if (!this._focus)
            return;
        const detail = this._filter.detailFor(this._focus.getCurrent());
        // No keys reach us while it is `off`, nor the releases of keys
        // held when it changes: forget them, or a modifier stays down.
        // Not on every focus change: Alt+Tab keeps its Alt.
        if ((detail === 'off') !== (this._detail === 'off')) {
            this._filter.reset();
            this._renderer.releaseKeys?.();
        }
        this._detail = detail;
        this._source?.setDetail?.(detail);
    }

    /**
     * WM classes of the open windows with app name and icon, for the
     * prefs' "Show active window classes" (prefs cannot see windows).
     */
    _publishWindowClasses() {
        const tracker = Shell.WindowTracker.get_default();
        const classes = new Map();
        for (const window of global.display.list_all_windows()) {
            const wmClass = window.get_wm_class();
            if (!wmClass || window.skip_taskbar || classes.has(wmClass))
                continue;
            const app = tracker.get_window_app(window);
            classes.set(wmClass, [wmClass, app?.get_name() ?? window.get_title() ?? '',
                app?.get_icon()?.to_string() ?? '']);
        }
        this._settings.set_value('open-window-classes',
            new GLib.Variant('a(sss)', [...classes.values()]));
    }

    _onBackendStatus(status, detail) {
        // Releases of keys held during the switch may never arrive
        this._filter.reset();
        this._renderer.reset?.();
        this._setHelperStatus(status === 'vanished' ? 'connecting' : status, detail);
        this._setLimitedMode(status !== 'subscribed');
        if (status === 'subscribed')
            this._notice.resolved();
        else if (status !== 'vanished')
            this._notice.show(status, detail);
    }

    /**
     * Shell-only input while the helper is missing, not working or gone,
     * so effects show at least for the shell's own UI. Never runs together
     * with the helper, so no event is shown twice.
     */
    _setLimitedMode(on) {
        if (on === Boolean(this._limitedSource))
            return;
        if (on) {
            this._limitedSource = new ShellInputSource();
            this._limitedSource.start(event => this._onEvent(event));
        } else {
            this._limitedSource.stop();
            this._limitedSource = null;
        }
    }

    /** Effects where the input happens, or the presentation line. */
    _createRenderer() {
        this._renderer = this._settings.get_string('effect-mode') === 'presentation'
            ? new PresentationRenderer(this._settings)
            : new Renderer(this._settings, this.path);
        // Mode and pause follow their settings in the indicator itself
        this._renderer.onXpChanged = () => this._indicator?.updateXp();
        this._indicator?.setXp(this._renderer.xp ?? null);
    }

    /**
     * A preview asked for by prefs ("Preview"): the trigger's effect as if
     * it happened, also where a window rule turns effects off; only for
     * the current mode's tab, nothing during a pause.
     */
    _preview() {
        const [mode, trigger] = this._settings.get_string('effect-preview-request').split(/[:#]/);
        if (trigger && mode === this._settings.get_string('effect-mode') &&
            this._settings.get_boolean('show-effects'))
            this._renderer.preview?.(trigger);
    }

    /** The top bar button, in both modes. */
    _showIndicator(show) {
        if (show === Boolean(this._indicator))
            return;
        if (show) {
            this._indicator = new PanelIndicator(this._settings, this.path, () => this.openPreferences());
            this._indicator.setXp(this._renderer.xp ?? null);
            Main.panel.addToStatusArea(INDICATOR_ROLE, this._indicator);
        } else {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    _reducedMotion() {
        return this._a11ySettings.get_string('reduced-motion') === 'reduce';
    }

    _updateAnimate() {
        this._renderer.animate = this._settings.get_boolean('animate-labels') && !this._reducedMotion();
    }

    _updateAnimationStatus() {
        // St's enable-animations is the GSettings value minus any inhibit
        // by the shell (software rendering, remote sessions)
        let status = 'available';
        if (!St.Settings.get().enable_animations)
            status = this._interfaceSettings.get_boolean('enable-animations') ? 'inhibited' : 'reduced';
        else if (this._reducedMotion())
            status = 'reduced';
        this._setAnimationStatus(status);
    }

    _setAnimationStatus(status) {
        if (this._settings.get_string('animation-status') !== status)
            this._settings.set_string('animation-status', status);
    }

    /**
     * Publishes how the helper is doing, for the prefs window, which then
     * does not have to start the helper to find out.
     */
    _setHelperStatus(status, detail = '') {
        const [current, currentDetail] = this._settings.get_value('helper-status').deep_unpack();
        if (current !== status || currentDetail !== detail)
            this._settings.set_value('helper-status', new GLib.Variant('(ss)', [status, detail]));
    }

    _stopBackend() {
        this._setLimitedMode(false);
        this._source?.stop();
        this._source = null;
        this._notice?.hide();
    }

    _onEvent(event) {
        // Paused: nothing shown, played or counted
        if (!this._settings.get_boolean('show-effects'))
            return;
        const shown = this._filter.apply(event, this._focus.getCurrent());
        if (shown)
            this._renderer.fire(shown);
    }
}
