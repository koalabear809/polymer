// Color themes.
//
// A theme sets the CSS variables in style.css: UI colors, syntax colors (--syn-*) and
// the 16-color terminal palette (--term-0 .. --term-15).
//
//   M-x load-theme      choose a theme (previews as you move; remembered across restarts)
//   setq('theme', 'nord') in init.js also works.
//
// Define your own (from init.js or a package): start from an existing theme and override.
//   defineTheme('my-theme', { label: 'Mine', base: 'gruvbox-dark', colors: { '--bg': '#202020' } })

import { defcommand, defvar, getVarOr, setq, addVariableWatcher } from '../core/registry.js';
import { helm } from '../core/helm/helm.js';
import { message } from '../core/echo.js';
import { PolymerError } from '../core/errors.js';
import { invalidateMetrics } from '../core/view.js';
import { scheduleRedisplay } from '../core/redisplay.js';

defvar('theme', 'gruvbox-dark', { doc: 'The active color theme (see M-x load-theme).' });
defvar('chosen-theme', null, { doc: 'The theme last picked with load-theme; restored at startup unless init.js sets theme.' });

const themes = new Map();

/**
 * Build a theme's variables from a palette.
 * ui: bg, bgAlt, bgHl, bgSel, fg, fgDim, fgMuted, accent, accent2, match, error, green,
 *     yellow, cyan, border, region, regionLine, search
 * syn: comment, keyword, preproc, operator, string, stringSpecial, escape, constant,
 *      function, builtin, macro, type, parameter, property, attribute, tag, label, punctuation
 * term: 16 colors
 */
function colorsFrom({ ui, syn, term }) {
  // bgAlt -> bg-alt, accent2 -> accent-2
  const kebab = (k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/(\D)(\d)$/, '$1-$2');
  const out = {};
  for (const [k, v] of Object.entries(ui)) out[`--${kebab(k)}`] = v;
  for (const [k, v] of Object.entries(syn)) out[`--syn-${kebab(k)}`] = v;
  term.forEach((c, i) => { out[`--term-${i}`] = c; });
  return out;
}

/** Register a theme. `colors` maps CSS variables to values; `base` copies another theme first. */
export function defineTheme(name, { label = name, base = null, colors = {} } = {}) {
  const inherited = base ? themes.get(base)?.colors : null;
  if (base && !inherited) throw new PolymerError('error', `Unknown base theme: ${base}`);
  themes.set(name, { name, label, colors: { ...(inherited ?? {}), ...colors } });
  if (getVarOr('theme', null, null) === name) applyTheme(name);
  return name;
}

export const themeList = () => [...themes.values()];

/** Apply a theme's variables to the document. */
export function applyTheme(name) {
  const t = themes.get(name);
  if (!t) throw new PolymerError('user-error', `Unknown theme: ${name}`);
  if (typeof document === 'undefined') return t;
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(t.colors)) root.setProperty(k, v);
  invalidateMetrics();
  scheduleRedisplay();
  return t;
}

// Changing the variable switches the theme.
let setDuringStartup = false;
addVariableWatcher('theme', (name, value) => {
  setDuringStartup = true;
  try { applyTheme(value); } catch (e) { message('%s', e.message); }
});

/** At startup: use the theme picked with load-theme last time, unless init.js chose one. */
export function restoreChosenTheme() {
  const chosen = getVarOr('chosen-theme', null, null);
  if (!setDuringStartup && chosen && themes.has(chosen) && chosen !== getVarOr('theme', null, null)) setq('theme', chosen, null);
  else applyTheme(getVarOr('theme', 'gruvbox-dark', null));
}

defcommand('load-theme', { doc: 'Choose a color theme. Moving through the list previews each one.' }, async () => {
  const original = getVarOr('theme', 'gruvbox-dark', null);
  try {
    const name = await helm({
      prompt: 'Theme: ',
      follow: true,
      sources: [{
        name: 'Themes',
        candidates: themeList().map((t) => ({ label: t.label, value: t.name, annotation: t.name === original ? 'current' : t.name })),
        preview: (n) => applyTheme(n),
      }],
    });
    setq('theme', name, null);
    setq('chosen-theme', name, null);
    message('Theme: %s', themes.get(name).label);
  } catch (e) {
    applyTheme(original); // cancelled: undo the preview
    throw e;
  }
});

// ---------------------------------------------------------------------------
// Themes

