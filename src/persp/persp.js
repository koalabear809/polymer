// Perspectives (like perspective.el): named workspaces, each with its own buffer list and
// window layout. Switching saves the current layout and restores the other one.
//
// Saving: perspectives are written to <config>/var/perspectives/ as JSON. Buffers are
// saved by serializers, tried in order until one returns data:
//
//   defineBufferSerializer('my-kind', {
//     serialize: (buf) => (buf.mine ? { path: buf.mine.path } : null),
//     restore: async (data) => openMyThing(data.path),   // returns a buffer
//   })
//
// Built in: file buffers (path + point), terminals (directory + command; a fresh shell is
// started), and plain text buffers such as *scratch* (their contents).

import { defcommand, defvar, getVarOr, setq, addHook, runHooks } from '../core/registry.js';
import { defineKey } from '../core/keymap.js';
import {
  bufferList, getBuffer, getBufferCreate, generateNewBufferName, currentBuffer, findBufferVisiting, renameBuffer,
} from '../core/buffer.js';
import { setMajorMode, derivedModeP, majorModeInfo } from '../core/modes.js';
import {
  windowConfiguration, setWindowConfiguration, selectedWindow, setWindowBuffer, windowList,
} from '../core/window.js';
import { helm, readString, completingRead } from '../core/helm/helm.js';
import { message } from '../core/echo.js';
import { PolymerError } from '../core/errors.js';
import { thisCommandKeysString } from '../core/command-loop.js';
import { scheduleRedisplay } from '../core/redisplay.js';
import {
  readTextFile, writeTextFile, makeDirectory, listDirectory, pathInfo, findFileNoselect, abbreviateFileName,
} from '../core/files.js';
import { configDirectory } from '../core/loader.js';

defvar('persp-initial-name', 'main', { doc: 'Name of the first perspective.' });
defvar('persp-global-buffers', ['*Messages*'], { doc: 'Buffers shown in every perspective.' });
defvar('persp-show-in-mode-line', 'multiple', { doc: 'Show [perspective] in the mode line: true, false, or "multiple" (only when there is more than one).' });
defvar('persp-max-text-buffer-size', 1_000_000, { doc: 'Plain text buffers larger than this are not saved with a perspective.' });

const userError = (msg) => new PolymerError('user-error', msg);

// name -> { name, buffers: Set<Buffer>, config: window configuration | null }
const perspectives = new Map();
let current = null;
let previous = null; // the perspective last switched away from (persp-switch offers it first)
let switching = false;

export const perspNames = () => [...perspectives.keys()];
export const currentPersp = () => current;

function make(name) {
  const p = { name, buffers: new Set(), config: null };
  perspectives.set(name, p);
  return p;
}

/** Start with one perspective holding every buffer. */
export function initPerspectives() {
  if (current) return current;
  current = make(getVarOr('persp-initial-name', 'main'));
  for (const b of bufferList({ all: true })) current.buffers.add(b);
  scheduleRedisplay();
  return current;
}

const isGlobal = (b) => getVarOr('persp-global-buffers', [], null).includes(b.name);

/** Buffers in a perspective (most recent first), including global buffers. */
export function perspBufferList(p = current) {
  if (!p) return bufferList();
  return bufferList().filter((b) => p.buffers.has(b) || isGlobal(b));
}

export function perspAddBuffer(b, p = current) {
  if (p && b?.live) p.buffers.add(b);
}

export function perspRemoveBuffer(b, p = current) {
  p?.buffers.delete(b);
}

// Buffers shown in a window join the current perspective; killed buffers leave all.
addHook('window-buffer-change-hook', function perspTrackShownBuffer(win) {
  if (current && !switching) perspAddBuffer(win.buffer);
});
addHook('kill-buffer-hook', function perspForgetBuffer(b) {
  for (const p of perspectives.values()) p.buffers.delete(b);
});

/** The scratch buffer for a perspective (created on demand). */
function scratchFor(p) {
  const name = p.name === getVarOr('persp-initial-name', 'main') ? '*scratch*' : `*scratch* (${p.name})`;
  let b = getBuffer(name);
  if (!b) {
    b = getBufferCreate(name);
    setMajorMode(b, 'scratch-mode');
  }
  p.buffers.add(b);
  return b;
}

