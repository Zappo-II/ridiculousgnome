// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

/*
 * RidiculousGnome@Zappo-II.github.io preferences
 *
 * Console-Debug:
 *   `journalctl --user -f -o cat /usr/bin/gjs`
 */

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    CHIP, IMAGE, MARK, PRESENTATION_TRIGGERS, SHAKE, SOUND, TRIGGERS, loadEffects, setEffect,
} from './effects.js';
import {HELPER_NAME, getHelperProperty, peekHelper} from './helperDBus.js';
import {DETAILS} from './keyLabels.js';

// Marks a string for translation where gettext cannot run yet (module
// load, before the extension's text domain is bound); _() it when used
const N_ = s => s;

// What "Reset to defaults" resets per tab. Not: XP (own reset), window
// rules (the user's data), mode and pause, keys written by the extension.
const RESET_KEYS = {
    general: ['key-detail', 'panel-indicator', 'animate-labels', 'warn-helper-missing'],
    ridiculous: ['ridiculous-effects', 'ridiculous-sounds', 'ridiculous-char-labels', 'ridiculous-xp-indicator'],
    presentation: [
        'presentation-effects', 'presentation-target', 'presentation-corner', 'presentation-monitor',
        'presentation-size', 'presentation-idle-ms', 'presentation-style', 'presentation-custom-panel',
        'presentation-custom-opacity', 'presentation-custom-text', 'presentation-custom-chip',
        'presentation-accent', 'presentation-accent-color',
    ],
};

// Switches per trigger: [index in effects.js, icon, tooltip]
const EFFECT_SWITCHES = [
    [IMAGE, 'image-x-generic-symbolic', N_('Image')],
    [SOUND, 'audio-volume-high-symbolic', N_('Sound')],
    [SHAKE, 'rg-shake-symbolic', N_('Shake the window')],
];
const PRESENTATION_SWITCHES = [
    [CHIP, 'rg-chip-symbolic', N_('Chip in the panel')],
    [MARK, 'media-record-symbolic', N_('Rings at the pointer')],
];

// key-detail choices: [value, title, explanation]
const DETAIL_CHOICES = [
    ['activity', N_('Activity'), N_('A symbol for every key, nothing about which key.')],
    ['classes', N_('Classes'), N_('Letter, digit, symbol, space, and keys like Return or Shift.')],
    ['shortcuts', N_('Shortcuts'), N_('As classes, but with Ctrl, Alt or Super held the key itself: Ctrl + T. Typed text stays hidden.')],
    ['characters', N_('Characters'), N_('The typed characters.')],
];

// effect-mode choices: [value, title, explanation]
const MODE_CHOICES = [
    ['ridiculous', N_('Ridiculous'), N_('Effects inspired by Ridiculous Coding.')],
    ['presentation', N_('Presentation'), N_('Professional, for screencasts, tutorials and live demos.')],
];

// presentation-* choices: [value, title]
const TARGET_CHOICES = [
    ['subtitle', N_('Subtitle (bottom centre)')],
    ['heading', N_('Heading (top centre)')],
    ['card', N_('Card in a corner')],
];
const CORNER_CHOICES = [
    ['top-left', N_('Top left')],
    ['top-right', N_('Top right')],
    ['bottom-left', N_('Bottom left')],
    ['bottom-right', N_('Bottom right')],
];
const MONITOR_CHOICES = [
    ['primary', N_('Primary monitor')],
    ['pointer', N_('Monitor with the pointer')],
];
const SIZE_CHOICES = [
    ['small', N_('Small')],
    ['medium', N_('Medium')],
    ['large', N_('Large')],
];
const STYLE_CHOICES = [
    ['dark', N_('Dark')],
    ['light', N_('Light')],
    ['high-contrast', N_('High contrast')],
    ['custom', N_('Custom')],
];
const ACCENT_CHOICES = [
    ['system', N_('System accent colour')],
    ['custom', N_('Custom')],
];

// window-rules choices: [value, title]; the first one shows the global level
const RULE_CHOICES = [
    ['global', N_('Like all windows (%s)')],
    ['off', N_('Off')],
    ['mouse', N_('Mouse only')],
    ...DETAIL_CHOICES.map(([value, title]) => [value, title]),
];

// animation-status value -> [status label, why (shown on the status row;
// null when animations work), status kind (STATUS_STYLE)]
const ANIMATION_STATUS = {
    available: [N_('Available'), null, 'ok'],
    reduced: [N_('Off in GNOME'), N_('Reduce Animation is on (Settings → Accessibility).'), 'info'],
    inhibited: [N_('Disabled by the shell'), N_('No hardware-accelerated rendering (e.g. a VM without 3D) or a remote session.'), 'warning'],
    unknown: [N_('Unknown'), N_('The extension is not running, so the shell state cannot be read.'), 'info'],
};

// Status row kinds: [icon, libadwaita style class for its color]
const STATUS_STYLE = {
    ok: ['object-select-symbolic', 'success'],
    warning: ['dialog-warning-symbolic', 'warning'],
    error: ['dialog-error-symbolic', 'error'],
    info: ['dialog-information-symbolic', 'accent'],
};

// extensions.gnome.org page; set once the extension is published there
const EGO_URL = null;

const LICENSE = 'GPL-2.0-or-later';
const LICENSE_URL = 'https://www.gnu.org/licenses/old-licenses/gpl-2.0.html';

