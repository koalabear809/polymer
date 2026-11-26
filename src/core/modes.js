// Major and minor modes.
//
// A major mode has a keymap named `<mode>-map` whose parent is the parent mode's map,
// so bindings are inherited. Turning a mode on runs the parent chain's setup functions,
// then `<mode>-hook`.

import { defcommand, runHooks, call } from './registry.js';
import { keymap } from './keymap.js';
import { currentBuffer, getBuffer } from './buffer.js';
import { PolymerError } from './errors.js';

const majorModes = new Map(); // name -> { name, parent, doc, setup, lighter, readOnly }
const minorModes = new Map(); // name -> { name, doc, lighter, setup, teardown, global }

export function defineMajorMode(name, opts = {}) {
  const parent = opts.parent ?? (name === 'fundamental-mode' ? null : 'fundamental-mode');
  majorModes.set(name, {
    name,
    parent,
    doc: opts.doc ?? '',
    setup: opts.setup ?? null,
    lighter: opts.lighter ?? name.replace(/-mode$/, ''),
    readOnly: opts.readOnly,
    state: opts.state, // initial vim state for buffers in this mode
  });
  keymap(`${name}-map`, { parent: parent ? `${parent}-map` : null });
  defcommand(name, { doc: opts.doc || `Switch to ${name}.` }, () => setMajorMode(currentBuffer(), name));
  return name;
}

export const majorModeInfo = (name) => majorModes.get(name) ?? null;
export const allMajorModes = () => [...majorModes.values()];

/** Mode names from `name` up to fundamental-mode. */
export function modeChain(name) {
  const chain = [];
  for (let m = majorModes.get(name); m; m = majorModes.get(m.parent)) chain.push(m);
  return chain;
}

export function derivedModeP(name, ancestor) {
  return modeChain(name).some((m) => m.name === ancestor);
}

export function setMajorMode(buf, name) {
  const b = getBuffer(buf);
  const mode = majorModes.get(name);
  if (!mode) throw new PolymerError('error', `Unknown major mode: ${name}`);
  runHooks('change-major-mode-hook', b);
  b.locals.clear(); // kill-all-local-variables
  b.mode = name;
  const chain = modeChain(name).reverse(); // fundamental first
  for (const m of chain) {
    if (m.readOnly !== undefined) b.readOnly = m.readOnly;
    if (m.state) b.state = m.state;
    if (m.setup) call(m.setup, b);
  }
  for (const m of chain) runHooks(`${m.name}-hook`, b);
  runHooks('after-change-major-mode-hook', b);
  b.touch();
  return b;
}

export function defineMinorMode(name, opts = {}) {
  minorModes.set(name, {
    name,
    doc: opts.doc ?? '',
    lighter: opts.lighter ?? '',
    setup: opts.setup ?? null,
    teardown: opts.teardown ?? null,
  });
  keymap(`${name}-map`);
  defcommand(name, { doc: opts.doc || `Toggle ${name}.` }, (arg) => {
    const b = currentBuffer();
    const on = arg === undefined ? !b.minorModes.has(name) : !!arg;
    setMinorMode(b, name, on);
  });
  return name;
}

export const minorModeInfo = (name) => minorModes.get(name) ?? null;

export function setMinorMode(buf, name, on) {
  const b = getBuffer(buf);
  const mode = minorModes.get(name);
  if (!mode) throw new PolymerError('error', `Unknown minor mode: ${name}`);
  if (on === b.minorModes.has(name)) return;
  if (on) {
    b.minorModes.add(name);
    if (mode.setup) call(mode.setup, b);
  } else {
    b.minorModes.delete(name);
    if (mode.teardown) call(mode.teardown, b);
  }
  runHooks(`${name}-hook`, b, on);
  b.touch();
}

/** Keymaps active in a buffer, highest priority first. */
export function bufferKeymaps(b) {
  const maps = [];
  if (b.keymap) maps.push(b.keymap);
  for (const m of [...b.minorModes].reverse()) maps.push(`${m}-map`);
  maps.push(`${b.mode}-map`); // parents are followed by the lookup
  maps.push('global');
  return maps;
}

// Base modes.
defineMajorMode('fundamental-mode', { doc: 'The most basic major mode.' });
defineMajorMode('special-mode', { doc: 'Parent mode for read-only, non-file buffers (help, messages, ...).', readOnly: true });
defineMajorMode('help-mode', { parent: 'special-mode', doc: 'Mode for *Help* buffers.' });
defineMajorMode('messages-buffer-mode', { parent: 'special-mode', doc: 'Mode for the *Messages* buffer.' });
defineMajorMode('scratch-mode', { doc: 'Mode for the *scratch* buffer.' });