/** Switch to (or create) a perspective. */
export function perspSwitch(name) {
  initPerspectives();
  if (current.name === name) return current;
  current.config = windowConfiguration();
  const created = !perspectives.has(name);
  const target = perspectives.get(name) ?? make(name);
  const from = current;
  previous = from;
  current = target;
  switching = true;
  try {
    if (target.config) {
      // Fallback for windows whose buffer was killed meanwhile.
      const fallback = perspBufferList(target).find((b) => !isGlobal(b)) ?? scratchFor(target);
      setWindowConfiguration(target.config, fallback);
    } else {
      // A new perspective: one window on its scratch buffer.
      const scratch = scratchFor(target);
      setWindowConfiguration({ type: 'leaf', buffer: scratch, point: scratch.point.pos, selected: true }, scratch);
    }
  } finally {
    switching = false;
  }
  runHooks('persp-switch-hook', target, from);
  if (created) runHooks('persp-created-hook', target);
  message('Perspective: %s', target.name);
  return target;
}

export function perspRename(oldName, newName) {
  const p = perspectives.get(oldName);
  if (!p) throw userError(`No perspective ${oldName}`);
  if (perspectives.has(newName)) throw userError(`Perspective ${newName} already exists`);
  // Keep the order of perspectives.
  const entries = [...perspectives.entries()].map(([k, v]) => (k === oldName ? [newName, v] : [k, v]));
  perspectives.clear();
  for (const [k, v] of entries) perspectives.set(k, v);
  p.name = newName;
  // Its scratch buffer follows the name.
  const scratch = getBuffer(`*scratch* (${oldName})`);
  if (scratch && !getBuffer(`*scratch* (${newName})`)) renameBuffer(scratch, `*scratch* (${newName})`);
  scheduleRedisplay();
}

/**
 * Delete a perspective. Its buffers that belong to no other perspective are killed if
 * `killBuffers` (asking first about modified files).
 */
export async function perspKill(name, { killBuffers = true } = {}) {
  const p = perspectives.get(name);
  if (!p) throw userError(`No perspective ${name}`);
  if (perspectives.size === 1) throw userError('Can\'t delete the only perspective');
  if (p === current) {
    const names = perspNames();
    const i = names.indexOf(name);
    const before = previous;
    perspSwitch(names[i === 0 ? 1 : i - 1]);
    previous = before === current ? null : before; // not the perspective being deleted
  }
  perspectives.delete(name);
  if (previous === p) previous = null;
  if (killBuffers) {
    const { killBufferAsking } = await import('../commands/builtins.js');
    for (const b of p.buffers) {
      if (!b.live || isGlobal(b)) continue;
      if ([...perspectives.values()].some((o) => o.buffers.has(b))) continue;
      if (windowList().some((w) => w.buffer === b)) continue;
      await killBufferAsking(b);
    }
  }
  runHooks('persp-killed-hook', name);
  scheduleRedisplay();
}

// Mode line: [name]
function perspModeLine() {
  const show = getVarOr('persp-show-in-mode-line', 'multiple', null);
  if (!current || !show || (show === 'multiple' && perspectives.size < 2)) return '';
  return `[${current.name}]`;
}
setq('mode-line-segments', [...getVarOr('mode-line-segments', [], null).filter((f) => f.name !== 'perspModeLine'), perspModeLine], null);

// ---------------------------------------------------------------------------
// Serialization

const serializers = []; // { kind, serialize, restore }

/** Register a way to save and restore a kind of buffer. Later definitions are tried first. */
export function defineBufferSerializer(kind, { serialize, restore }) {
  const i = serializers.findIndex((s) => s.kind === kind);
  if (i >= 0) serializers.splice(i, 1);
  serializers.unshift({ kind, serialize, restore });
  return kind;
}

const pointOf = (b, pos) => {
  const { line, col } = b.posAt(pos);
  return { line, col };
};

function serializeBuffer(b) {
  for (const s of serializers) {
    let data = null;
    try { data = s.serialize(b); } catch (e) { console.warn(`serializer ${s.kind} failed for ${b.name}:`, e); }
    if (data) return { kind: s.kind, name: b.name, point: pointOf(b, b.point.pos), data };
  }
  return null;
}

async function restoreBuffer(desc) {
  const s = serializers.find((x) => x.kind === desc.kind);
  if (!s) throw new Error(`no serializer for ${desc.kind}`);
  const b = await s.restore(desc.data, desc);
  if (b && desc.point) b.point.set(b.offsetAt(desc.point.line, desc.point.col));
  return b;
}

defineBufferSerializer('text', {
  serialize: (b) => {
    if (b.file || b.term || derivedModeP(b.mode, 'special-mode')) return null;
    if (b.length > getVarOr('persp-max-text-buffer-size', 1_000_000, null)) return null;
    return { mode: b.mode, text: b.getText() };
  },
  restore: (data, desc) => {
    // Reuse an empty or identical buffer of the same name; otherwise pick a new name.
    let b = getBuffer(desc.name);
    if (b && b.getText() !== data.text && b.length) b = null;
    b ??= getBufferCreate(generateNewBufferName(desc.name));
    if (majorModeInfo(data.mode)) setMajorMode(b, data.mode);
    b.setText(data.text);
    b.modified = false;
    return b;
  },
});

