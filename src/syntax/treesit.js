// Tree-sitter: incremental parsing and syntax highlighting.
//
// Each buffer whose major mode has a language gets `treesit-mode`: a parser and a syntax
// tree kept up to date with every edit (tree.edit + an incremental reparse on the next
// redisplay). Highlighting runs the language's highlights.scm query over the visible
// lines only.
//
// Adding a language (e.g. from a package):
//
//   defineTreesitLanguage('zig', {
//     wasm: __dirname + 'tree-sitter-zig.wasm',      // file path, or 'app:...' for bundled files
//     highlights: __dirname + 'highlights.scm',      // a path, { source: '...' }, or an array of these
//     modes: ['zig-mode'],
//   })

import { Parser, Language, Query } from '../vendor/web-tree-sitter/web-tree-sitter.js';
import { defvar, getVarOr, setq, addHook, defcommand } from '../core/registry.js';
import { defineMinorMode, setMinorMode, modeChain } from '../core/modes.js';
import { currentBuffer, bufferList } from '../core/buffer.js';
import { readTextFile } from '../core/files.js';
import { invoke } from '../core/host.js';
import { message } from '../core/echo.js';
import { PolymerError } from '../core/errors.js';
import { scheduleRedisplay } from '../core/redisplay.js';

defvar('treesit-font-lock', true, { doc: 'When true, buffers with a tree-sitter language get syntax highlighting automatically.' });
defvar('treesit-max-buffer-size', 4_000_000, { doc: 'Buffers larger than this many characters are not parsed.' });
defvar('treesit-highlight-chunk', 150, { doc: 'Lines highlighted per query (the visible area is covered in chunks).' });

const appRoot = new URL('../', import.meta.url);
const languages = new Map(); // name -> { name, wasm, highlights, modes, filePattern, loading }
let runtime = null;

function initRuntime() {
  runtime ??= Parser.init({
    locateFile: (file) => new URL(`vendor/web-tree-sitter/${file}`, appRoot).href,
  });
  return runtime;
}

// ---------------------------------------------------------------------------
// Languages

/**
 * Register (or update) a language.
 *   wasm        grammar file: a path, an 'app:<path>' URL for bundled files, or bytes
 *   highlights  query: a path, 'app:<path>', { source }, or an array of these (concatenated)
 *   modes       major modes (and their derived modes) that use this language
 *   filePattern optional RegExp: prefer this language when the file name matches
 *               (e.g. tsx for *.tsx in typescript-mode)
 */
export function defineTreesitLanguage(name, opts) {
  const prev = languages.get(name);
  languages.set(name, {
    name,
    wasm: opts.wasm ?? prev?.wasm,
    highlights: opts.highlights ?? prev?.highlights ?? [],
    modes: opts.modes ?? prev?.modes ?? [],
    filePattern: opts.filePattern ?? prev?.filePattern ?? null,
    loading: null, // reload on next use
  });
  // Re-attach buffers that might now use (or reload) this language.
  for (const b of bufferList({ all: true })) if (b.treesit?.lang === name || !b.treesit) maybeEnable(b);
  return name;
}

export const treesitLanguages = () => [...languages.values()];

