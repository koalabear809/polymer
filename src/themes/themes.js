// Color themes.
//
// A theme sets the CSS variables in style.css: UI colors, syntax colors (--syn-*) and
// the 16-color terminal palette (--term-0 .. --term-15).
//
//   M-x load-theme      choose a theme (previews as you move; remembered across restarts)
//   setq('theme', 'nord') in init.js also works.
//
// Themes are files: one per theme, named after it, setting module.exports. The built-in
// ones live in src/themes/builtin/ and are copied to the theme directory (by default
// ~/.polymer/themes/) the first time it is created. Files there are loaded after the
// built-ins, so a copy replaces the built-in theme of the same name. A theme file:
//
//   // ~/.polymer/themes/my-theme.js
//   module.exports = {
//     label: 'My Theme',
//     base: 'gruvbox-dark',               // optional: start from another theme
//     ui: { bg: '#202020', accent: '#7aa2f7' },
//     syn: { keyword: '#ff79c6' },
//     term: { 0: '#202020' },             // a full 16-color array, or just some indexes
//     colors: { '--font-size': '14px' },  // optional: any other CSS variables
//   };
//
// Or define one from init.js or a package:
//   defineTheme('my-theme', { label: 'Mine', base: 'gruvbox-dark', ui: { bg: '#202020' } })

import { defcommand, defvar, getVarOr, setq, addVariableWatcher, runHooks, addHook } from '../core/registry.js';
import { helm } from '../core/helm/helm.js';
import { message } from '../core/echo.js';
import { PolymerError } from '../core/errors.js';
import { invalidateMetrics } from '../core/view.js';
import { scheduleRedisplay } from '../core/redisplay.js';
import { evalModule, describeLoadError, configDirectory } from '../core/loader.js';
import {
  readTextFile, writeTextFile, pathInfo, listDirectory, makeDirectory, expandFileName, asDirectory,
  abbreviateFileName,
} from '../core/files.js';
import { isTauri } from '../core/host.js';

defvar('theme', 'gruvbox-dark', { doc: 'The active color theme (see M-x load-theme).' });
defvar('chosen-theme', null, { doc: 'The theme last picked with load-theme; restored at startup unless init.js sets theme.' });
defvar('custom-theme-directory', null, {
  doc: [
    'Directory of theme files; by default <config>/themes/. Each NAME.js there defines the theme NAME',
    'by setting module.exports (reload with M-x reload-themes):',
    '  label   the name shown by load-theme',
    '  base    a theme to start from',
    '  ui      bg bgAlt bgHl bgSel fg fgDim fgMuted accent accent2 match error green yellow cyan',
    '          border region regionLine search',
    '  syn     comment keyword preproc operator string stringSpecial escape constant function builtin',
    '          macro type parameter property attribute tag label punctuation, and optionally',
    '          variable (default: fg) and number (default: constant)',
    '  term    the 16 terminal colors: an array, or { index: color }',
    '  colors  any CSS variables, e.g. { "--font-size": "14px" }; light themes set',
    '          { "--color-scheme": "light" } so scrollbars and form controls match',
  ].join('\n'),
});

/** The themes that ship with Polymer (src/themes/builtin/NAME.js). */
export const BUILTIN_THEMES = ['gruvbox-dark', 'gruvbox-dark-hard', 'tokyo-night', 'catppuccin-mocha', 'nord', 'one-dark', 'andromeda',
  'gruvbox-light', 'solarized-light', 'catppuccin-latte', 'one-light', 'github-light'];

// name -> entry { name, label, base, own, file }. `own` holds the theme's own variables;
// `base` is a theme name, or the entry a theme replaced when it names itself as its base
// (a nord.js that tweaks the built-in nord). Colors are resolved through `base` when a
// theme is applied, so editing a base reaches the themes built on it.
const themes = new Map();

function resolveColors(entry, seen = new Set()) {
  if (seen.has(entry)) throw new PolymerError('user-error', `Theme ${entry.name}: its bases form a loop`);
  seen.add(entry);
  let inherited = {};
  if (entry.base) {
    const base = typeof entry.base === 'string' ? themes.get(entry.base) : entry.base;
    if (!base) throw new PolymerError('user-error', `Theme ${entry.name}: unknown base theme ${entry.base}`);
    inherited = resolveColors(base, seen);
  }
  return { ...inherited, ...entry.own };
}