defineBufferSerializer('dired', {
  serialize: (b) => (b.dired ? { dir: b.dired.dir } : null),
  restore: async (data) => {
    if (!(await pathInfo(data.dir)).isDir) return null;
    const { dired } = await import('../commands/dired.js');
    return dired(data.dir, { display: false });
  },
});

defineBufferSerializer('file', {
  serialize: (b) => (b.file ? { path: b.file } : null),
  restore: async (data) => {
    if (!(await pathInfo(data.path)).exists) return null;
    return findBufferVisiting(data.path) ?? findFileNoselect(data.path);
  },
});

defineBufferSerializer('term', {
  serialize: (b) => (b.term ? { cwd: getVarOr('default-directory', null, b), command: b.term.spawn?.command ?? null, args: b.term.spawn?.args ?? null } : null),
  restore: async (data, desc) => {
    const { openTerminal } = await import('../terminal/term.js');
    return openTerminal({ cwd: data.cwd ?? undefined, command: data.command ?? undefined, args: data.args ?? undefined, name: desc.name.replace(/<\d+>$/, ''), display: false });
  },
});

/** A perspective as JSON-ready data. Window leaves refer to buffers by index. */
function serializePersp(p) {
  const config = p === current ? windowConfiguration() : p.config;
  const descs = [];
  const index = new Map();
  const add = (b) => {
    if (index.has(b)) return index.get(b);
    const d = serializeBuffer(b);
    if (!d) return null;
    index.set(b, descs.length);
    descs.push(d);
    return index.get(b);
  };
  for (const b of perspBufferList(p)) if (!isGlobal(b)) add(b);
  const tree = (n) => {
    if (!n) return null;
    if (n.type === 'leaf') {
      return { type: 'leaf', buffer: n.buffer?.live ? add(n.buffer) : null, point: n.buffer?.live ? pointOf(n.buffer, n.point) : null, scrollTop: n.scrollTop ?? 0, selected: !!n.selected };
    }
    return { type: 'split', dir: n.dir, weights: n.weights, children: n.children.map(tree) };
  };
  return { name: p.name, buffers: descs, windows: tree(config) };
}

/** Recreate a perspective from serialized data (renaming it if the name is taken). */
async function deserializePersp(data, { switchTo = false } = {}) {
  initPerspectives();
  let name = data.name;
  if (perspectives.has(name)) {
    let i = 2;
    while (perspectives.has(`${data.name}<${i}>`)) i++;
    name = `${data.name}<${i}>`;
  }
  const p = make(name);
  const restored = [];
  const failed = [];
  for (const d of data.buffers ?? []) {
    try {
      const b = await restoreBuffer(d);
      restored.push(b ?? null);
      if (b) p.buffers.add(b);
      else failed.push(d.name);
    } catch (e) {
      restored.push(null);
      failed.push(d.name);
      console.warn(`perspective ${name}: could not restore ${d.name}:`, e);
    }
  }
  const fallback = [...p.buffers][0] ?? scratchFor(p);
  const tree = (n) => {
    if (!n) return { type: 'leaf', buffer: fallback, point: fallback.point.pos, selected: true };
    if (n.type === 'leaf') {
      const b = n.buffer !== null && n.buffer !== undefined ? restored[n.buffer] : null;
      const buf = b ?? fallback;
      const point = b && n.point ? buf.offsetAt(n.point.line, n.point.col) : buf.point.pos;
      return { type: 'leaf', buffer: buf, point, scrollTop: b ? n.scrollTop ?? 0 : 0, selected: n.selected };
    }
    return { type: 'split', dir: n.dir, weights: n.weights, children: n.children.map(tree) };
  };
  p.config = tree(data.windows);
  if (failed.length) message('Perspective %s: could not restore %s', name, failed.join(', '));
  if (switchTo) perspSwitch(name);
  runHooks('persp-loaded-hook', p);
  return p;
}

// ---------------------------------------------------------------------------
// Files: var/perspectives/<name>.persp.json (one) and <name>.session.json (all)

function perspDir() {
  const dir = configDirectory();
  if (!dir) throw userError('No config directory (not running in the app?)');
  return `${dir}var/perspectives/`;
}

const fileName = (name) => name.replace(/[^\w.@-]+/g, '_');

