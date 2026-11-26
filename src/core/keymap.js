// Keymaps, general.el style.
//
// A keymap holds one key trie per state ('normal', 'insert', 'visual', ... or '*' for
// any state). Bindings are command *names* (late bound) or functions. Lookup walks a
// list of keymaps in priority order; within a keymap the state-specific trie beats '*'.
//
//   defineKey({ keymaps: 'global', states: ['normal', 'visual'], prefix: 'SPC' }, {
//     'f':   { label: 'files' },     // which-key description for a prefix
//     'f f': 'find-file',
//     'f s': { cmd: 'save-buffer', label: 'save' },
//     'f x': null,                   // unbind
//   })

import { parseKeys } from './keys.js';

const keymaps = new Map(); // name -> Keymap
const stateParents = new Map(); // state -> [parent states]

/**
 * Declare that bindings in `parents` also apply in `state` (after its own), e.g.
 * normal, visual and operator states all inherit motions from the 'motion' state.
 */
export function setStateParents(state, parents) { stateParents.set(state, parents); }

function expandStates(state) {
  const out = [];
  const visit = (s) => {
    if (out.includes(s)) return;
    out.push(s);
    for (const p of stateParents.get(s) ?? []) visit(p);
  };
  visit(state);
  if (!out.includes('*')) out.push('*');
  return out;
}

export class Keymap {
  constructor(name, opts = {}) {
    this.name = name;
    this.parent = opts.parent ?? null; // name of parent keymap (consulted after this one)
    this.label = opts.label ?? '';
    this.tries = new Map(); // state -> root node
  }

  root(state, create = false) {
    let r = this.tries.get(state);
    if (!r && create) { r = { children: new Map() }; this.tries.set(state, r); }
    return r ?? null;
  }
}

/** Get a keymap by name, creating it if needed. */
export function keymap(name, opts) {
  let km = keymaps.get(name);
  if (!km) { km = new Keymap(name, opts); keymaps.set(name, km); }
  else if (opts?.parent !== undefined) km.parent = opts.parent;
  return km;
}

export const keymapp = (name) => keymaps.has(name);
export const allKeymaps = () => [...keymaps.values()];

function asList(x, dflt) {
  if (x === undefined || x === null) return dflt;
  return Array.isArray(x) ? x : [x];
}

function setBinding(km, state, keys, value) {
  let node = km.root(state, true);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    let child = node.children?.get(k);
    if (!child) {
      if (value === null) return; // unbinding something that doesn't exist
      child = {};
      node.children ??= new Map();
      node.children.set(k, child);
    }
    if (i === keys.length - 1) {
      if (value === null) {
        node.children.delete(k);
      } else if (typeof value === 'string' || typeof value === 'function') {
        child.cmd = value;
        delete child.children; // a command replaces a prefix
      } else {
        if ('cmd' in value) { child.cmd = value.cmd; delete child.children; }
        if ('label' in value) child.label = value.label;
      }
    } else {
      if (child.cmd !== undefined) delete child.cmd; // a prefix replaces a command
      child.children ??= new Map();
    }
    node = child;
  }
}

/**
 * Define keys. `def` may be a keymap name string or an options object:
 *   { keymaps = 'global', states = '*', prefix = '' }
 */
export function defineKey(def, bindings) {
  if (typeof def === 'string') def = { keymaps: def };
  const maps = asList(def.keymaps, ['global']);
  const states = asList(def.states, ['*']);
  const prefix = def.prefix ? parseKeys(def.prefix) : [];
  for (const mapName of maps) {
    const km = keymap(mapName);
    for (const state of states) {
      for (const [seq, value] of Object.entries(bindings)) {
        setBinding(km, state, [...prefix, ...parseKeys(seq)], value);
      }
    }
  }
}

function walk(root, keys) {
  let node = root;
  for (const k of keys) {
    node = node?.children?.get(k);
    if (!node) return null;
  }
  return node;
}

/**
 * Expand a context's keymap list into ordered tries.
 * `maps` entries: a keymap name, or { map, states } to restrict which tries are used.
 * Parent keymaps are consulted right after their child.
 */
function tries(maps, state) {
  const out = [];
  const seen = new Set();
  for (const entry of maps) {
    const spec = typeof entry === 'string' ? { map: entry } : entry;
    let name = spec.map;
    while (name && !seen.has(name)) {
      seen.add(name);
      const km = keymaps.get(name);
      if (!km) break;
      for (const st of spec.states ?? expandStates(state)) {
        const r = km.root(st);
        if (r) out.push(r);
      }
      name = km.parent;
    }
  }
  return out;
}

/**
 * Look up a key sequence.
 * Returns { type: 'command', cmd } | { type: 'prefix', nodes } | null.
 * The first trie (highest priority) with any binding for the sequence wins; for a
 * prefix, all tries that also have it as a prefix are collected (for which-key).
 */
export function lookupKey(maps, state, keys) {
  const roots = tries(maps, state);
  let prefixNodes = null;
  for (const r of roots) {
    const node = walk(r, keys);
    if (!node) continue;
    if (prefixNodes) {
      if (node.children?.size) prefixNodes.push(node);
      continue;
    }
    if (node.cmd !== undefined) return { type: 'command', cmd: node.cmd };
    if (node.children?.size) prefixNodes = [node];
  }
  return prefixNodes ? { type: 'prefix', nodes: prefixNodes } : null;
}

/** Children of a prefix for which-key: [{ key, cmd?, label?, prefix }], higher priority first. */
export function prefixEntries(nodes) {
  const out = new Map();
  for (const n of nodes) {
    for (const [k, child] of n.children ?? []) {
      if (out.has(k)) continue;
      if (child.cmd === undefined && !child.children?.size) continue;
      out.set(k, { key: k, cmd: child.cmd, label: child.label, prefix: child.cmd === undefined });
    }
  }
  return [...out.values()];
}

/** Find key sequences bound to `cmd`: [{ keymap, state, keys }]. */
export function whereIs(cmd, { maps } = {}) {
  const results = [];
  const names = maps ?? [...keymaps.keys()];
  for (const name of names) {
    const km = keymaps.get(name);
    if (!km) continue;
    for (const [state, root] of km.tries) {
      const stack = [[root, []]];
      while (stack.length) {
        const [node, path] = stack.pop();
        if (node.cmd === cmd) results.push({ keymap: name, state, keys: path });
        for (const [k, child] of node.children ?? []) stack.push([child, [...path, k]]);
      }
    }
  }
  // Shorter sequences first; global before others.
  results.sort((a, b) => a.keys.length - b.keys.length || (a.keymap === 'global' ? -1 : 0));
  return results;
}