/** True if `entry` is `name` or built on it. */
function dependsOn(entry, name, seen = new Set()) {
  if (!entry || seen.has(entry)) return false;
  seen.add(entry);
  if (entry.name === name) return true;
  return dependsOn(typeof entry.base === 'string' ? themes.get(entry.base) : entry.base, name, seen);
}

/** The public view of an entry: { name, label, base, file, colors }. */
function view(entry) {
  return {
    name: entry.name,
    label: entry.label,
    base: typeof entry.base === 'string' ? entry.base : entry.base ? entry.name : null,
    file: entry.file,
    get colors() { return resolveColors(entry); },
  };
}

/**
 * CSS variables from palette groups. All keys are optional; camelCase becomes kebab-case.
 * ui:   bg, bgAlt, bgHl, bgSel, fg, fgDim, fgMuted, accent, accent2, match, error, green,
 *       yellow, cyan, border, region, regionLine, search            -> --bg, --bg-alt, ...
 * syn:  comment, keyword, preproc, operator, string, stringSpecial, escape, constant,
 *       function, builtin, macro, type, parameter, property, attribute, tag, label,
 *       punctuation; optionally variable (default: fg) and number (default: constant)
 *                                                                    -> --syn-comment, ...
 * term: 16 colors (an array, or an object of index -> color)        -> --term-0 .. --term-15
 */
export function themeColorsFrom({ ui = {}, syn = {}, term = [] } = {}) {
  // bgAlt -> bg-alt, accent2 -> accent-2
  const kebab = (k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/(\D)(\d)$/, '$1-$2');
  const out = {};
  for (const [k, v] of Object.entries(ui)) out[`--${kebab(k)}`] = v;
  for (const [k, v] of Object.entries(syn)) out[`--syn-${kebab(k)}`] = v;
  for (const [i, c] of Object.entries(term)) if (c) out[`--term-${i}`] = c;
  return out;
}

let batching = 0; // inside loadThemes: the active theme is re-applied once at the end

/**
 * Register (or replace) a theme. `ui`, `syn` and `term` are palette groups (see
 * themeColorsFrom); `colors` maps CSS variables to values directly and wins over them.
 * `base` names a theme to start from (it may be defined later). If the active theme is
 * this one or built on it, it is re-applied.
 */
export function defineTheme(name, { label = name, base = null, ui, syn, term, colors = {}, file = null } = {}) {
  if (!name || typeof name !== 'string') throw new PolymerError('error', 'defineTheme: a theme needs a name');
  let b = base;
  if (base === name) {
    // Tweaking the theme this replaces: build on that definition.
    b = themes.get(name);
    if (!b) throw new PolymerError('error', `Theme ${name} names itself as its base, but there is no earlier ${name}`);
  }
  themes.set(name, { name, label, base: b, file, own: { ...themeColorsFrom({ ui, syn, term }), ...colors } });
  if (!batching && applied && dependsOn(themes.get(currentTheme()), name)) tryApply(currentTheme());
  return name;
}

export const themeList = () => [...themes.values()].map(view);
export const getTheme = (name) => (themes.has(name) ? view(themes.get(name)) : null);
export const currentTheme = () => getVarOr('theme', null, null);

/** Switch to a theme (same as setq('theme', name)). A theme still loading applies when it arrives. */
export function loadTheme(name) {
  setq('theme', name, null);
  return name;
}

/** The value of a CSS variable in the active theme ('--bg' or 'bg'). */
export function themeColor(variable) {
  const v = variable.startsWith('--') ? variable : `--${variable}`;
  if (typeof document === 'undefined') return getTheme(currentTheme())?.colors[v] ?? null;
  return getComputedStyle(document.documentElement).getPropertyValue(v).trim() || null;
}

let applied = null; // variables the applied theme set, to clear ones the next theme doesn't

/**
 * Apply a theme's variables to the document and run after-load-theme-hook (unless
 * `hook` is false, as for load-theme's previews).
 */