async function writeJson(path, data) {
  await makeDirectory(perspDir());
  await writeTextFile(path, `${JSON.stringify(data, null, 1)}\n`, false);
}

async function savedNames(suffix) {
  try {
    return (await listDirectory(perspDir())).filter((e) => !e.isDir && e.name.endsWith(suffix)).map((e) => e.name.slice(0, -suffix.length));
  } catch {
    return [];
  }
}

export async function saveCurrentPersp(as = current.name) {
  initPerspectives();
  const path = `${perspDir()}${fileName(as)}.persp.json`;
  await writeJson(path, { version: 1, type: 'perspective', perspective: { ...serializePersp(current), name: as } });
  return path;
}

export async function loadPersp(name) {
  const data = JSON.parse((await readTextFile(`${perspDir()}${fileName(name)}.persp.json`)).text);
  return deserializePersp(data.perspective, { switchTo: true });
}

export async function saveSession(name = 'session') {
  initPerspectives();
  const data = { version: 1, type: 'session', current: current.name, perspectives: [...perspectives.values()].map(serializePersp) };
  const path = `${perspDir()}${fileName(name)}.session.json`;
  await writeJson(path, data);
  return path;
}

export async function loadSession(name = 'session') {
  const data = JSON.parse((await readTextFile(`${perspDir()}${fileName(name)}.session.json`)).text);
  const loaded = [];
  for (const p of data.perspectives ?? []) loaded.push(await deserializePersp(p));
  const target = loaded.find((p) => p.name === data.current || p.name.startsWith(`${data.current}<`)) ?? loaded[0];
  if (target) perspSwitch(target.name);
  return loaded;
}

// The whole session is saved as "last" when quitting.
addHook('kill-polymer-hook', async function perspSaveLastSession() {
  if (!current || !configDirectory()) return;
  try { await saveSession('last'); } catch (e) { console.warn('perspectives: could not save the last session:', e); }
});

// ---------------------------------------------------------------------------
// Commands

// The other perspectives, the previous one first; the SPC TAB numbers keep the real order.
const perspCandidates = () => {
  const names = perspNames();
  const prev = previous && previous !== current && perspectives.get(previous.name) === previous ? previous.name : null;
  const others = names.filter((n) => n !== current.name && n !== prev);
  return (prev ? [prev, ...others] : others).map((n) => {
    const p = perspectives.get(n);
    const i = names.indexOf(n);
    return { label: n, value: n, annotation: `${i < 9 ? `SPC TAB ${i + 1}  ` : ''}${p.buffers.size} buffer${p.buffers.size === 1 ? '' : 's'}${n === prev ? '  previous' : ''}` };
  });
};

defcommand('persp-switch', { doc: 'Switch to a perspective, or create one by typing a new name.' }, () => {
  initPerspectives();
  return helm({
    prompt: 'Perspective: ',
    sources: [
      { name: 'Perspectives', candidates: perspCandidates(), actions: { Switch: (n) => perspSwitch(n), Delete: (n) => perspKill(n), Rename: async (n) => perspRename(n, await readString(`Rename ${n} to: `, { initial: n })) } },
      { name: 'New perspective', dummy: true, actions: { Create: (n) => perspSwitch(n.trim()) } },
    ],
  });
});

defcommand('persp-new', {
  doc: 'Create a perspective and switch to it.',
  interactive: async () => [await readString('New perspective: ')],
}, (name) => {
  name = (name ?? '').trim();
  if (!name) throw userError('A perspective needs a name');
  initPerspectives();
  if (perspectives.has(name)) throw userError(`Perspective ${name} already exists`);
  return perspSwitch(name);
});

defcommand('persp-kill', {
  doc: 'Delete a perspective (default: the current one) and the buffers only it had.',
  interactive: async () => {
    initPerspectives();
    return [await completingRead('Delete perspective: ', [current.name, ...perspNames().filter((n) => n !== current.name)])];
  },
}, (name) => perspKill(name ?? current.name));

defcommand('persp-rename', {
  doc: 'Rename the current perspective.',
  interactive: async () => { initPerspectives(); return [await readString('Rename perspective to: ', { initial: current.name })]; },
}, (name) => perspRename(current.name, name.trim()));

defcommand('persp-next', { doc: 'Switch to the next perspective.' }, () => {
  initPerspectives();
  const n = perspNames();
  return perspSwitch(n[(n.indexOf(current.name) + 1) % n.length]);
});

defcommand('persp-prev', { doc: 'Switch to the previous perspective.' }, () => {
  initPerspectives();
  const n = perspNames();
  return perspSwitch(n[(n.indexOf(current.name) - 1 + n.length) % n.length]);
});