// Gruvbox (morhetz/gruvbox palette)
const gb = {
  bg0h: '#1d2021', bg0: '#282828', bg1: '#3c3836', bg2: '#504945', bg3: '#665c54', bg4: '#7c6f64',
  fg: '#ebdbb2', fg4: '#a89984', gray: '#928374',
  red: '#fb4934', green: '#b8bb26', yellow: '#fabd2f', blue: '#83a598', purple: '#d3869b', aqua: '#8ec07c', orange: '#fe8019',
  red2: '#cc241d', green2: '#98971a', yellow2: '#d79921', blue2: '#458588', purple2: '#b16286', aqua2: '#689d6a',
};
const gruvboxSyntax = {
  comment: gb.gray, keyword: gb.red, preproc: gb.aqua, operator: gb.orange, string: gb.green,
  stringSpecial: gb.aqua, escape: gb.orange, constant: gb.purple, function: gb.green, builtin: gb.orange,
  macro: gb.aqua, type: gb.yellow, parameter: gb.blue, property: gb.blue, attribute: gb.aqua, tag: gb.red,
  label: gb.yellow, punctuation: gb.fg4,
};
const gruvboxTerm = [gb.bg0, gb.red2, gb.green2, gb.yellow2, gb.blue2, gb.purple2, gb.aqua2, gb.fg4, gb.gray, gb.red, gb.green, gb.yellow, gb.blue, gb.purple, gb.aqua, gb.fg];

defineTheme('gruvbox-dark', {
  label: 'Gruvbox Dark',
  colors: colorsFrom({
    ui: { bg: gb.bg0, bgAlt: gb.bg0h, bgHl: gb.bg1, bgSel: gb.bg2, fg: gb.fg, fgDim: gb.bg4, fgMuted: gb.fg4, accent: gb.blue, accent2: gb.purple, match: gb.orange, error: gb.red, green: gb.green, yellow: gb.yellow, cyan: gb.aqua, border: gb.bg0h, region: gb.bg2, regionLine: gb.bg1, search: gb.bg3 },
    syn: gruvboxSyntax,
    term: gruvboxTerm,
  }),
});

defineTheme('gruvbox-dark-hard', {
  label: 'Gruvbox Dark Hard',
  colors: colorsFrom({
    ui: { bg: gb.bg0h, bgAlt: '#141617', bgHl: gb.bg0, bgSel: gb.bg1, fg: gb.fg, fgDim: gb.bg4, fgMuted: gb.fg4, accent: gb.blue, accent2: gb.purple, match: gb.orange, error: gb.red, green: gb.green, yellow: gb.yellow, cyan: gb.aqua, border: '#141617', region: gb.bg2, regionLine: gb.bg0, search: gb.bg3 },
    syn: gruvboxSyntax,
    term: [gb.bg0h, ...gruvboxTerm.slice(1)],
  }),
});

// Tokyo Night (folke/tokyonight.nvim "night")
defineTheme('tokyo-night', {
  label: 'Tokyo Night',
  colors: colorsFrom({
    ui: { bg: '#1a1b26', bgAlt: '#16161e', bgHl: '#292e42', bgSel: '#2f3549', fg: '#c0caf5', fgDim: '#565f89', fgMuted: '#737aa2', accent: '#7aa2f7', accent2: '#bb9af7', match: '#ff9e64', error: '#f7768e', green: '#9ece6a', yellow: '#e0af68', cyan: '#7dcfff', border: '#101014', region: '#364a82', regionLine: '#2a3456', search: '#3d59a1' },
    syn: { comment: '#565f89', keyword: '#bb9af7', preproc: '#7dcfff', operator: '#89ddff', string: '#9ece6a', stringSpecial: '#b4f9f8', escape: '#89ddff', constant: '#ff9e64', function: '#7aa2f7', builtin: '#2ac3de', macro: '#7dcfff', type: '#2ac3de', parameter: '#e0af68', property: '#73daca', attribute: '#bb9af7', tag: '#f7768e', label: '#7dcfff', punctuation: '#9aa5ce' },
    term: ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6', '#414868', '#ff899d', '#9fe044', '#faba4a', '#8db0ff', '#c7a9ff', '#a4daff', '#c0caf5'],
  }),
});