async function readBytes(src) {
  if (src instanceof Uint8Array) return src;
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  if (src.startsWith('app:')) {
    const res = await fetch(new URL(src.slice(4), appRoot));
    if (!res.ok) throw new Error(`${src}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  return new Uint8Array(await invoke('read_binary_file', { path: src }));
}

async function readQuery(src) {
  if (typeof src === 'object' && src.source !== undefined) return src.source;
  if (src.startsWith('app:')) {
    const res = await fetch(new URL(src.slice(4), appRoot));
    if (!res.ok) throw new Error(`${src}: ${res.status}`);
    return res.text();
  }
  return (await readTextFile(src)).text;
}

/** Load a language's grammar and query (once). Resolves to { language, query }. */
export function loadTreesitLanguage(name) {
  const def = languages.get(name);
  if (!def) return Promise.reject(new PolymerError('treesit-error', `Unknown tree-sitter language: ${name}`));
  def.loading ??= (async () => {
    await initRuntime();
    const language = await Language.load(await readBytes(def.wasm));
    const sources = await Promise.all([].concat(def.highlights).map(readQuery));
    const query = sources.length ? new Query(language, sources.join('\n')) : null;
    return { language, query };
  })();
  def.loading.catch(() => { def.loading = null; });
  return def.loading;
}

/** The language name for a buffer, from its major mode (and file name), or null. */
export function languageForBuffer(b) {
  const custom = getVarOr('treesit-language-function', null, b);
  if (typeof custom === 'function') {
    const r = custom(b);
    if (r) return r;
  }
  for (const mode of modeChain(b.mode)) {
    const candidates = [...languages.values()].filter((l) => l.modes.includes(mode.name));
    if (!candidates.length) continue;
    const byFile = b.file && candidates.find((l) => l.filePattern?.test(b.file));
    return (byFile ?? candidates.find((l) => !l.filePattern) ?? candidates[0]).name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-buffer state

/**
 * Input callback for the parser: the text from `index` to the end of its line. Always
 * derive the position from the index: when web-tree-sitter reads a node's text (for
 * node.text and #match? predicates) it advances the index but passes the node's start
 * position on every call.
 */
function inputFor(b) {
  const t = b.text;
  return (index) => {
    if (index >= t.length) return null;
    const { line, col } = t.posAt(index);
    const chunk = t.line(line).slice(col);
    return line < t.lineCount - 1 ? `${chunk}\n` : chunk || null;
  };
}

function attach(b) {
  detach(b);
  const lang = languageForBuffer(b);
  if (!lang) return false;
  if (b.length > getVarOr('treesit-max-buffer-size', 4_000_000, b)) {
    message('Buffer too large for tree-sitter (treesit-max-buffer-size)');
    return false;
  }
  const state = {
    lang,
    parser: null,
    query: null,
    tree: null,
    dirty: true,
    version: 0,
    cache: new Map(),
    cacheVersion: -1,
    pending: null,
  };
  state.decorator = (buf, line) => lineHighlights(state, buf, line);
  b.treesit = state;
  b.decorators.push(state.decorator);
  loadTreesitLanguage(lang).then(({ language, query }) => {
    if (b.treesit !== state || !b.live) return;
    state.parser = new Parser();
    state.parser.setLanguage(language);
    state.query = query;
    state.dirty = true;
    b.touch();
  }).catch((e) => {
    message('tree-sitter: could not load %s: %s', lang, e.message ?? e);
    if (b.treesit === state) detach(b);
  });
  return true;
}

function detach(b) {
  const s = b.treesit;
  if (!s) return;
  b.decorators = b.decorators.filter((d) => d !== s.decorator);
  s.tree?.delete();
  s.parser?.delete();
  b.treesit = null;
  b.touch();
}

/** Make sure the buffer's tree reflects its text. Returns the tree, or null if not ready. */
export function ensureTree(b) {
  const s = b.treesit;
  if (!s?.parser) return null;
  if (s.dirty || !s.tree) {
    const old = s.tree;
    s.tree = s.parser.parse(inputFor(b), old ?? undefined);
    old?.delete();
    s.dirty = false;
    s.version++;
  }
  return s.tree;
}

export const treesitTree = (b = currentBuffer()) => ensureTree(b);

// Keep trees in sync with edits: record the old range before a change, apply after.
addHook('before-change-functions', function treesitBeforeChange(b, from, to) {
  const s = b.treesit;
  if (!s?.tree) return;
  const a = b.text.posAt(from);
  const z = b.text.posAt(to);
  s.pending = { startIndex: from, oldEndIndex: to, startPosition: { row: a.line, column: a.col }, oldEndPosition: { row: z.line, column: z.col } };
});

addHook('after-change-functions', function treesitAfterChange(b, from, to) {
  const s = b.treesit;
  if (!s) return;
  if (s.tree && s.pending) {
    const z = b.text.posAt(to);
    s.tree.edit({ ...s.pending, newEndIndex: to, newEndPosition: { row: z.line, column: z.col } });
  }
  s.pending = null;
  s.dirty = true;
});

// ---------------------------------------------------------------------------
// Highlighting

const faceCache = new Map();
const IGNORED_CAPTURES = /^(_|spell$|nospell$|none$|conceal$)/;

/** CSS classes for a capture name: "function.method" -> "hl-function hl-function-method". */
export function captureFace(name) {
  let f = faceCache.get(name);
  if (f === undefined) {
    const parts = name.split('.');
    f = parts.map((_, i) => `hl-${parts.slice(0, i + 1).join('-')}`).join(' ');
    faceCache.set(name, f);
  }
  return f;
}

function lineHighlights(state, b, line) {
  if (!state.query || !getVarOr('treesit-font-lock', true, b)) return [];
  const tree = ensureTree(b);
  if (!tree) return [];
  if (state.cacheVersion !== state.version) {
    state.cache.clear();
    state.cacheVersion = state.version;
  }
  if (!state.cache.has(line)) computeChunk(state, b, tree, line);
  return state.cache.get(line) ?? [];
}

const MAX_COLS = 5000; // don't paint absurdly long (minified) lines

/**
 * Highlight lines [start, start + chunk). Overlapping captures: inner (shorter) ranges win,
 * and for identical ranges the later pattern in the query wins, which is how the grammars'
 * queries are written (generic patterns like `(identifier) @variable` first, specific ones
 * after).
 */
function computeChunk(state, b, tree, start) {
  const end = Math.min(b.lineCount, start + getVarOr('treesit-highlight-chunk', 150, b));
  const caps = state.query.captures(tree.rootNode, {
    startPosition: { row: start, column: 0 },
    endPosition: { row: end, column: 0 },
  });
  // Captures on the same node arrive in pattern order; keep the last.
  const byRange = new Map();
  for (const c of caps) {
    if (IGNORED_CAPTURES.test(c.name)) continue;
    const n = c.node;
    const key = `${n.startIndex}:${n.endIndex}`;
    byRange.delete(key); // re-insert so ordering reflects the winner
    byRange.set(key, { len: n.endIndex - n.startIndex, sp: n.startPosition, ep: n.endPosition, face: captureFace(c.name) });
  }
  const items = [...byRange.values()];
  items.sort((x, y) => y.len - x.len); // outer first; inner ranges paint over them
  const paint = new Map(); // line -> array of faces per column
  for (const it of items) {
    const r0 = Math.max(start, it.sp.row);
    const r1 = Math.min(end - 1, it.ep.row);
    for (let row = r0; row <= r1; row++) {
      const len = Math.min(b.lineText(row).length, MAX_COLS);
      const from = row === it.sp.row ? it.sp.column : 0;
      const to = Math.min(row === it.ep.row ? it.ep.column : len, len);
      if (to <= from) continue;
      let arr = paint.get(row);
      if (!arr) { arr = new Array(len).fill(null); paint.set(row, arr); }
      for (let i = from; i < to; i++) arr[i] = it.face;
    }
  }
  for (let row = start; row < end; row++) {
    const arr = paint.get(row);
    const out = [];
    if (arr) {
      let i = 0;
      while (i < arr.length) {
        const f = arr[i];
        let j = i + 1;
        while (j < arr.length && arr[j] === f) j++;
        if (f) out.push({ from: i, to: j, face: f, priority: 1 });
        i = j;
      }
    }
    state.cache.set(row, out);
  }
}

// ---------------------------------------------------------------------------
// treesit-mode

defineMinorMode('treesit-mode', {
  doc: 'Parse the buffer with tree-sitter: syntax highlighting and structural text objects.',
  lighter: 'TS',
  setup: (b) => { if (!attach(b)) { b.minorModes.delete('treesit-mode'); message('No tree-sitter language for %s', b.mode); } },
  teardown: (b) => detach(b),
});

function maybeEnable(b) {
  if (!getVarOr('treesit-font-lock', true, b)) return;
  const want = !!languageForBuffer(b);
  const has = b.minorModes.has('treesit-mode');
  if (want && !has) setMinorMode(b, 'treesit-mode', true);
  else if (want && has && b.treesit?.lang !== languageForBuffer(b)) attach(b);
  else if (!want && has) setMinorMode(b, 'treesit-mode', false);
}

addHook('after-change-major-mode-hook', function treesitAutoEnable(b) { maybeEnable(b); });
addHook('kill-buffer-hook', function treesitCleanup(b) { detach(b); });

// ---------------------------------------------------------------------------
// Inspecting

/** Smallest named node at an offset. */
export function nodeAt(b, pos) {
  const tree = ensureTree(b);
  if (!tree) return null;
  let n = tree.rootNode.descendantForIndex(pos, pos);
  while (n && !n.isNamed && n.parent) n = n.parent;
  return n;
}

function requireTree(b) {
  if (!b.treesit) throw new PolymerError('user-error', 'treesit-mode is not enabled in this buffer');
  const t = ensureTree(b);
  if (!t) throw new PolymerError('user-error', 'The tree-sitter grammar is still loading');
  return t;
}

defcommand('treesit-inspect-node', { doc: 'Show the syntax node at point and its ancestors.' }, () => {
  const b = currentBuffer();
  requireTree(b);
  const path = [];
  for (let n = nodeAt(b, b.point.pos); n; n = n.parent) {
    const field = n.parent ? fieldNameOf(n) : null;
    path.push(field ? `${field}:${n.type}` : n.type);
  }
  message('%s', path.join(' < '));
});

function fieldNameOf(node) {
  const p = node.parent;
  for (let i = 0; i < p.childCount; i++) {
    if (p.child(i)?.id === node.id) return p.fieldNameForChild(i);
  }
  return null;
}

defcommand('treesit-explore', { doc: 'Show the syntax tree of the current buffer in *treesit-tree*.' }, async () => {
  const b = currentBuffer();
  const tree = requireTree(b);
  const lines = [];
  const cursor = tree.walk();
  let depth = 0;
  let count = 0;
  const visit = () => {
    do {
      const n = cursor.currentNode;
      if (n.isNamed) {
        const field = cursor.currentFieldName;
        const sp = n.startPosition;
        const ep = n.endPosition;
        lines.push(`${'  '.repeat(depth)}${field ? `${field}: ` : ''}${n.type}  [${sp.row + 1}:${sp.column}-${ep.row + 1}:${ep.column}]`);
        if (++count > 20000) return false;
      }
      if (cursor.gotoFirstChild()) {
        depth++;
        if (visit() === false) return false;
        depth--;
        cursor.gotoParent();
      }
    } while (cursor.gotoNextSibling());
    return true;
  };
  visit();
  cursor.delete();
  if (count > 20000) lines.push('… (truncated)');
  const { showHelp } = await import('../commands/help.js');
  showHelp(lines.join('\n'));
});

defcommand('treesit-toggle-highlighting', { doc: 'Toggle tree-sitter highlighting everywhere.' }, () => {
  const on = !getVarOr('treesit-font-lock', true, null);
  setq('treesit-font-lock', on, null);
  for (const b of bufferList({ all: true })) b.touch();
  scheduleRedisplay();
  message('Tree-sitter highlighting %s', on ? 'on' : 'off');
});