export function applyTheme(name, { hook = true } = {}) {
  const entry = themes.get(name);
  if (!entry) throw new PolymerError('user-error', `Unknown theme: ${name}`);
  const colors = resolveColors(entry);
  if (typeof document === 'undefined') return view(entry);
  const root = document.documentElement.style;
  for (const k of applied ?? []) if (!(k in colors)) root.removeProperty(k);
  for (const [k, v] of Object.entries(colors)) root.setProperty(k, v);
  applied = Object.keys(colors);
  invalidateMetrics();
  scheduleRedisplay();
  if (hook) runHooks('after-load-theme-hook', name);
  return view(entry);
}

function tryApply(name) {
  try { applyTheme(name); } catch (e) { message('%s', e.message); }
}

// Changing the variable switches the theme. A theme that isn't defined yet while themes
// are loading (init.js pointing custom-theme-directory elsewhere, then picking one from
// there) is applied once they have loaded.
let setDuringStartup = false;
addVariableWatcher('theme', (name, value) => {
  setDuringStartup = true;
  if (!themes.has(value) && loading) {
    loading.then(() => { if (currentTheme() === value) tryApply(value); });
    return;
  }
  tryApply(value);
});

/** At startup: use the theme picked with load-theme last time, unless init.js chose one. */
export function restoreChosenTheme() {
  const chosen = getVarOr('chosen-theme', null, null);
  if (!setDuringStartup && chosen && themes.has(chosen) && chosen !== currentTheme()) setq('theme', chosen, null);
  else if (themes.has(currentTheme())) tryApply(currentTheme());
  else if (themes.has('gruvbox-dark')) tryApply('gruvbox-dark');
  // else: no themes loaded at all; style.css has Gruvbox Dark's colors.
}

// ---------------------------------------------------------------------------
// Theme files
//
// The theme directory gets copies of the built-in themes (new ones too). So that later fixes to
// those still arrive, <dir>.defaults.json records a hash of each copy as written: a copy
// that still matches is unedited, so the built-in theme is used and the copy is brought
// up to date. Once edited, the file is the user's and replaces the built-in theme.

/** The theme directory (custom-theme-directory, expanded, ending in "/"), or null. */
export function themeDirectory() {
  const d = getVarOr('custom-theme-directory', null, null);
  return d ? asDirectory(expandFileName(d)) : null;
}

const builtinUrl = (name) => new URL(`./builtin/${name}.js`, import.meta.url).href;

async function builtinSource(name) {
  const res = await fetch(builtinUrl(name));
  if (!res.ok) throw new PolymerError('error', `Could not read built-in theme ${name} (${res.status})`);
  return res.text();
}

const baseName = (path) => path.replace(/^.*[\\/]/, '').replace(/\.js$/, '');

/** True if `path` is directly in `dir` (which ends in a separator). */
function inDirectory(path, dir) {
  const norm = (p) => {
    const s = p.replace(/\\/g, '/');
    return /^[a-z]:\//i.test(s) ? s.toLowerCase() : s; // Windows paths ignore case
  };
  const p = norm(path);
  const d = norm(dir);
  return p.startsWith(d) && !p.slice(d.length).includes('/');
}

