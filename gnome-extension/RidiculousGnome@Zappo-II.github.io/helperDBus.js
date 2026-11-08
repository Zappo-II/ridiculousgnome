// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

/*
 * rg-helper on the system bus: its name and the check whether it runs,
 * is missing, or is installed but does not start. Shared by the extension
 * and prefs, so no shell-only imports here.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const HELPER_NAME = 'io.github.zappoii.RidiculousGnome.Helper';
export const HELPER_PATH = '/io/github/zappoii/RidiculousGnome/Helper';

/**
 * Reads a property of the running helper (e.g. Version, MaxDetail). Never
 * starts it: fails if it does not run.
 *
 * @param {Gio.DBusConnection} bus - the system bus
 * @param {string} name - property name
 * @param {Gio.Cancellable} [cancellable]
 * @returns {Promise<*>} the unpacked value
 */
export function getHelperProperty(bus, name, cancellable = null) {
    return new Promise((resolve, reject) => {
        bus.call(HELPER_NAME, HELPER_PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [HELPER_NAME, name]), null,
            Gio.DBusCallFlags.NO_AUTO_START, -1, cancellable, (conn, res) => {
                try {
                    resolve(conn.call_finish(res).deep_unpack()[0].deep_unpack());
                } catch (e) {
                    reject(e);
                }
            });
    });
}

/**
 * Starts the helper by D-Bus activation if it is not running yet.
 *
 * The error of a failed start does not tell "not installed" from "fails to
 * start": dbus-broker answers both with ServiceUnknown (e.g. "activation
 * request failed: unit is masked"), and also a helper that runs without an
 * activation file (started by hand, helper/dev-run.sh). So after a failed
 * start: owned → running; activatable → failed; otherwise missing.
 *
 * @param {Gio.DBusConnection} bus - the system bus
 * @param {Gio.Cancellable} [cancellable]
 * @returns {Promise<['running' | 'missing' | 'failed', string]>} state and,
 *   for 'failed', why
 */
export async function startHelper(bus, cancellable = null) {
    let startError;
    try {
        await callBus(bus, 'StartServiceByName', new GLib.Variant('(su)', [HELPER_NAME, 0]), cancellable);
        return ['running', ''];
    } catch (e) {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            throw e;
        startError = e;
    }
    if (await callBus(bus, 'NameHasOwner', new GLib.Variant('(s)', [HELPER_NAME]), cancellable))
        return ['running', ''];
    if (await isHelperActivatable(bus, cancellable))
        return ['failed', remoteMessage(startError)];
    return ['missing', ''];
}

/**
 * Whether the helper runs or is installed, without starting it.
 *
 * @param {Gio.DBusConnection} bus - the system bus
 * @param {Gio.Cancellable} [cancellable]
 * @returns {Promise<'running' | 'installed' | 'missing'>}
 */
export async function peekHelper(bus, cancellable = null) {
    if (await callBus(bus, 'NameHasOwner', new GLib.Variant('(s)', [HELPER_NAME]), cancellable))
        return 'running';
    return await isHelperActivatable(bus, cancellable) ? 'installed' : 'missing';
}

/**
 * Whether the helper is installed (has a D-Bus activation file), without
 * starting it.
 *
 * @param {Gio.DBusConnection} bus - the system bus
 * @param {Gio.Cancellable} [cancellable]
 * @returns {Promise<boolean>}
 */
export async function isHelperActivatable(bus, cancellable = null) {
    return (await callBus(bus, 'ListActivatableNames', null, cancellable)).includes(HELPER_NAME);
}

function callBus(bus, method, params, cancellable) {
    return new Promise((resolve, reject) => {
        bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            method, params, null, Gio.DBusCallFlags.NONE, -1, cancellable, (conn, res) => {
                try {
                    resolve(conn.call_finish(res).deep_unpack()[0]);
                } catch (e) {
                    reject(e);
                }
            });
    });
}

/**
 * The text of a D-Bus error without GDBus' "GDBus.Error:<name>: " prefix,
 * and for a failed activation only its reason (e.g. "unit is masked").
 *
 * @param {GLib.Error} error - error from a D-Bus call
 * @returns {string}
 */
export function remoteMessage(error) {
    const message = error.message.replace(/^GDBus\.Error:\S+:\s*/, '');
    return message.match(/activation request failed: (.*)$/)?.[1] ?? message;
}
