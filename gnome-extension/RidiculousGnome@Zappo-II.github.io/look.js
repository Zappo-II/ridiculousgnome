// SPDX-FileCopyrightText: 2026 Zappo-II
// SPDX-License-Identifier: GPL-2.0-or-later

/*
 * Presentation mode's look: the style preset (presentation-style) and the
 * accent colour (presentation-accent) as inline St styles.
 *
 * Presets are style classes in stylesheet.css (rc-pres-style-*); only the
 * custom style and the accent colour, which come from settings, are inline
 * styles. Kept free of gi imports so it can be tested outside the shell.
 */

// GNOME 47+ org.gnome.desktop.interface accent-color -> libadwaita's
// accent background colours
const SYSTEM_ACCENTS = {
    blue: '#3584e4',
    teal: '#2190a4',
    green: '#3a944a',
    yellow: '#c88800',
    orange: '#ed5b00',
    red: '#e62d42',
    pink: '#d56199',
    purple: '#9141ac',
    slate: '#6f8396',
};
export const DEFAULT_ACCENT = SYSTEM_ACCENTS.blue;

const STYLES = ['dark', 'light', 'high-contrast', 'custom'];

/** @returns {number[]|null} [r, g, b] of a #rrggbb colour */
export function parseHex(color) {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color ?? '');
    return match ? match.slice(1).map(h => parseInt(h, 16)) : null;
}

/** @returns {string} CSS rgba() of a #rrggbb colour, fallback when invalid */
export function rgba(color, alpha, fallback = '#000000') {
    const [r, g, b] = parseHex(color) ?? parseHex(fallback);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** @returns {string} #rrggbb mixed with black by amount (0..1) */
function darken(color, amount) {
    const rgb = parseHex(color) ?? [0, 0, 0];
    return `#${rgb.map(c => Math.round(c * (1 - amount)).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * @param {string} accentChoice - presentation-accent: system or custom
 * @param {string} customAccent - presentation-accent-color
 * @param {string} systemName - accent-color of the desktop, '' if unknown
 * @returns {string} #rrggbb
 */
export function resolveAccent(accentChoice, customAccent, systemName) {
    if (accentChoice === 'custom' && parseHex(customAccent))
        return customAccent;
    return SYSTEM_ACCENTS[systemName] ?? DEFAULT_ACCENT;
}

/**
 * Style class and inline styles for the panel and its chips.
 *
 * @param {object} options
 * @param {string} options.style - presentation-style
 * @param {object} options.custom - {panel, opacity (0..100), text, chip}
 * @param {string} options.accent - #rrggbb
 * @returns {{styleClass: string, panel: string, chip: string, live: string, held: string}}
 */
export function presentationLook({style, custom, accent}) {
    const preset = STYLES.includes(style) ? style : 'dark';
    const look = {
        styleClass: `rc-pres-style-${preset}`,
        panel: '',
        chip: '',
        live: '',
        held: `border-color: ${rgba(accent, 1)}; background-color: ${rgba(accent, preset === 'high-contrast' ? 0.45 : 0.25)};`,
    };
    if (preset === 'custom') {
        const opacity = Math.min(100, Math.max(0, custom.opacity)) / 100;
        look.panel = `background-color: ${rgba(custom.panel, opacity, '#141414')};`;
        // The chip colour is the chip's fill; the border is a darker shade
        // of it, so the chip reads as a key cap on any panel
        const chip = parseHex(custom.chip) ? custom.chip : '#3a3a3a';
        look.chip = `color: ${rgba(custom.text, 1, '#ffffff')}; background-color: ${chip}; border-color: ${darken(chip, 0.35)};`;
        look.live = `color: ${rgba(custom.text, 0.6, '#ffffff')};`;
    }
    return look;
}
