// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

/*
 * The button in the top bar, in both modes (panel-indicator).
 *
 * The button shows the logo, dimmed while effects are paused; its menu a
 * switch to pause effects (show-effects) and the way to the settings. In
 * ridiculous mode also a switch for all sounds (ridiculous-sounds) and,
 * with ridiculous-xp-indicator, "Lv 3" on the button and the level with
 * the XP within it as a progress bar in the menu (reset is in the
 * settings).
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Width of the progress bar in logical px (CSS px scale with the monitor)
const BAR_PX = 220;
// The logo while effects are paused
const PAUSED_OPACITY = 110;
// A switch while its menu item is insensitive
const INSENSITIVE_OPACITY = 128;

export const PanelIndicator = GObject.registerClass(
class PanelIndicator extends PanelMenu.Button {
    /**
     * @param {Gio.Settings} settings - extension settings
     * @param {string} extensionPath - for the logo
     * @param {function} openPreferences - opens the extension's settings
     */
    _init(settings, extensionPath, openPreferences) {
        super._init(0.5, _('Ridiculous Gnome'));
        this._settings = settings;
        this._xp = null;
        this._xpShown = false;
        this._shownXp = null; // {level, current, max} last shown
        this._barWidth = -1;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._logo = new St.Icon({
            gicon: Gio.FileIcon.new(Gio.File.new_for_path(`${extensionPath}/icons/ridiculousgnome-logo.svg`)),
            style_class: 'system-status-icon',
        });
        box.add_child(this._logo);
        this._panelLabel = new St.Label({style_class: 'rc-xp-panel-label', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._panelLabel);
        this.add_child(box);

        // XP part, ridiculous mode only
        this._levelItem = new PopupMenu.PopupMenuItem('', {reactive: false, style_class: 'rc-xp-level'});
        this.menu.addMenuItem(this._levelItem);
        this._progressItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
        const progressBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'rc-xp-progress'});
        const bar = new St.Widget({style_class: 'rc-xp-bar', style: `width: ${BAR_PX}px;`});
        this._barInner = new St.Widget({style_class: 'rc-xp-bar-inner'});
        bar.add_child(this._barInner);
        progressBox.add_child(bar);
        this._xpLabel = new St.Label({style_class: 'rc-xp-label'});
        progressBox.add_child(this._xpLabel);
        this._progressItem.add_child(progressBox);
        this.menu.addMenuItem(this._progressItem);
        this._xpSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._xpSeparator);

        this._switchItem(_('Show effects'), 'show-effects');
        // Quiet without touching the per-trigger sound switches
        this._soundItem = this._switchItem(_('Sounds'), 'ridiculous-sounds');
        this.menu.addAction(_('Settings'), () => openPreferences());

        const changedIds = ['effect-mode', 'ridiculous-xp-indicator', 'show-effects']
            .map(key => settings.connect(`changed::${key}`, () => this.update()));
        this.connect('destroy', () => changedIds.forEach(id => settings.disconnect(id)));
        this.update();
    }

    /** A menu switch bound to a boolean key. */
    _switchItem(title, key) {
        const item = new PopupMenu.PopupSwitchMenuItem(title, this._settings.get_boolean(key));
        item.connect('toggled', (_item, state) => this._settings.set_boolean(key, state));
        const changedId = this._settings.connect(`changed::${key}`,
            () => item.setToggleState(this._settings.get_boolean(key)));
        this.connect('destroy', () => this._settings.disconnect(changedId));
        this.menu.addMenuItem(item);
        return item;
    }

    /**
     * The ridiculous mode's XP, or null in presentation mode.
     *
     * @param {Xp|null} xp - the XP state to show
     */
    setXp(xp) {
        this._xp = xp;
        this.update();
    }

    /** Shows the current mode, pause and XP values. */
    update() {
        const ridiculous = this._settings.get_string('effect-mode') !== 'presentation';
        this._soundItem.visible = ridiculous;
        const shown = this._settings.get_boolean('show-effects');
        // Nothing sounds during a pause anyway
        this._soundItem.setSensitive(shown);
        // The theme greys only the label; the switch next to it as well
        const status = this._soundItem.label.get_next_sibling();
        if (status)
            status.opacity = shown ? 255 : INSENSITIVE_OPACITY;
        this._logo.opacity = shown ? 255 : PAUSED_OPACITY;

        this._xpShown = ridiculous && this._settings.get_boolean('ridiculous-xp-indicator') && Boolean(this._xp);
        for (const item of [this._panelLabel, this._levelItem, this._progressItem, this._xpSeparator])
            item.visible = this._xpShown;
        this._shownXp = null;
        this.updateXp();
    }

    /**
     * Shows the XP values only; called on every key that changes them, so
     * it reads no settings and touches only what changed.
     */
    updateXp() {
        if (!this._xpShown)
            return;
        const {level, current, max} = this._xp;
        const last = this._shownXp;
        this._shownXp = {level, current, max};
        if (last?.level !== level) {
            this._panelLabel.text = _('Lv %d').replace('%d', `${level}`);
            this._levelItem.label.text = _('Level %d').replace('%d', `${level}`);
        }
        if (last?.current === current && last?.max === max)
            return;
        // TRANSLATORS: XP within the current level, e.g. "40 / 150 XP"
        this._xpLabel.text = _('%d / %d XP').replace('%d', `${current}`).replace('%d', `${max}`);
        const fraction = max > 0 ? Math.min(1, current / max) : 0;
        const width = Math.round(BAR_PX * fraction);
        // A new style means a new theme node; only when the bar grows
        if (width !== this._barWidth) {
            this._barWidth = width;
            this._barInner.style = `width: ${width}px;`;
        }
    }
});
