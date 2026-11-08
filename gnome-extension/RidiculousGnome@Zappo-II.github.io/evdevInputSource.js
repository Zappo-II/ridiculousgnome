// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

/*
 * InputSource backed by rg-helper, the separately installed evdev helper
 * on the system bus.
 *
 * The helper only sends signals to subscribers, and only accepts the user
 * of the active session as one. This source subscribes whenever the
 * helper's name appears, keeps the helper's keyboard layout in sync with
 * the shell's current input source, and unsubscribes on stop() — which
 * also happens on screen lock, since the extension is disabled then.
 *
 * Without the helper on the bus it stays idle. It reports why through
 * onStatus, so the extension can tell the user and run the limited mode
 * (ShellInputSource) meanwhile: 'missing' (not installed), 'failed'
 * (installed but not starting, or refusing us), 'vanished' (left the bus,
 * e.g. stopped or restarting), 'subscribed'. A helper that vanished and is
 * not back after VANISH_GRACE_SECONDS turns into 'missing' (package
 * removed) or gets one start attempt ('failed' if that does not work).
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Keyboard from 'resource:///org/gnome/shell/ui/status/keyboard.js';

import {
    HELPER_NAME, HELPER_PATH, getHelperProperty, isHelperActivatable, remoteMessage, startHelper,
} from './helperDBus.js';
import {pointer} from './placement.js';
import {TouchpadMapper} from './touchpadMapper.js';

const LOG_PREFIX = '[RidiculousGnome]';

const HELPER_IFACE = HELPER_NAME;

// D-Bus contract version this source speaks (helper's Version property)
const CONTRACT_VERSION = 4;

// How long a helper that left the bus may take to come back (restart,
// package upgrade) before it counts as stopped or removed. Long enough
// that the check never runs while a package removal still has the
// activation file in place (about 1 s between stop and D-Bus reload).
const VANISH_GRACE_SECONDS = 10;

export class EvdevInputSource {
    constructor() {
        this._watchId = 0;
        this._signalId = 0;
        this._graceId = 0;
        this._subscribed = false;
        this._detail = 'off';
        // What the helper granted (at most its ceiling), for Key events
        this._grantedDetail = null;
        // Set while the helper speaks another contract version
        this._versionProblem = null;
    }

    /**
     * Key detail level to ask the helper for; it answers with at most its
     * ceiling (max-detail in /etc/rg-helper.conf). Follows the focused
     * window's rule, so keys for an `off` window never leave the helper.
     *
     * @param {string} detail - one of keyLabels.js DETAILS
     */
    setDetail(detail) {
        if (detail === this._detail)
            return;
        this._detail = detail;
        this._sendDetail();
    }

    start(onEvent, onStatus) {
        this.stop();
        this._onEvent = onEvent;
        this._onStatus = onStatus;
        this._bus = Gio.DBus.system;
        this._cancellable = new Gio.Cancellable();

        // Touchpad facts become clicks and scrolling as GNOME is set up
        this._touchpadMapper = new TouchpadMapper({
            touchpad: settingsIfInstalled('org.gnome.desktop.peripherals.touchpad'),
            mouse: settingsIfInstalled('org.gnome.desktop.peripherals.mouse'),
        });

        this._signalId = this._bus.signal_subscribe(HELPER_NAME, HELPER_IFACE, null,
            HELPER_PATH, null, Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, signal, params) => this._onSignal(signal, params));

        this._sourceManager = Keyboard.getInputSourceManager();
        this._sourceChangedId = this._sourceManager.connect('current-source-changed',
            () => this._sendLayout());
        this._inputSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.input-sources'});
        this._optionsChangedId = this._inputSettings.connect('changed::xkb-options',
            () => this._sendLayout());

        this._watchId = Gio.bus_watch_name_on_connection(this._bus, HELPER_NAME,
            Gio.BusNameWatcherFlags.NONE,
            () => this._subscribe(),
            () => {
                const wasSubscribed = this._subscribed;
                this._subscribed = false;
                // A helper of the wrong version exits when nobody subscribes;
                // the problem stays until a matching one appears, and it is
                // not started again (it would only exit again)
                if (this._versionProblem)
                    return;
                this._onStatus?.('vanished');
                // At start an absent helper is _activate()'s business
                if (wasSubscribed)
                    this._checkVanished();
            });
        this._activate();
    }

    /** Starts the installed helper, or reports why it is not there. */
    async _activate() {
        let state, detail;
        try {
            [state, detail] = await startHelper(this._bus, this._cancellable);
        } catch {
            return; // stopped meanwhile, or the bus is gone
        }
        if (state === 'missing') {
            this._onStatus?.('missing');
        } else if (state === 'failed') {
            console.error(`${LOG_PREFIX} evdev helper failed to start: ${detail}`);
            this._onStatus?.('failed', detail);
        }
    }

    /** After VANISH_GRACE_SECONDS: removed → 'missing', stopped → start it. */
    _checkVanished() {
        if (this._graceId)
            GLib.source_remove(this._graceId);
        this._graceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, VANISH_GRACE_SECONDS, () => {
            this._graceId = 0;
            if (!this._subscribed)
                this._recheck();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _recheck() {
        let activatable;
        try {
            activatable = await isHelperActivatable(this._bus, this._cancellable);
        } catch {
            return; // stopped meanwhile, or the bus is gone
        }
        if (this._subscribed)
            return;
        if (activatable)
            this._activate();
        else
            this._onStatus?.('missing');
    }

    stop() {
        if (this._graceId) {
            GLib.source_remove(this._graceId);
            this._graceId = 0;
        }
        if (this._watchId) {
            Gio.bus_unwatch_name(this._watchId);
            this._watchId = 0;
        }
        if (this._signalId) {
            this._bus.signal_unsubscribe(this._signalId);
            this._signalId = 0;
        }
        if (this._sourceManager) {
            this._sourceManager.disconnect(this._sourceChangedId);
            this._sourceManager = null;
        }
        if (this._inputSettings) {
            this._inputSettings.disconnect(this._optionsChangedId);
            this._inputSettings = null;
        }
        this._cancellable?.cancel();
        this._cancellable = null;

        // Fire and forget; the helper also drops us when we leave the bus
        if (this._subscribed)
            this._bus.call(HELPER_NAME, HELPER_PATH, HELPER_IFACE, 'Unsubscribe', null, null,
                Gio.DBusCallFlags.NONE, -1, null, null);
        this._subscribed = false;
        this._versionProblem = null;
        this._onEvent = null;
        this._onStatus = null;
        this._touchpadMapper = null;
    }

    async _subscribe() {
        let version;
        try {
            version = await getHelperProperty(this._bus, 'Version', this._cancellable);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                this._onStatus?.('failed', remoteMessage(e));
            return;
        }
        if (version !== CONTRACT_VERSION) {
            console.error(`${LOG_PREFIX} evdev helper speaks version ${version}, need ${CONTRACT_VERSION}`);
            this._versionProblem = version < CONTRACT_VERSION
                ? _('version %d is too old for this extension, update rg-helper').replace('%d', version)
                : _('version %d is too new for this extension, update the extension').replace('%d', version);
            this._onStatus?.('failed', this._versionProblem);
            return;
        }
        this._versionProblem = null;
        this._call('Subscribe', null, () => {
            this._subscribed = true;
            // A (re)started helper begins with its default layout and sends
            // no keys until it knows the detail level
            this._sentLayout = null;
            this._grantedDetail = null;
            this._onStatus?.('subscribed');
            this._sendLayout();
            this._sendDetail();
        }, e => this._onStatus?.('failed', remoteMessage(e)));
    }

    _sendDetail() {
        if (!this._subscribed)
            return;
        this._call('SetDetail', new GLib.Variant('(s)', [this._detail]),
            granted => (this._grantedDetail = granted));
    }

    _sendLayout() {
        const source = this._sourceManager?.currentSource;
        if (!this._subscribed || !source)
            return;

        // xkbId is "layout" or "layout+variant", also for IBus sources
        const [layout, variant = ''] = source.xkbId.split('+');
        const options = this._inputSettings.get_strv('xkb-options').join(',');
        // The shell emits current-source-changed several times at startup
        const key = `${layout}|${variant}|${options}`;
        if (key === this._sentLayout)
            return;
        this._sentLayout = key;
        this._call('SetKeyboardLayout', new GLib.Variant('(sss)', [layout, variant, options]));
    }

    _call(method, params, onSuccess, onError) {
        this._bus.call(HELPER_NAME, HELPER_PATH, HELPER_IFACE, method, params, null,
            Gio.DBusCallFlags.NONE, -1, this._cancellable, (conn, res) => {
                let reply;
                try {
                    reply = conn.call_finish(res);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        console.error(`${LOG_PREFIX} evdev helper ${method} failed: ${e.message}`);
                        onError?.(e);
                    }
                    return;
                }
                onSuccess?.(reply.deep_unpack()[0]);
            });
    }

    _onSignal(signal, params) {
        const args = params.deep_unpack();
        const events = this._touchpadMapper?.map(signal, args) ?? [eventFor(signal, args)];
        for (const event of events) {
            if (!event)
                continue;
            // The level the key was cut down to, below the window's rule
            // when the helper's ceiling is lower
            const detail = event.key !== undefined && this._grantedDetail ? {detail: this._grantedDetail} : {};
            this._onEvent?.({...event, ...detail, ts: Date.now()});
        }
    }
}