export default class RidiculousGnomePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        // Keep settings alive as long as the window
        window._settings = this.getSettings();
        const settings = window._settings;

        // Our own symbolic icons (rg-shake-symbolic), recoloured like the theme's
        Gtk.IconTheme.get_for_display(Gdk.Display.get_default()).add_search_path(`${this.path}/icons`);

        // Several pages show up as tabs; the window opens on the first one.
        // Both mode tabs are always there; the mode is chosen on General.
        const general = new Adw.PreferencesPage({title: _('General'), icon_name: 'dialog-information-symbolic'});
        general.add(this._buildHeaderGroup());
        general.add(this._buildModeGroup(settings));
        general.add(this._buildStatusGroup(window, settings));
        general.add(this._buildKeyDetailGroup(window, settings));
        general.add(this._buildAnimationGroup(settings));
        general.add(this._buildInputGroup(settings));
        general.add(this._buildLinksGroup(window));
        general.add(this._buildResetGroup(window, settings, 'general'));
        window.add(general);

        const ridiculous = new Adw.PreferencesPage({title: _('Ridiculous'), icon_name: 'starred-symbolic'});
        ridiculous.add(this._modeNoteGroup(settings, 'ridiculous'));
        ridiculous.add(this._buildEffectsGroup(settings));
        ridiculous.add(this._buildLabelsGroup(settings));
        ridiculous.add(this._buildExperienceGroup(window, settings));
        ridiculous.add(this._buildResetGroup(window, settings, 'ridiculous'));
        window.add(ridiculous);

        const presentation = new Adw.PreferencesPage({title: _('Presentation'), icon_name: 'video-display-symbolic'});
        presentation.add(this._modeNoteGroup(settings, 'presentation'));
        presentation.add(this._buildEventTypesGroup(settings));
        presentation.add(this._buildPresentationGroup(settings));
        presentation.add(this._buildLookGroup(settings));
        presentation.add(this._buildResetGroup(window, settings, 'presentation'));
        window.add(presentation);

        const windows = new Adw.PreferencesPage({title: _('Windows'), icon_name: 'view-grid-symbolic'});
        windows.add(this._buildWindowRulesGroup(window, settings));
        window.add(windows);
    }

    /**
     * "Reset to defaults" at the end of a tab: its settings (RESET_KEYS)
     * back to the schema's defaults, with a toast to undo it. Greyed out
     * while all of them are at their defaults.
     *
     * @param {Adw.PreferencesWindow} window - for the toast
     * @param {Gio.Settings} settings - extension settings
     * @param {string} tab - key of RESET_KEYS
     */
    _buildResetGroup(window, settings, tab) {
        const keys = RESET_KEYS[tab];
        const group = new Adw.PreferencesGroup();
        const row = new Adw.ButtonRow({title: _('Reset to Defaults'), start_icon_name: 'edit-undo-symbolic'});
        group.add(row);
        row.connect('activated', () => {
            // What the user had set, to put back on undo
            const saved = keys.map(key => [key, settings.get_user_value(key)]).filter(([, v]) => v !== null);
            keys.forEach(key => settings.reset(key));
            const toast = new Adw.Toast({title: _('Settings reset'), button_label: _('Undo')});
            toast.connect('button-clicked', () => saved.forEach(([key, value]) => settings.set_value(key, value)));
            window.add_toast(toast);
        });
        const update = () => {
            row.sensitive = keys.some(key => settings.get_user_value(key) !== null);
        };
        update();
        const changedIds = keys.map(key => settings.connect(`changed::${key}`, update));
        group.connect('destroy', () => changedIds.forEach(id => settings.disconnect(id)));
        return group;
    }

    /**
     * A note at the top of a mode's tab while the other mode is on; hidden
     * otherwise.
     *
     * @param {Gio.Settings} settings - extension settings
     * @param {string} mode - effect-mode value of this tab
     */
    _modeNoteGroup(settings, mode) {
        const group = new Adw.PreferencesGroup();
        const [, title] = MODE_CHOICES.find(([value]) => value === mode);
        const row = new Adw.ActionRow({
            title: _('%s mode is not on').replace('%s', _(title)),
            subtitle: _('These settings apply once it is chosen on the General page.'),
            subtitle_lines: 0,
        });
        const [icon, style] = STATUS_STYLE.info;
        row.add_prefix(new Gtk.Image({icon_name: icon, css_classes: [style]}));
        const button = new Gtk.Button({label: _('Switch to it'), valign: Gtk.Align.CENTER});
        button.connect('clicked', () => settings.set_string('effect-mode', mode));
        row.add_suffix(button);
        group.add(row);
        const update = () => {
            group.visible = settings.get_string('effect-mode') !== mode;
        };
        update();
        const changedId = settings.connect('changed::effect-mode', update);
        group.connect('destroy', () => settings.disconnect(changedId));
        return group;
    }

    /** Logo, name, version and licence; what the modes do is at the mode chooser. */
    _buildHeaderGroup() {
        const group = new Adw.PreferencesGroup();
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 18,
            halign: Gtk.Align.CENTER,
        });
        // GtkImage draws files at icon size, so pixel_size scales the SVG
        box.append(new Gtk.Image({file: `${this.path}/icons/ridiculousgnome-logo.svg`, pixel_size: 64}));
        const text = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            valign: Gtk.Align.CENTER,
        });
        text.append(new Gtk.Label({label: this.metadata.name, css_classes: ['title-2'], xalign: 0}));
        // version-name comes from a release, version from extensions.gnome.org;
        // a checkout has neither
        const version = this.metadata['version-name'] ?? this.metadata.version;
        const versionText = version !== undefined
            ? _('Version %s').replace('%s', `${version}`)
            : _('Development version');
        text.append(new Gtk.Label({label: `${versionText} · ${LICENSE}`, css_classes: ['dim-label'], xalign: 0}));
        box.append(text);
        group.add(box);
        return group;
    }

    /**
     * Problems first, each as its own row with what to do about it; a single
     * "everything works" row when there are none. Rebuilt on refresh, when
     * the helper appears or vanishes, and when a setting it depends on
     * changes.
     */
    _buildStatusGroup(window, settings) {
        const group = new Adw.PreferencesGroup({title: _('Status')});
        const refresh = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: _('Check again'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        group.header_suffix = refresh;

        let rows = [];
        let generation = 0;
        const update = async () => {
            const current = ++generation;
            const problems = await this._findProblems(settings);
            if (current !== generation)
                return; // a newer update is on its way
            rows.forEach(row => group.remove(row));
            rows = problems.length > 0
                ? problems.map(p => this._problemRow(window, p))
                : [this._problemRow(window, {
                    kind: 'ok',
                    title: _('Everything works'),
                    subtitle: _('Keyboard and mouse input from all apps through rg-helper.'),
                })];
            rows.forEach(row => group.add(row));
        };
        refresh.connect('clicked', update);
        const changedIds = ['animation-status', 'helper-status']
            .map(key => settings.connect(`changed::${key}`, update));
        // Follow the helper coming and going; the first callback runs the
        // initial update
        const watchId = Gio.bus_watch_name_on_connection(Gio.DBus.system, HELPER_NAME,
            Gio.BusNameWatcherFlags.NONE, update, update);
        group.connect('destroy', () => {
            changedIds.forEach(id => settings.disconnect(id));
            Gio.bus_unwatch_name(watchId);
        });

        return group;
    }

    _problemRow(window, {kind, title, subtitle, link}) {
        const row = new Adw.ActionRow({title, subtitle, subtitle_lines: 0});
        const [icon, style] = STATUS_STYLE[kind];
        row.add_prefix(new Gtk.Image({icon_name: icon, css_classes: [style]}));
        if (link) {
            const button = new Gtk.Button({
                label: link.label,
                valign: Gtk.Align.CENTER,
            });
            button.connect('clicked', () => openUri(window, link.uri));
            row.add_suffix(button);
        }
        return row;
    }

    /**
     * @returns {Promise<object[]>} rows for _problemRow, most important first
     */
    async _findProblems(settings) {
        const problems = [];

        const [state, detail] = await this._helperState(settings);
        if (state === 'connecting') {
            problems.push({
                kind: 'info',
                title: _('Limited mode: connecting to the input helper'),
                subtitle: _('Effects only show for the shell itself until rg-helper answers.'),
            });
        } else if (state === 'missing') {
            problems.push({
                kind: 'warning',
                title: _('Limited mode: input helper not installed'),
                subtitle: _('Effects only show for the shell itself (e.g. typing in the Activities overview), not for apps. For all apps, install the rg-helper service.'),
                link: {label: _('How to install'), uri: `${this.metadata.url}#2-the-helper`},
            });
        } else if (state === 'failed') {
            problems.push({
                kind: 'error',
                title: _('Limited mode: input helper not working'),
                subtitle: _('rg-helper is installed but does not start: %s\nUntil it works, effects only show for the shell itself. See journalctl -u rg-helper.')
                    .replace('%s', detail),
                link: {label: _('Report a problem'), uri: `${this.metadata.url}/issues`},
            });
        }

        const animation = settings.get_string('animation-status');
        if (animation === 'unknown') {
            problems.push({
                kind: 'info',
                title: _('Extension is off'),
                subtitle: _('Turn it on, e.g. in Extension Manager or with gnome-extensions enable. Settings can be changed meanwhile.'),
            });
        }
        // Animation problems show in the Animation group below
        return problems;
    }

    _buildLinksGroup(window) {
        const group = new Adw.PreferencesGroup({title: _('Links')});
        const links = [
            [_('Source code and documentation'), this.metadata.url],
            [_('Report a problem'), `${this.metadata.url}/issues`],
            [_('Licence (%s)').replace('%s', LICENSE), LICENSE_URL],
        ];
        if (EGO_URL)
            links.unshift([_('GNOME Extensions'), EGO_URL]);
        for (const [title, uri] of links) {
            const row = new Adw.ActionRow({title, subtitle: uri, activatable: true});
            row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
            row.connect('activated', () => openUri(window, uri));
            group.add(row);
        }
        return group;
    }

    /**
     * The key detail level, and what rg-helper allows at most: it gives
     * any process of the user keys, so characters need root's consent.
     */
    _buildKeyDetailGroup(window, settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Keys'),
            description: _('Any program you run could ask rg-helper for your keystrokes, so it only hands out characters when the administrator allows it.'),
        });

        const choiceRow = new Adw.ComboRow({
            title: _('Key labels show'),
            model: Gtk.StringList.new(DETAIL_CHOICES.map(([, title]) => _(title))),
        });
        group.add(choiceRow);
        const capRow = new Adw.ActionRow({title: _('Allowed by rg-helper'), subtitle_lines: 0});
        const capIcon = new Gtk.Image();
        capRow.add_prefix(capIcon);
        const capLabel = new Gtk.Label({css_classes: ['dim-label']});
        capRow.add_suffix(capLabel);
        const howButton = new Gtk.Button({label: _('How to allow more'), valign: Gtk.Align.CENTER});
        howButton.connect('clicked', () => openUri(window, `${this.metadata.url}#key-detail`));
        capRow.add_suffix(howButton);
        group.add(capRow);

        const titleOf = value => _(DETAIL_CHOICES.find(([v]) => v === value)?.[1] ?? value);
        let cap = null; // helper's MaxDetail; null while unknown
        const update = () => {
            const value = settings.get_string('key-detail');
            const index = DETAIL_CHOICES.findIndex(([v]) => v === value);
            if (choiceRow.selected !== index)
                choiceRow.selected = index;
            choiceRow.subtitle = _(DETAIL_CHOICES[index][2]);

            const capped = cap !== null && DETAILS.indexOf(value) > DETAILS.indexOf(cap);
            capLabel.label = cap === null ? _('Unknown') : titleOf(cap);
            capRow.subtitle = cap === null
                ? _('rg-helper is not running right now, so its limit is not known.')
                : capped
                    ? _('Labels are cut down to “%s”. Allowing more is up to the administrator (max-detail in /etc/rg-helper.conf).').replace('%s', titleOf(cap))
                    : '';
            const [icon, style] = STATUS_STYLE[capped ? 'warning' : cap === null ? 'info' : 'ok'];
            capIcon.icon_name = icon;
            capIcon.css_classes = [style];
            howButton.visible = capped;
        };
        choiceRow.connect('notify::selected', () => {
            const [value] = DETAIL_CHOICES[choiceRow.selected] ?? [];
            if (value && value !== settings.get_string('key-detail'))
                settings.set_string('key-detail', value);
        });

        let generation = 0;
        const readCap = async () => {
            const current = ++generation;
            let value = null;
            try {
                value = await getHelperProperty(Gio.DBus.system, 'MaxDetail');
            } catch {
                // not running, or a helper without detail levels
            }
            if (current !== generation)
                return;
            cap = value;
            update();
        };
        update();
        const changedId = settings.connect('changed::key-detail', update);
        const watchId = Gio.bus_watch_name_on_connection(Gio.DBus.system, HELPER_NAME,
            Gio.BusNameWatcherFlags.NONE, readCap, readCap);
        group.connect('destroy', () => {
            settings.disconnect(changedId);
            Gio.bus_unwatch_name(watchId);
        });
        return group;
    }

    /** Presentation mode's event types: chip and mark per trigger. */
    _buildEventTypesGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Event types')});
        const previews = []; // [id, Gtk.Button]
        const buttons = this._effectRows(group, settings, 'presentation', PRESENTATION_TRIGGERS,
            PRESENTATION_SWITCHES, this._previewAdder(settings, 'presentation', previews));
        const update = () => {
            const effects = loadEffects(settings, 'presentation');
            for (const [id, index, button] of buttons)
                button.active = effects[id][index];
            // Nothing in ridiculous mode, during a pause or with the row off
            const live = settings.get_string('effect-mode') === 'presentation' &&
                settings.get_boolean('show-effects');
            for (const [id, play] of previews)
                play.sensitive = live && effects[id].some(Boolean);
        };
        update();
        const changedIds = ['presentation-effects', 'effect-mode', 'show-effects']
            .map(key => settings.connect(`changed::${key}`, update));
        group.connect('destroy', () => changedIds.forEach(id => settings.disconnect(id)));
        return group;
    }

    /**
     * For _effectRows: a "Preview" button at the start of each row. The
     * extension shows it (prefs has no shell to draw in), so it looks and
     * sounds as in use, at this window and the pointer.
     *
     * @param {Gio.Settings} settings - extension settings
     * @param {string} mode - 'ridiculous' or 'presentation'
     * @param {Array[]} previews - gets [id, Gtk.Button] for updates
     * @returns {function} (row, trigger)
     */
    _previewAdder(settings, mode, previews) {
        return (row, {id, title}) => {
            const play = new Gtk.Button({
                icon_name: 'media-playback-start-symbolic',
                tooltip_text: _('Preview'),
                valign: Gtk.Align.CENTER,
                css_classes: ['flat', 'circular'],
            });
            play.update_property([Gtk.AccessibleProperty.LABEL], [`${_(title)}: ${_('Preview')}`]);
            play.connect('clicked', () =>
                settings.set_string('effect-preview-request', `${mode}:${id}#${Date.now()}`));
            row.add_suffix(play);
            previews.push([id, play]);
        };
    }

    /**
     * One row per trigger with round toggle buttons, one per switch, in
     * columns (also for rows without some switches).
     *
     * @param {Adw.PreferencesGroup} group - gets the rows
     * @param {Gio.Settings} settings - extension settings
     * @param {string} mode - 'ridiculous' or 'presentation' (effects.js)
     * @param {object[]} triggers - TRIGGERS or PRESENTATION_TRIGGERS
     * @param {Array[]} switches - [index, icon, tooltip] per column
     * @param {function} [addPrefix] - (row, trigger) before the buttons
     * @returns {Array[]} [id, index, Gtk.ToggleButton] for updates
     */
    _effectRows(group, settings, mode, triggers, switches, addPrefix = null) {
        const sizeGroup = new Gtk.SizeGroup({mode: Gtk.SizeGroupMode.HORIZONTAL});
        const buttons = [];
        for (const trigger of triggers) {
            const {id, title, subtitle, defaults} = trigger;
            const row = new Adw.ActionRow({title: _(title), subtitle: subtitle ? _(subtitle) : ''});
            addPrefix?.(row, trigger);
            const box = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
            for (const [index, icon, tooltip] of switches) {
                if (defaults[index] === null)
                    continue;
                const button = new Gtk.ToggleButton({
                    icon_name: icon,
                    tooltip_text: _(tooltip),
                    valign: Gtk.Align.CENTER,
                    css_classes: ['circular'],
                });
                button.update_property([Gtk.AccessibleProperty.LABEL], [`${_(title)}: ${_(tooltip)}`]);
                button.connect('toggled', () => {
                    if (button.active !== loadEffects(settings, mode)[id][index])
                        setEffect(settings, id, index, button.active, mode);
                });
                box.append(button);
                buttons.push([id, index, button]);
            }
            // Rows without some switches keep the others in their column
            const column = new Gtk.Box({valign: Gtk.Align.CENTER});
            column.append(box);
            sizeGroup.add_widget(column);
            row.add_suffix(column);
            group.add(row);
        }
        return buttons;
    }

    /**
     * Ridiculous mode: one row per trigger with toggle buttons for image,
     * sound and shake (ridiculous-effects).
     */
    _buildEffectsGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Effects')});
        // Quiet without touching the per-trigger sound switches
        const soundsRow = new Adw.SwitchRow({
            title: _('Sounds'),
            subtitle: _('Played as system sounds: volume in Settings → Sound → Volume Levels → System Sounds. Also in the top bar menu.'),
        });
        settings.bind('ridiculous-sounds', soundsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        // Nothing sounds during a pause, as in the top bar menu
        settings.bind('show-effects', soundsRow, 'sensitive', Gio.SettingsBindFlags.GET);
        group.add(soundsRow);
        const previews = []; // [id, Gtk.Button]
        const buttons = this._effectRows(group, settings, 'ridiculous', TRIGGERS, EFFECT_SWITCHES,
            this._previewAdder(settings, 'ridiculous', previews));
        // Nothing shakes with reduced motion: "Animate effects" off, GNOME
        // "Reduce Animation" or the shell's animations off
        const a11ySettings = new Gio.Settings({schema_id: 'org.gnome.desktop.a11y.interface'});
        const interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const update = () => {
            const effects = loadEffects(settings);
            const sounds = settings.get_boolean('ridiculous-sounds') && settings.get_boolean('show-effects');
            const shakes = settings.get_boolean('animate-labels') &&
                a11ySettings.get_string('reduced-motion') !== 'reduce' &&
                interfaceSettings.get_boolean('enable-animations');
            for (const [id, index, button] of buttons) {
                button.active = effects[id][index];
                // Greyed out but kept while all sounds are off (or effects
                // paused) or nothing may shake
                button.sensitive = (index !== SOUND || sounds) && (index !== SHAKE || shakes);
            }
            // Only what the row would do now: nothing in presentation mode,
            // during a pause or with all its switches off (or greyed out)
            const live = settings.get_string('effect-mode') === 'ridiculous' && settings.get_boolean('show-effects');
            for (const [id, play] of previews) {
                const [image, sound, shake] = effects[id];
                play.sensitive = live && (image || (sound && sounds) || (shake && shakes));
            }
            group.description = shakes
                ? ''
                : _('Nothing shakes while effects do not move: “Animate effects” is off on the General page, or animations are reduced or off in GNOME.');
        };
        update();
        const changedIds = ['ridiculous-effects', 'ridiculous-sounds', 'animate-labels', 'show-effects', 'effect-mode']
            .map(key => settings.connect(`changed::${key}`, update));
        const a11yChangedId = a11ySettings.connect('changed::reduced-motion', update);
        const interfaceChangedId = interfaceSettings.connect('changed::enable-animations', update);
        group.connect('destroy', () => {
            changedIds.forEach(id => settings.disconnect(id));
            a11ySettings.disconnect(a11yChangedId);
            interfaceSettings.disconnect(interfaceChangedId);
        });
        return group;
    }

    _buildLabelsGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Labels')});
        const charRow = new Adw.SwitchRow({
            title: _('Show typed keys and shortcuts'),
            subtitle: _('As much of the key as the key detail level shows.'),
        });
        settings.bind('ridiculous-char-labels', charRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(charRow);
        return group;
    }

    _buildExperienceGroup(window, settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Experience'),
            description: _('Typing earns XP, deleting costs it.'),
        });
        const xpIndicatorRow = new Adw.SwitchRow({title: _('Show the level in the top bar')});
        settings.bind('ridiculous-xp-indicator', xpIndicatorRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        // Shown on the top bar button
        settings.bind('panel-indicator', xpIndicatorRow, 'sensitive', Gio.SettingsBindFlags.GET);
        group.add(xpIndicatorRow);
        group.add(this._xpRow(window, settings));
        return group;
    }

    /** The XP so far, with a reset after asking. */
    _xpRow(window, settings) {
        const row = new Adw.ActionRow({title: _('Progress')});
        const reset = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        row.add_suffix(reset);
        const update = () => {
            const [xp, level] = settings.get_value('ridiculous-xp-state').deep_unpack();
            // TRANSLATORS: e.g. "Level 3 · 340 XP"
            row.subtitle = _('Level %d · %d XP').replace('%d', `${level}`).replace('%d', `${xp}`);
            reset.sensitive = xp > 0;
        };
        update();
        const changedId = settings.connect('changed::ridiculous-xp-state', update);
        row.connect('destroy', () => settings.disconnect(changedId));

        reset.connect('clicked', () => {
            const dialog = new Adw.AlertDialog({
                heading: _('Reset XP?'),
                body: _('Starts over at level 1 with 0 XP.'),
            });
            dialog.add_response('cancel', _('Cancel'));
            dialog.add_response('reset', _('Reset'));
            dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.default_response = 'cancel';
            dialog.close_response = 'cancel';
            dialog.connect('response', (_d, response) => {
                if (response === 'reset')
                    settings.reset('ridiculous-xp-state');
            });
            dialog.present(window);
        });
        return row;
    }

    _buildModeGroup(settings) {
        const group = new Adw.PreferencesGroup();
        const row = new Adw.ComboRow({
            title: _('Mode'),
            model: Gtk.StringList.new(MODE_CHOICES.map(([, title]) => _(title))),
        });
        group.add(row);

        const update = () => {
            const index = MODE_CHOICES.findIndex(([v]) => v === settings.get_string('effect-mode'));
            if (row.selected !== index)
                row.selected = index;
            row.subtitle = _(MODE_CHOICES[index][2]);
        };
        row.connect('notify::selected', () => {
            const [value] = MODE_CHOICES[row.selected] ?? [];
            if (value && value !== settings.get_string('effect-mode'))
                settings.set_string('effect-mode', value);
        });
        update();
        const changedId = settings.connect('changed::effect-mode', update);
        group.connect('destroy', () => settings.disconnect(changedId));

        // Both also in the top bar menu
        const showRow = new Adw.SwitchRow({
            title: _('Show effects'),
            subtitle: _('Off pauses everything, e.g. during a call.'),
        });
        settings.bind('show-effects', showRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(showRow);
        const panelRow = new Adw.SwitchRow({
            title: _('Show in the top bar'),
            subtitle: _('Pause, sounds and settings at hand.'),
        });
        settings.bind('panel-indicator', panelRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(panelRow);
        return group;
    }

    /**
     * A combo row bound to a string key.
     *
     * @param {Gio.Settings} settings - extension settings
     * @param {string} key - string key with choices
     * @param {string} title - row title (translated)
     * @param {string[][]} choices - [value, untranslated title] pairs
     * @returns {Adw.ComboRow}
     */
    _choiceRow(settings, key, title, choices) {
        const row = new Adw.ComboRow({
            title,
            model: Gtk.StringList.new(choices.map(([, t]) => _(t))),
        });
        const update = () => {
            const index = choices.findIndex(([v]) => v === settings.get_string(key));
            if (index >= 0 && row.selected !== index)
                row.selected = index;
        };
        row.connect('notify::selected', () => {
            const [value] = choices[row.selected] ?? [];
            if (value && value !== settings.get_string(key))
                settings.set_string(key, value);
        });
        update();
        const changedId = settings.connect(`changed::${key}`, update);
        row.connect('destroy', () => settings.disconnect(changedId));
        return row;
    }

    /** Presentation mode's placement, size and timing. */
    _buildPresentationGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Placement'),
            description: _('Keys, shortcuts and the wheel at a fixed place.'),
        });
        group.add(this._choiceRow(settings, 'presentation-target', _('Show keys as'), TARGET_CHOICES));
        const cornerRow = this._choiceRow(settings, 'presentation-corner', _('Corner'), CORNER_CHOICES);
        group.add(cornerRow);
        group.add(this._choiceRow(settings, 'presentation-monitor', _('Monitor'), MONITOR_CHOICES));
        group.add(this._choiceRow(settings, 'presentation-size', _('Size'), SIZE_CHOICES));

        const idleRow = new Adw.SpinRow({
            title: _('Fade out after'),
            subtitle: _('Seconds without input'),
            digits: 1,
            adjustment: new Gtk.Adjustment({lower: 0.5, upper: 10, step_increment: 0.5, page_increment: 1}),
        });
        idleRow.value = settings.get_uint('presentation-idle-ms') / 1000;
        idleRow.connect('notify::value', () => {
            const ms = Math.round(idleRow.value * 1000);
            if (ms !== settings.get_uint('presentation-idle-ms'))
                settings.set_uint('presentation-idle-ms', ms);
        });
        group.add(idleRow);

        const update = () => {
            cornerRow.sensitive = settings.get_string('presentation-target') === 'card';
            idleRow.value = settings.get_uint('presentation-idle-ms') / 1000;
        };
        update();
        const changedIds = ['presentation-target', 'presentation-idle-ms']
            .map(key => settings.connect(`changed::${key}`, update));
        group.connect('destroy', () => changedIds.forEach(id => settings.disconnect(id)));
        return group;
    }

    /** Presentation mode's style preset, custom colours and accent colour. */
    _buildLookGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Look')});
        const styleRow = this._choiceRow(settings, 'presentation-style', _('Style'), STYLE_CHOICES);
        group.add(styleRow);

        // Custom style: four settings, nothing more
        const customRows = [
            this._colorRow(settings, 'presentation-custom-panel', _('Panel colour')),
            this._opacityRow(settings),
            this._colorRow(settings, 'presentation-custom-text', _('Text colour')),
            this._colorRow(settings, 'presentation-custom-chip', _('Key colour')),
        ];
        customRows.forEach(row => group.add(row));

        const accentRow = this._choiceRow(settings, 'presentation-accent', _('Accent colour'), ACCENT_CHOICES);
        accentRow.subtitle = _('Click rings, drags and held keys.');
        group.add(accentRow);
        const accentColorRow = this._colorRow(settings, 'presentation-accent-color', _('Custom accent colour'));
        group.add(accentColorRow);

        const update = () => {
            const custom = settings.get_string('presentation-style') === 'custom';
            customRows.forEach(row => (row.visible = custom));
            accentColorRow.visible = settings.get_string('presentation-accent') === 'custom';
        };
        update();
        const changedIds = ['presentation-style', 'presentation-accent']
            .map(key => settings.connect(`changed::${key}`, update));
        group.connect('destroy', () => changedIds.forEach(id => settings.disconnect(id)));
        return group;
    }

    /** A row with a colour button bound to a #rrggbb string key. */
    _colorRow(settings, key, title) {
        const row = new Adw.ActionRow({title});
        const button = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: false}),
            valign: Gtk.Align.CENTER,
        });
        row.add_suffix(button);
        row.activatable_widget = button;
        const show = () => {
            const rgba = new Gdk.RGBA();
            if (rgba.parse(settings.get_string(key)) && !rgba.equal(button.rgba))
                button.rgba = rgba;
        };
        show();
        button.connect('notify::rgba', () => {
            const {red, green, blue} = button.rgba;
            const hex = `#${[red, green, blue].map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;
            if (hex !== settings.get_string(key))
                settings.set_string(key, hex);
        });
        const changedId = settings.connect(`changed::${key}`, show);
        row.connect('destroy', () => settings.disconnect(changedId));
        return row;
    }

    _opacityRow(settings) {
        const row = new Adw.SpinRow({
            title: _('Panel opacity'),
            subtitle: _('Percent'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 5, page_increment: 10}),
        });
        // By hand like presentation-idle-ms: a uint key on a double property
        const show = () => {
            row.value = settings.get_uint('presentation-custom-opacity');
        };
        show();
        row.connect('notify::value', () => {
            const value = Math.round(row.value);
            if (value !== settings.get_uint('presentation-custom-opacity'))
                settings.set_uint('presentation-custom-opacity', value);
        });
        const changedId = settings.connect('changed::presentation-custom-opacity', show);
        row.connect('destroy', () => settings.disconnect(changedId));
        return row;
    }

    /**
     * What the shell allows right now, with the reason when it does not
     * animate, and the switch. The shell's state is only known inside the
     * shell process; the extension publishes it in animation-status.
     */
    _buildAnimationGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Animation')});

        const statusRow = new Adw.ActionRow({title: _('Shell animations'), subtitle_lines: 0});
        const statusIcon = new Gtk.Image();
        statusRow.add_prefix(statusIcon);
        const statusLabel = new Gtk.Label({css_classes: ['dim-label']});
        statusRow.add_suffix(statusLabel);
        group.add(statusRow);

        // No subtitle: the reason when it is greyed out is on the status row
        const switchRow = new Adw.SwitchRow({title: _('Animate effects')});
        settings.bind('animate-labels', switchRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(switchRow);

        const update = () => {
            const status = settings.get_string('animation-status');
            const [label, reason, kind] = ANIMATION_STATUS[status] ?? ANIMATION_STATUS.unknown;
            statusLabel.label = _(label);
            statusRow.subtitle = reason ? _(reason) : '';
            const [icon, style] = STATUS_STYLE[kind];
            statusIcon.icon_name = icon;
            statusIcon.css_classes = [style];
            // Only meaningful while the shell can animate; unknown stays
            // editable so the choice can be made before enabling
            switchRow.sensitive = status === 'available' || status === 'unknown';
        };
        update();
        const changedId = settings.connect('changed::animation-status', update);
        group.connect('destroy', () => settings.disconnect(changedId));
        return group;
    }

    /**
     * Rules per WM class: a detail level, or off (no effects). Entered by
     * hand or picked from the open windows.
     */
    _buildWindowRulesGroup(window, settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Window rules'),
            description: _('“Off” shows no effects while that window has the focus, “Mouse only” no keys but clicks and the wheel, e.g. for a password manager. The other levels set what key labels show there. All other windows follow “Key labels show” on the General page.'),
        });
        const showButton = new Gtk.Button({
            label: _('Show active window classes'),
            valign: Gtk.Align.CENTER,
        });
        group.header_suffix = showButton;

        const getRules = () => settings.get_value('window-rules').deep_unpack();
        const setRules = rules => settings.set_value('window-rules', new GLib.Variant('a{ss}', rules));
        const addRule = wmClass => {
            const rules = getRules();
            if (wmClass && !(wmClass in rules))
                setRules({...rules, [wmClass]: 'off'});
        };
        showButton.connect('clicked', () => this._showWindowClasses(window, settings, addRule));

        // An own add button: EntryRow's apply button shows again as soon as
        // the text is cleared after applying
        const addRow = new Adw.EntryRow({title: _('Add WM class')});
        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: _('Add rule'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            sensitive: false,
        });
        addRow.add_suffix(addButton);
        const addTyped = () => {
            const wmClass = addRow.text.trim();
            if (!wmClass)
                return;
            addRule(wmClass);
            addRow.text = '';
        };
        addButton.connect('clicked', addTyped);
        addRow.connect('entry-activated', addTyped);
        addRow.connect('notify::text', () => {
            addButton.sensitive = addRow.text.trim() !== '';
        });
        group.add(addRow);

        let rows = [];
        const rebuild = () => {
            rows.forEach(row => group.remove(row));
            const rules = getRules();
            const global = settings.get_string('key-detail');
            const globalTitle = _(DETAIL_CHOICES.find(([v]) => v === global)?.[1] ?? global);
            const titles = Gtk.StringList.new(RULE_CHOICES.map(([value, title]) =>
                value === 'global' ? _(title).replace('%s', globalTitle) : _(title)));
            rows = Object.keys(rules).sort().map(wmClass => {
                const row = new Adw.ComboRow({
                    title: wmClass,
                    model: titles,
                    selected: Math.max(0, RULE_CHOICES.findIndex(([v]) => v === rules[wmClass])),
                });
                row.connect('notify::selected', () => {
                    const [value] = RULE_CHOICES[row.selected];
                    const current = getRules();
                    if (current[wmClass] !== value)
                        setRules({...current, [wmClass]: value});
                });
                const remove = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    tooltip_text: _('Remove rule'),
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                remove.connect('clicked', () => {
                    const current = getRules();
                    delete current[wmClass];
                    setRules(current);
                });
                row.add_suffix(remove);
                group.add(row);
                return row;
            });
        };
        rebuild();
        // The global level is part of the first choice's title
        const changedIds = ['window-rules', 'key-detail']
            .map(key => settings.connect(`changed::${key}`, rebuild));
        group.connect('destroy', () => changedIds.forEach(id => settings.disconnect(id)));
        return group;
    }

    /**
     * Dialog with the WM classes of the open windows. Only the shell knows
     * them: prefs bumps window-classes-request, the extension answers in
     * open-window-classes.
     */
    _showWindowClasses(window, settings, addRule) {
        const group = new Adw.PreferencesGroup({
            description: _('Windows open right now. Adding one creates a rule set to “Off”.'),
        });
        const page = new Adw.PreferencesPage();
        page.add(group);
        const view = new Adw.ToolbarView({content: page});
        view.add_top_bar(new Adw.HeaderBar());
        const dialog = new Adw.Dialog({
            title: _('Active window classes'),
            child: view,
            content_width: 480,
            content_height: 520,
        });

        let rows = [];
        const fill = () => {
            rows.forEach(row => group.remove(row));
            const rules = settings.get_value('window-rules').deep_unpack();
            const windows = settings.get_value('open-window-classes').deep_unpack()
                .sort(([, a], [, b]) => a.localeCompare(b));
            if (settings.get_string('animation-status') === 'unknown') {
                rows = [new Adw.ActionRow({title: _('The extension is off, so it cannot see the windows.')})];
            } else if (windows.length === 0) {
                rows = [new Adw.ActionRow({title: _('No windows open.')})];
            } else {
                rows = windows.map(([wmClass, name, icon]) => {
                    const row = new Adw.ActionRow({title: name || wmClass, subtitle: wmClass});
                    row.add_prefix(windowIcon(icon));
                    if (wmClass in rules) {
                        row.add_suffix(new Gtk.Label({label: _('Has a rule'), css_classes: ['dim-label']}));
                    } else {
                        const add = new Gtk.Button({
                            icon_name: 'list-add-symbolic',
                            tooltip_text: _('Add rule'),
                            valign: Gtk.Align.CENTER,
                            css_classes: ['flat'],
                        });
                        add.connect('clicked', () => addRule(wmClass));
                        row.add_suffix(add);
                    }
                    return row;
                });
            }
            rows.forEach(row => group.add(row));
        };
        const changedIds = ['open-window-classes', 'window-rules', 'animation-status']
            .map(key => settings.connect(`changed::${key}`, fill));
        dialog.connect('closed', () => changedIds.forEach(id => settings.disconnect(id)));
        fill();
        settings.set_uint('window-classes-request', (settings.get_uint('window-classes-request') + 1) >>> 0);
        dialog.present(window);
    }

    _buildInputGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Input')});

        const warnRow = new Adw.SwitchRow({
            title: _('Warn when the helper is missing'),
            subtitle: _('A notification once per session while rg-helper is not installed.'),
        });
        settings.bind('warn-helper-missing', warnRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(warnRow);

        return group;
    }

    /**
     * The helper's state as the running extension sees it (helper-status);
     * with the extension off only whether it is installed, found without
     * starting it — the extension starts it when it runs, and it exits on
     * its own when nobody uses it.
     *
     * @returns {Promise<[string, string]>} 'subscribed', 'connecting',
     *   'missing', 'failed' or 'installed', and for 'failed' why
     */
    async _helperState(settings) {
        const [status, detail] = settings.get_value('helper-status').deep_unpack();
        if (status !== 'unknown' && settings.get_string('animation-status') !== 'unknown')
            return [status, detail];
        try {
            return [await peekHelper(Gio.DBus.system), ''];
        } catch (e) {
            console.error(`RidiculousGnome prefs: helper check failed: ${e.message}`);
            return ['failed', e.message];
        }
    }
}

/**
 * @param {string} icon - serialized Gio.Icon from the extension, or ''
 * @returns {Gtk.Image}
 */
function windowIcon(icon) {
    try {
        if (icon)
            return new Gtk.Image({gicon: Gio.Icon.new_for_string(icon), pixel_size: 32});
    } catch {
        // an icon the prefs process cannot load
    }
    return new Gtk.Image({icon_name: 'application-x-executable-symbolic', pixel_size: 32});
}

function openUri(window, uri) {
    new Gtk.UriLauncher({uri}).launch(window, null, null);
}
