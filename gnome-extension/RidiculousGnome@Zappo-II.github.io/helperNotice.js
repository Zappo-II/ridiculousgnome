// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

/*
 * Tells the user why effects only show in limited mode (shell UI only)
 * when the evdev helper is missing or not working: a normal shell
 * notification (banner, then in the message list), never anything drawn
 * over the screen.
 *
 * A click on the notice, like its "Settings" button, opens the prefs —
 * whose General page shows the problem first — and closes the message list
 * so the prefs window is not hidden behind it. GNOME only shows the action
 * buttons in an expanded banner.
 *
 * Each kind is shown at most once per shell session. The extension is
 * disabled on every screen lock and enabled again on unlock, so the kinds
 * already shown are kept in GSettings (helper-notices-shown) together with
 * the session they belong to, and the notice does not return after every
 * unlock. Once the helper works again (resolved()), a new problem is news
 * and shows again, e.g. the package removed while the session runs.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

/** @returns {string} boot id and shell pid: new for every shell process */
function sessionId() {
    let bootId = '';
    try {
        bootId = new TextDecoder().decode(
            GLib.file_get_contents('/proc/sys/kernel/random/boot_id')[1]).trim();
    } catch {
        // no /proc: the pid alone still tells shell processes apart
    }
    return `${bootId}/${new Gio.Credentials().get_unix_pid()}`;
}

export class HelperNotice {
    /**
     * @param {Gio.Settings} settings - extension settings (warn-helper-missing)
     * @param {Function} openPreferences - opens the extension's prefs window
     */
    constructor(settings, openPreferences) {
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._source = null;
    }

    /** @returns {Set<string>} kinds already shown in this shell session */
    _shown() {
        const [session, kinds] = this._settings.get_value('helper-notices-shown').deep_unpack();
        return new Set(session === sessionId() ? kinds : []);
    }

    _setShown(kinds) {
        this._settings.set_value('helper-notices-shown',
            new GLib.Variant('(sas)', [sessionId(), [...kinds]]));
    }

    /**
     * @param {'missing' | 'failed'} kind - helper not installed, or
     *   installed but not starting / refusing
     * @param {string} [detail] - error message, for 'failed'
     */
    show(kind, detail = '') {
        const shown = this._shown();
        if (shown.has(kind))
            return;
        if (kind === 'missing' && !this._settings.get_boolean('warn-helper-missing'))
            return;
        this._setShown(shown.add(kind));

        this.hide();
        const source = new MessageTray.Source({
            title: 'Ridiculous Gnome',
            iconName: 'input-keyboard-symbolic',
        });
        Main.messageTray.add(source);
        source.connect('destroy', () => {
            if (this._source === source)
                this._source = null;
        });
        this._source = source;

        let notification;
        if (kind === 'missing') {
            notification = new MessageTray.Notification({
                source,
                title: _('Limited mode'),
                body: _('Effects only show for the shell itself, e.g. when typing in the Activities overview. For all apps, install the rg-helper service.'),
            });
            notification.addAction(_('Settings'), () => this._showPreferences());
            // Actions close the notice on their own
            notification.addAction(_('Not now'), () => {});
            notification.addAction(_("Don't show again"),
                () => this._settings.set_boolean('warn-helper-missing', false));
        } else {
            notification = new MessageTray.Notification({
                source,
                title: _('Input helper not working'),
                body: _('rg-helper is installed but not working: %s\nUntil it works, effects only show for the shell itself. See journalctl -u rg-helper.')
                    .replace('%s', detail),
            });
            notification.addAction(_('Settings'), () => this._showPreferences());
        }
        notification.connect('activated', () => this._showPreferences());
        source.addNotification(notification);
    }

    _showPreferences() {
        Main.panel.closeCalendar();
        this._openPreferences();
    }

    /** The helper works: removes the notice and allows it again. */
    resolved() {
        this.hide();
        // Runs on every unlock; write only when something was shown
        if (this._shown().size > 0)
            this._setShown([]);
    }

    /** Removes a notice still on screen or in the message list. */
    hide() {
        this._source?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._source = null;
    }
}