/** @returns {Gio.Settings|null} settings of the schema, null if not installed */
function settingsIfInstalled(schemaId) {
    const schema = Gio.SettingsSchemaSource.get_default()?.lookup(schemaId, true);
    return schema ? new Gio.Settings({schema_id: schemaId}) : null;
}

/**
 * Helper signal -> InputSource event (without ts); touchpad gestures go
 * through TouchpadMapper.
 *
 * @param {string} signal - signal name
 * @param {Array} args - unpacked signal arguments
 * @returns {object|null}
 */
function eventFor(signal, args) {
    switch (signal) {
    case 'Key': {
        const [pressed, label] = args;
        return {kind: pressed ? 'key-down' : 'key-up', key: label};
    }
    case 'Button': {
        const [pressed, button] = args;
        return {kind: pressed ? 'mouse-button-down' : 'mouse-button-up', button};
    }
    case 'Wheel':
        return {kind: 'mouse-wheel', wheelDir: args[0]};
    case 'Motion': {
        // The helper only says "moved"; the shell knows where the pointer is
        const [x, y] = pointer();
        return {kind: 'mouse-motion', pos: {x, y}};
    }
    case 'Touch': {
        const [touching, fingers] = args;
        return {kind: touching ? 'touch-down' : 'touch-up', fingers};
    }
    default:
        return null;
    }
}