// Catppuccin Mocha
const cm = {
  base: '#1e1e2e', mantle: '#181825', crust: '#11111b', s0: '#313244', s1: '#45475a', s2: '#585b70', o0: '#6c7086', o1: '#7f849c',
  text: '#cdd6f4', sub0: '#a6adc8', sub1: '#bac2de', rosewater: '#f5e0dc', pink: '#f5c2e7', mauve: '#cba6f7', red: '#f38ba8',
  maroon: '#eba0ac', peach: '#fab387', yellow: '#f9e2af', green: '#a6e3a1', teal: '#94e2d5', sky: '#89dceb', sapphire: '#74c7ec', blue: '#89b4fa', lavender: '#b4befe',
};
defineTheme('catppuccin-mocha', {
  label: 'Catppuccin Mocha',
  colors: colorsFrom({
    ui: { bg: cm.base, bgAlt: cm.mantle, bgHl: cm.s0, bgSel: cm.s1, fg: cm.text, fgDim: cm.o0, fgMuted: cm.o1, accent: cm.blue, accent2: cm.mauve, match: cm.peach, error: cm.red, green: cm.green, yellow: cm.yellow, cyan: cm.sky, border: cm.crust, region: cm.s1, regionLine: cm.s0, search: cm.s2 },
    syn: { comment: cm.o0, keyword: cm.mauve, preproc: cm.pink, operator: cm.sky, string: cm.green, stringSpecial: cm.pink, escape: cm.pink, constant: cm.peach, function: cm.blue, builtin: cm.red, macro: cm.teal, type: cm.yellow, parameter: cm.maroon, property: cm.lavender, attribute: cm.yellow, tag: cm.mauve, label: cm.sapphire, punctuation: cm.o1 },
    term: [cm.s1, cm.red, cm.green, cm.yellow, cm.blue, cm.pink, cm.teal, cm.sub1, cm.s2, cm.red, cm.green, cm.yellow, cm.blue, cm.pink, cm.teal, cm.sub0],
  }),
});

// Nord
const nd = { n0: '#2e3440', n1: '#3b4252', n2: '#434c5e', n3: '#4c566a', n4: '#d8dee9', n5: '#e5e9f0', n6: '#eceff4', n7: '#8fbcbb', n8: '#88c0d0', n9: '#81a1c1', n10: '#5e81ac', red: '#bf616a', orange: '#d08770', yellow: '#ebcb8b', green: '#a3be8c', purple: '#b48ead' };
defineTheme('nord', {
  label: 'Nord',
  colors: colorsFrom({
    ui: { bg: nd.n0, bgAlt: '#272c36', bgHl: nd.n1, bgSel: nd.n2, fg: nd.n4, fgDim: nd.n3, fgMuted: '#7b88a1', accent: nd.n8, accent2: nd.purple, match: nd.orange, error: nd.red, green: nd.green, yellow: nd.yellow, cyan: nd.n7, border: '#242933', region: nd.n2, regionLine: nd.n1, search: nd.n3 },
    syn: { comment: '#616e88', keyword: nd.n9, preproc: nd.n10, operator: nd.n9, string: nd.green, stringSpecial: nd.yellow, escape: nd.yellow, constant: nd.purple, function: nd.n8, builtin: nd.n7, macro: nd.n10, type: nd.n7, parameter: nd.n4, property: nd.n4, attribute: nd.n7, tag: nd.n9, label: nd.n7, punctuation: '#a0a8b7' },
    term: [nd.n1, nd.red, nd.green, nd.yellow, nd.n9, nd.purple, nd.n8, nd.n5, nd.n3, nd.red, nd.green, nd.yellow, nd.n9, nd.purple, nd.n7, nd.n6],
  }),
});

// One Dark (Atom)
const od = { bg: '#282c34', alt: '#21252b', hl: '#2c313a', sel: '#3e4451', fg: '#abb2bf', gray: '#5c6370', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', purple: '#c678dd', cyan: '#56b6c2', orange: '#d19a66' };
defineTheme('one-dark', {
  label: 'One Dark',
  colors: colorsFrom({
    ui: { bg: od.bg, bgAlt: od.alt, bgHl: od.hl, bgSel: od.sel, fg: od.fg, fgDim: '#4b5263', fgMuted: od.gray, accent: od.blue, accent2: od.purple, match: od.orange, error: od.red, green: od.green, yellow: od.yellow, cyan: od.cyan, border: '#181a1f', region: od.sel, regionLine: od.hl, search: '#4d5566' },
    syn: { comment: od.gray, keyword: od.purple, preproc: od.purple, operator: od.cyan, string: od.green, stringSpecial: od.cyan, escape: od.cyan, constant: od.orange, function: od.blue, builtin: od.cyan, macro: od.cyan, type: od.yellow, parameter: od.red, property: od.red, attribute: od.orange, tag: od.red, label: od.red, punctuation: od.fg },
    term: ['#3f4451', od.red, od.green, od.yellow, od.blue, od.purple, od.cyan, '#d7dae0', '#4f5666', '#ff7b86', '#b1e18b', '#efb074', '#67cdff', '#e48bff', '#63d4e0', '#ffffff'],
  }),
});