/** FNV-1a of the text with line endings normalized. */
function hashText(text) {
  let h = 0x811c9dc5;
  for (const ch of text.replace(/\r\n?/g, '\n')) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const manifestPath = (dir) => `${dir}.defaults.json`;

async function readManifest(dir) {
  try { return JSON.parse((await readTextFile(manifestPath(dir))).text); } catch { return {}; }
}

const writeManifest = (dir, manifest) => writeTextFile(manifestPath(dir), `${JSON.stringify(manifest, null, 2)}\n`, false);

/** Evaluate theme source and register what it exports under `name`. */
async function defineFromSource(name, code, path, file) {
  const exp = await evalModule(code, path);
  // A file may call defineTheme itself and export nothing.
  if (exp && typeof exp === 'object' && Object.keys(exp).length) defineTheme(name, { ...exp, file });
  return name;
}

/** Load one theme file (the theme is named after the file). Resolves to its name. */
export async function loadThemeFile(path) {
  path = expandFileName(path);
  return defineFromSource(baseName(path), (await readTextFile(path)).text, path, path);
}

/**
 * Copy built-in themes to the theme directory: `names` (default all). Existing files are
 * kept unless `overwrite`. With `keepRemoved`, themes copied once before whose file is gone
 * (the user deleted it) are not copied again. Resolves to the names copied.
 */
export async function installDefaultThemes({ names = BUILTIN_THEMES, overwrite = false, keepRemoved = false } = {}) {
  const dir = themeDirectory();
  if (!dir || !isTauri) throw new PolymerError('user-error', 'No theme directory (not running in the app?)');
  await makeDirectory(dir);
  const manifest = await readManifest(dir);
  const copied = [];
  for (const name of names) {
    const path = `${dir}${name}.js`;
    if (!overwrite && (await pathInfo(path)).exists) continue;
    if (!overwrite && keepRemoved && manifest[name]) continue;
    const text = await builtinSource(name);
    await writeTextFile(path, text, false);
    manifest[name] = hashText(text);
    copied.push(name);
  }
  if (copied.length) await writeManifest(dir, manifest);
  return copied;
}

let loading = null; // the loadThemes in progress

/** Resolves when no theme loading is in progress. */
export const themesReady = () => loading ?? Promise.resolve();

/**
 * Load the built-in themes, then the files in the theme directory (`user: false` skips
 * those), then re-apply the active theme once. Copies built-in themes missing from the
 * directory into it (all of them the first time). Resolves to { themes, errors }.
 */
export function loadThemes(opts) {
  const run = (loading ?? Promise.resolve()).then(() => loadThemesNow(opts));
  loading = run.finally(() => { if (loading === tracked) loading = null; });
  const tracked = loading;
  return run;
}

async function loadThemesNow({ user = true } = {}) {
  const errors = [];
  batching++;
  try {
    const builtins = await Promise.all(BUILTIN_THEMES.map((name) => builtinSource(name).then((text) => ({ name, text }), (error) => ({ name, error }))));
    for (const { name, text, error } of builtins) {
      if (error) { errors.push({ path: builtinUrl(name), error }); continue; }
      try { await defineFromSource(name, text, builtinUrl(name), null); } catch (e) { errors.push({ path: builtinUrl(name), error: e }); }
    }
    const dir = themeDirectory();
    if (user && dir && isTauri) errors.push(...await loadUserThemes(dir, builtins));
  } finally {
    batching--;
  }
  if (applied && themes.has(currentTheme())) tryApply(currentTheme());
  for (const { path, error } of errors) message('Theme %s', describeLoadError(error, path));
  return { themes: themes.size, errors };
}

async function loadUserThemes(dir, builtins) {
  const errors = [];
  // Built-in themes not in the directory yet (first run, or new in this version) land there,
  // except ones the user deleted.
  const existed = (await pathInfo(dir)).exists;
  try {
    const copied = await installDefaultThemes({ names: builtins.filter((x) => x.text !== undefined).map((x) => x.name), keepRemoved: true });
    if (!existed) message('Created %s with the built-in themes', abbreviateFileName(dir));
    else if (copied.length) message('Added built-in themes to %s: %s', abbreviateFileName(dir), copied.join(', '));
  } catch (e) { errors.push({ path: dir, error: e }); }
  // Forget themes from this directory's files; the files are read afresh below, so a deleted
  // file's theme goes away (built-in themes were already defined again).
  for (const [name, entry] of themes) {
    if (entry.file && inDirectory(entry.file, dir) && !BUILTIN_THEMES.includes(name)) themes.delete(name);
  }
  let names = [];
  try { names = (await listDirectory(dir)).filter((e) => !e.isDir && e.name.endsWith('.js')).map((e) => e.name); } catch { /* unreadable */ }
  const files = await Promise.all(names.map((n) => readTextFile(`${dir}${n}`).then(({ text }) => ({ path: `${dir}${n}`, text }), (error) => ({ path: `${dir}${n}`, error }))));
  const manifest = await readManifest(dir);
  const builtinText = new Map(builtins.filter((x) => x.text !== undefined).map((x) => [x.name, x.text]));
  let updated = 0;
  for (const { path, text, error } of files) {
    if (error) { errors.push({ path, error }); continue; }
    const name = baseName(path);
    const shipped = builtinText.get(name);
    if (shipped !== undefined && manifest[name] && manifest[name] === hashText(text)) {
      // An unedited copy: the built-in theme (already defined) stands; refresh the copy.
      themes.get(name).file = path;
      if (hashText(shipped) !== manifest[name]) {
        try {
          await writeTextFile(path, shipped, false);
          manifest[name] = hashText(shipped);
          updated++;
        } catch (e) { errors.push({ path, error: e }); }
      }
      continue;
    }
    try { await defineFromSource(name, text, path, path); } catch (e) { errors.push({ path, error: e }); }
  }
  if (updated) {
    try { await writeManifest(dir, manifest); } catch (e) { errors.push({ path: manifestPath(dir), error: e }); }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Commands

defcommand('load-theme', { doc: 'Choose a color theme. Moving through the list previews each one.' }, async () => {
  const original = currentTheme();
  try {
    const name = await helm({
      prompt: 'Theme: ',
      follow: true,
      sources: [{
        name: 'Themes',
        candidates: themeList().map((t) => ({ label: t.label, value: t.name, annotation: t.name === original ? 'current' : t.name })),
        preview: (n) => applyTheme(n, { hook: false }),
      }],
    });
    setq('theme', name, null);
    setq('chosen-theme', name, null);
    message('Theme: %s', themes.get(name).label);
  } catch (e) {
    if (themes.has(original)) applyTheme(original, { hook: false }); // cancelled: undo the preview
    throw e;
  }
});

defcommand('reload-themes', { doc: 'Load the theme files again (after editing one in the theme directory).' }, async () => {
  const { themes: n, errors } = await loadThemes();
  if (!errors.length) message('Loaded %d themes', n);
});

defcommand('install-default-themes', {
  doc: 'Copy the built-in themes that are missing from the theme directory into it (existing files are kept).',
}, async () => {
  const copied = await installDefaultThemes();
  const dir = abbreviateFileName(themeDirectory());
  if (copied.length) message('Copied %s to %s', copied.join(', '), dir);
  else message('All built-in themes are already in %s', dir);
});

defcommand('find-theme-file', { doc: 'Open a theme\'s file in the theme directory (copying a built-in theme there first).' }, async () => {
  const dir = themeDirectory();
  if (!dir || !isTauri) throw new PolymerError('user-error', 'No theme directory (not running in the app?)');
  const candidates = themeList()
    .filter((t) => t.file || BUILTIN_THEMES.includes(t.name))
    .map((t) => ({ label: t.label, value: t.name, annotation: t.file ? abbreviateFileName(t.file) : 'built-in' }));
  const name = await helm({ prompt: 'Theme file: ', sources: [{ name: 'Themes', candidates }] });
  const entry = themes.get(name);
  if (!entry.file) {
    // The copy is the built-in source, so the theme in use is unchanged.
    await installDefaultThemes({ names: [name] });
    entry.file = `${dir}${name}.js`;
  }
  const { openFile } = await import('../commands/files.js');
  return openFile(entry.file);
});

let startupDone = false;

/** Set custom-theme-directory from the config directory unless something already set it. */
export function initThemeDirectory() {
  const config = configDirectory();
  if (!themeDirectory() && config) setq('custom-theme-directory', `${config}themes/`, null);
  startupDone = true;
}

defvar('theme-reload-on-save', true, { doc: 'Reload the themes when a file in the theme directory is saved.' });

// Saving a theme file shows the change at once.
addHook('after-save-hook', function reloadThemesAfterSave(buf) {
  const dir = themeDirectory();
  if (!dir || !buf.file || !buf.file.endsWith('.js') || !inDirectory(buf.file, dir)) return;
  if (!getVarOr('theme-reload-on-save', true, buf)) return;
  loadThemes().then(({ errors }) => {
    if (!errors.length) message('Reloaded themes (%s)', baseName(buf.file));
  }, (e) => message('Themes: %s', e.message ?? e));
});

// Pointing custom-theme-directory elsewhere (e.g. from init.js) loads the themes there.
addVariableWatcher('custom-theme-directory', () => {
  if (startupDone) loadThemes().catch((e) => message('Themes: %s', e.message ?? e));
});