defcommand('persp-switch-by-number', { doc: 'Switch to perspective N (the last key typed: SPC TAB 1 .. 9).' }, (n) => {
  initPerspectives();
  const k = n ?? Number(thisCommandKeysString().split(' ').at(-1));
  const name = perspNames()[k - 1];
  if (!name) throw userError(`No perspective ${k}`);
  return perspSwitch(name);
});

defcommand('persp-add-buffer', {
  doc: 'Add a buffer to the current perspective.',
  interactive: async () => {
    initPerspectives();
    const others = bufferList().filter((b) => !current.buffers.has(b)).map((b) => b.name);
    if (!others.length) throw userError('Every buffer is already in this perspective');
    return [await completingRead('Add buffer: ', others)];
  },
}, (name) => {
  const b = getBuffer(name);
  perspAddBuffer(b);
  setWindowBuffer(selectedWindow(), b);
});

defcommand('persp-remove-buffer', {
  doc: 'Remove a buffer from the current perspective (it stays open elsewhere).',
  interactive: async () => {
    initPerspectives();
    const cur = currentBuffer();
    const names = perspBufferList().filter((b) => !isGlobal(b)).map((b) => b.name);
    return [await completingRead('Remove buffer: ', [cur.name, ...names.filter((n) => n !== cur.name)])];
  },
}, (name) => {
  const b = getBuffer(name);
  perspRemoveBuffer(b);
  for (const w of windowList()) {
    if (w.buffer !== b) continue;
    switching = true; // don't re-add it while swapping it out
    try {
      setWindowBuffer(w, perspBufferList().find((x) => x !== b && !isGlobal(x)) ?? scratchFor(current));
    } finally {
      switching = false;
    }
    w.prevBuffers = w.prevBuffers.filter((x) => x !== b);
  }
});

defcommand('persp-save', {
  doc: 'Save the current perspective (its buffers and window layout).',
  interactive: async () => { initPerspectives(); return [await readString('Save perspective as: ', { initial: current.name })]; },
}, async (name) => {
  const path = await saveCurrentPersp(name?.trim() || current.name);
  message('Saved perspective to %s', abbreviateFileName(path));
});

defcommand('persp-load', { doc: 'Load a saved perspective and switch to it.' }, async () => {
  const names = await savedNames('.persp.json');
  if (!names.length) throw userError('No saved perspectives (save one with SPC TAB s)');
  const name = await completingRead('Load perspective: ', names);
  await loadPersp(name);
});

defcommand('persp-state-save', {
  doc: 'Save all perspectives as a named session.',
  interactive: async () => [await readString('Save session as: ', { initial: 'session' })],
}, async (name) => {
  const path = await saveSession(name?.trim() || 'session');
  message('Saved %d perspective%s to %s', perspectives.size, perspectives.size === 1 ? '' : 's', abbreviateFileName(path));
});

defcommand('persp-state-load', { doc: 'Load a saved session (all its perspectives).' }, async () => {
  const names = await savedNames('.session.json');
  if (!names.length) throw userError('No saved sessions (save one with SPC TAB S)');
  const name = await completingRead('Load session: ', names);
  const loaded = await loadSession(name);
  message('Loaded %d perspective%s', loaded.length, loaded.length === 1 ? '' : 's');
});

defcommand('persp-load-last-session', { doc: 'Load the session saved automatically when Polymer last quit.' }, async () => {
  if (!(await pathInfo(`${perspDir()}last.session.json`)).exists) throw userError('No last session saved yet');
  const loaded = await loadSession('last');
  message('Loaded %d perspective%s from the last session', loaded.length, loaded.length === 1 ? '' : 's');
});

// ---------------------------------------------------------------------------
// Keys (Doom's workspace bindings)

defineKey({ keymaps: 'global', states: ['normal', 'visual'], prefix: 'SPC' }, {
  'TAB': { label: 'perspectives' },
  'TAB TAB': 'persp-switch',
  'TAB .': 'persp-switch',
  'TAB n': 'persp-new',
  'TAB d': 'persp-kill',
  'TAB r': 'persp-rename',
  'TAB ]': 'persp-next',
  'TAB [': 'persp-prev',
  'TAB a': 'persp-add-buffer',
  'TAB x': 'persp-remove-buffer',
  'TAB s': 'persp-save',
  'TAB l': 'persp-load',
  'TAB S': 'persp-state-save',
  'TAB L': 'persp-state-load',
  'TAB R': 'persp-load-last-session',
  ...Object.fromEntries('123456789'.split('').map((d) => [`TAB ${d}`, 'persp-switch-by-number'])),
});

