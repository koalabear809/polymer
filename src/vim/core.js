// The vim engine: states, counts, registers prefix, motions, operators, text objects,
// visual selection, jumps, marks, insert sessions and dot-repeat.
//
// Extending it from init.js:
//
//   defmotion('my-next-heading', { type: 'line', jump: true }, (count, { buf }) => offset)
//   defoperator('my-rot13', {}, (range, { buf }) => { ... })
//   deftextobject('my-inner-line', {}, (count, { buf }) => ({ from, to, type: 'char' }))
//
// Each becomes a named command; bind it with defineKey.

import { defcommand, defvar, getVarOr, addHook, runHooks } from '../core/registry.js';
import { currentBuffer, getBuffer } from '../core/buffer.js';
import { Marker, makeOverlay, deleteOverlay } from '../core/marker.js';
import { undoBoundary } from '../core/undo.js';
import { visualColumn, columnForVisual, cellWidthAt } from '../core/width.js';
import { PolymerError } from '../core/errors.js';
import { echo } from '../core/echo.js';
import { setStateParents } from '../core/keymap.js';
import { executeKeys } from '../core/command-loop.js';
import { scheduleRedisplay } from '../core/redisplay.js';
import { setReadOnlyRegister } from './registers.js';

defvar('vim-shift-width', 4, { doc: 'Columns shifted by > and <.' });
defvar('vim-want-Y-yank-to-eol', true, { doc: 'When true, Y yanks to the end of the line (like y$) instead of the whole line.' });
defvar('vim-move-cursor-back', true, { doc: 'When true, leaving insert state moves the cursor back one character.' });

setStateParents('normal', ['motion']);
setStateParents('visual', ['motion']);
setStateParents('operator', ['motion']);

export const cur = () => currentBuffer();

/** Per-buffer vim state. */
export function vimState(b) {
  b.vim ??= {
    visual: null,       // { type: 'char'|'line'|'block', anchor: Marker, toEol }
    lastVisual: null,   // { type, anchor: Marker, point: Marker }
    marks: new Map(),   // char -> Marker
    insert: null,       // active insert session
    overlays: [],       // visual selection overlays
    lastInsertPos: null,
    lastJump: null,     // Marker for `` and ''
  };
  return b.vim;
}

export function setState(b, state) {
  if (b.state === state) return;
  const prev = b.state;
  b.state = state;
  runHooks('vim-state-change-hook', b, prev, state);
  b.touch();
}

export const motionFailed = () => new PolymerError('motion-failed', '');

// ---------------------------------------------------------------------------
// Prefix arguments: count and register

export const prefix = { count: null, register: null, keep: false };

function showPrefix() {
  const parts = [];
  if (prefix.register) parts.push(`"${prefix.register}`);
  if (prefix.count !== null) parts.push(String(prefix.count));
  if (parts.length) echo(parts.join(' '));
}

export function addDigit(d) {
  prefix.count = (prefix.count ?? 0) * 10 + d;
  prefix.keep = true;
  showPrefix();
}

export function setPrefixRegister(r) {
  prefix.register = r;
  prefix.keep = true;
  showPrefix();
}

// ---------------------------------------------------------------------------
// Ranges

export function lineRange(b, startLine, endLine) {
  return { type: 'line', startLine, endLine, from: b.lineStart(startLine), to: b.lineEnd(endLine) };
}

export function charRange(from, to) {
  return { type: 'char', from: Math.min(from, to), to: Math.max(from, to) };
}

export const firstNonBlankCol = (text) => /^[ \t]*/.exec(text)[0].length;

export function firstNonBlank(b, line) {
  return b.lineStart(line) + firstNonBlankCol(b.lineText(line));
}

/** Convert a motion's start/target into a range, applying Vim's exclusive-motion rules. */
export function rangeFromMotion(b, start, target, type) {
  const from = Math.min(start, target);
  let to = Math.max(start, target);
  if (type === 'line') return lineRange(b, b.lineAt(from), b.lineAt(to));
  if (type === 'inclusive') return charRange(from, Math.min(b.length, to + 1));
  // Exclusive motion ending in column 0 of a later line (:help exclusive-linewise).
  if (to > from) {
    const end = b.posAt(to);
    const startLine = b.lineAt(from);
    if (end.col === 0 && end.line > startLine) {
      if (b.posAt(from).col <= firstNonBlankCol(b.lineText(startLine))) {
        return lineRange(b, startLine, end.line - 1);
      }
      to = b.lineEnd(end.line - 1);
    }
  }
  return charRange(from, to);
}

/** Per-line pieces of a block range: [{ line, from, to }]. */
export function blockSegments(b, range) {
  const out = [];
  const tw = getVarOr('tab-width', 4, b);
  for (let line = range.startLine; line <= range.endLine; line++) {
    const text = b.lineText(line);
    const s = columnForVisual(text, range.startV, tw);
    const e = range.endV === Infinity ? text.length : columnForVisual(text, range.endV, tw);
    const start = b.lineStart(line);
    out.push({ line, from: start + Math.min(s, text.length), to: start + Math.min(Math.max(e, s), text.length) });
  }
  return out;
}

/** Text of a range, in register form. */
export function rangeText(b, range) {
  if (range.type === 'line') {
    const parts = [];
    for (let l = range.startLine; l <= range.endLine; l++) parts.push(b.lineText(l));
    return `${parts.join('\n')}\n`;
  }
  if (range.type === 'block') return blockSegments(b, range).map((s) => b.getText(s.from, s.to)).join('\n');
  return b.getText(range.from, range.to);
}

// ---------------------------------------------------------------------------
// Operator-pending state

let pending = null; // { op, count, register }

export const operatorPending = () => pending;

export function cancelOperator(b = cur()) {
  pending = null;
  if (b?.state === 'operator') setState(b, 'normal');
}

function combinedCount(...counts) {
  const given = counts.filter((c) => c !== null && c !== undefined);
  return given.length ? given.reduce((a, c) => a * c, 1) : null;
}

async function applyOperator(b, p, range) {
  pending = null;
  if (b.state === 'operator') setState(b, 'normal');
  const op = operators.get(p.op);
  await op.fn(range, { buf: b, register: p.register, count: p.count });
}

// ---------------------------------------------------------------------------
// Motions

const motions = new Map();

/**
 * Define a motion. `fn(count, ctx)` returns the target offset (or { pos, type }), or
 * null if the motion fails. count is null when none was given.
 * ctx = { buf, start, operator } (operator: the pending operator's name, if any).
 * opts: { type: 'exclusive' | 'inclusive' | 'line', jump, doc }
 */
export function defmotion(name, opts, fn) {
  motions.set(name, { opts, fn });
  defcommand(name, { doc: opts.doc ?? `Motion: ${name}.` }, () => runMotion(name));
  return name;
}

export const motionInfo = (name) => motions.get(name) ?? null;

async function runMotion(name) {
  const { opts, fn } = motions.get(name);
  const b = cur();
  if (pending && b.state === 'operator') {
    const p = pending;
    const count = combinedCount(p.count, prefix.count);
    const start = b.point.pos;
    let res;
    try {
      res = await fn(count, { buf: b, start, operator: p.op });
    } catch (e) {
      cancelOperator(b);
      throw e;
    }
    if (res === null || res === undefined || res.handled) { cancelOperator(b); throw motionFailed(); }
    const target = typeof res === 'number' ? res : res.pos;
    const type = (typeof res === 'object' && res.type) || opts.type || 'exclusive';
    if (opts.jump) pushJump(b);
    return applyOperator(b, p, rangeFromMotion(b, start, target, type));
  }
  const res = await fn(prefix.count, { buf: b, start: b.point.pos });
  if (res === null || res === undefined) throw motionFailed();
  if (res.handled) return; // the motion moved (e.g. to a mark in another buffer) itself
  const target = typeof res === 'number' ? res : res.pos;
  if (opts.jump && target !== b.point.pos) pushJump(b);
  b.goto(target);
}

// ---------------------------------------------------------------------------
// Operators

const operators = new Map();

/**
 * Define an operator. `fn(range, ctx)` acts on the range.
 * range = { type: 'char'|'line'|'block', from, to, startLine?, endLine?, startV?, endV? }
 * ctx = { buf, register, count, visual }
 */
export function defoperator(name, opts, fn) {
  operators.set(name, { opts, fn });
  defcommand(name, { doc: opts.doc ?? `Operator: ${name}.` }, () => runOperator(name));
  return name;
}

export const operatorInfo = (name) => operators.get(name) ?? null;

async function runOperator(name) {
  const b = cur();
  const op = operators.get(name);
  if (b.state === 'visual') {
    const range = visualRange(b);
    const ctx = { buf: b, register: prefix.register, count: prefix.count, visual: true };
    exitVisual(b);
    return op.fn(range, ctx);
  }
  if (b.state === 'operator' && pending) {
    if (pending.op !== name) { cancelOperator(b); return; }
    return operatorLine(b);
  }
  pending = { op: name, count: prefix.count, register: prefix.register };
  setState(b, 'operator');
}

/** dd, yy, cc, >>, g~~: apply the pending operator to [count] whole lines. */
export function operatorLine(b = cur()) {
  if (!pending) return;
  const p = pending;
  const n = combinedCount(p.count, prefix.count) ?? 1;
  const line = b.lineAt();
  return applyOperator(b, p, lineRange(b, line, Math.min(b.lineCount - 1, line + n - 1)));
}

// ---------------------------------------------------------------------------
// Text objects

const textObjects = new Map();

/**
 * Define a text object. `fn(count, ctx)` returns { from, to, type } or null.
 * ctx = { buf, start, visual } (visual: the current selection range, if any).
 */
export function deftextobject(name, opts, fn) {
  textObjects.set(name, { opts, fn });
  defcommand(name, { doc: opts.doc ?? `Text object: ${name}.` }, () => runTextObject(name));
  return name;
}

async function runTextObject(name) {
  const { fn } = textObjects.get(name);
  const b = cur();
  if (pending && b.state === 'operator') {
    const p = pending;
    const count = combinedCount(p.count, prefix.count) ?? 1;
    const r = await fn(count, { buf: b, start: b.point.pos });
    if (!r) { cancelOperator(b); throw motionFailed(); }
    // Line objects give `to` as the end of their last line.
    const range = r.type === 'line' ? lineRange(b, b.lineAt(r.from), b.lineAt(r.to)) : charRange(r.from, r.to);
    return applyOperator(b, p, range);
  }
  if (b.state === 'visual') {
    const r = await fn(prefix.count ?? 1, { buf: b, start: b.point.pos, visual: visualRange(b) });
    if (!r) throw motionFailed();
    const v = vimState(b).visual;
    if (r.type === 'line' && v.type === 'char') v.type = 'line';
    v.anchor.set(r.from);
    b.goto(r.type === 'line' ? r.to : Math.max(r.from, r.to - 1));
    return;
  }
  throw motionFailed();
}

// ---------------------------------------------------------------------------
// Visual state

export function enterVisual(b, type, anchorPos = b.point.pos) {
  const v = vimState(b);
  if (v.visual) {
    v.visual.type = type;
  } else {
    v.visual = { type, anchor: new Marker(b, anchorPos), toEol: false };
  }
  setState(b, 'visual');
  updateVisualOverlays(b);
}

export function exitVisual(b) {
  const v = vimState(b);
  if (v.visual) {
    const r = visualRange(b);
    v.lastVisual?.anchor.detach();
    v.lastVisual?.point.detach();
    v.lastVisual = { type: v.visual.type, anchor: new Marker(b, v.visual.anchor.pos), point: new Marker(b, b.point.pos), toEol: v.visual.toEol };
    setMark(b, '<', r.from);
    setMark(b, '>', Math.max(r.from, r.to - 1));
    v.visual.anchor.detach();
    v.visual = null;
  }
  updateVisualOverlays(b);
  if (b.state === 'visual') setState(b, 'normal');
}

/** The selection as a range. */
export function visualRange(b) {
  const v = vimState(b).visual;
  const a = v.anchor.pos;
  const p = b.point.pos;
  if (v.type === 'line') return lineRange(b, b.lineAt(Math.min(a, p)), b.lineAt(Math.max(a, p)));
  if (v.type === 'block') {
    const tw = getVarOr('tab-width', 4, b);
    const pa = b.posAt(a);
    const pp = b.posAt(p);
    const ta = b.lineText(pa.line);
    const tp = b.lineText(pp.line);
    const va = visualColumn(ta, pa.col, tw);
    const vp = visualColumn(tp, pp.col, tw);
    const endV = va >= vp ? va + cellWidthAt(ta, pa.col, tw) : vp + cellWidthAt(tp, pp.col, tw);
    const range = {
      type: 'block',
      startLine: Math.min(pa.line, pp.line),
      endLine: Math.max(pa.line, pp.line),
      startV: Math.min(va, vp),
      endV: v.toEol ? Infinity : endV,
    };
    const segs = blockSegments(b, range);
    range.from = segs[0].from;
    range.to = segs.at(-1).to;
    return range;
  }
  const from = Math.min(a, p);
  return charRange(from, Math.min(b.length, Math.max(a, p) + 1));
}

export function updateVisualOverlays(b) {
  const v = vimState(b);
  for (const ov of v.overlays) deleteOverlay(ov);
  v.overlays = [];
  if (!v.visual || b.state !== 'visual') return;
  const r = visualRange(b);
  if (r.type === 'block') {
    for (const s of blockSegments(b, r)) {
      if (s.to > s.from) v.overlays.push(makeOverlay(b, s.from, s.to, { face: 'region', priority: 50 }));
    }
  } else if (r.type === 'line') {
    v.overlays.push(makeOverlay(b, r.from, r.to, { face: 'region', lineFace: 'region-line', priority: 50 }));
  } else {
    v.overlays.push(makeOverlay(b, r.from, r.to, { face: 'region', priority: 50 }));
  }
}

// ---------------------------------------------------------------------------
// Marks and jumps

export function setMark(b, name, pos) {
  const v = vimState(b);
  v.marks.get(name)?.detach();
  v.marks.set(name, new Marker(b, pos));
}

const globalMarks = new Map(); // 'A'-'Z' -> Marker (in any buffer)

export function setGlobalMark(name, b, pos) {
  globalMarks.get(name)?.detach();
  globalMarks.set(name, new Marker(b, pos));
}

/** { buffer, pos } for a mark, or null. */
export function getMark(b, name) {
  if (/^[A-Z]$/.test(name)) {
    const m = globalMarks.get(name);
    return m?.buffer?.live ? { buffer: m.buffer, pos: m.pos } : null;
  }
  const v = vimState(b);
  if (name === '`' || name === "'") return v.lastJump?.buffer ? { buffer: b, pos: v.lastJump.pos } : null;
  if (name === '.' && v.lastInsertPos?.buffer) return { buffer: b, pos: v.lastInsertPos.pos };
  const m = v.marks.get(name);
  return m?.buffer ? { buffer: b, pos: m.pos } : null;
}

export function allMarks(b) {
  const out = [];
  for (const [k, m] of vimState(b).marks) if (m.buffer) out.push([k, b, m.pos]);
  for (const [k, m] of globalMarks) if (m.buffer?.live) out.push([k, m.buffer, m.pos]);
  return out.sort((x, y) => x[0].localeCompare(y[0]));
}

const jumps = [];   // { buffer, marker }
let jumpPos = 0;    // index into jumps; === jumps.length when at the newest position

/** Record the current position before a jump (for C-o, C-i, `` and ''). */
export function pushJump(b = cur()) {
  const v = vimState(b);
  v.lastJump?.detach();
  v.lastJump = new Marker(b, b.point.pos);
  jumps.splice(jumpPos);
  const last = jumps.at(-1);
  if (!(last && last.buffer === b && b.lineAt(last.marker.pos) === b.lineAt())) {
    jumps.push({ buffer: b, marker: new Marker(b, b.point.pos) });
  }
  while (jumps.length > 100) jumps.shift().marker.detach();
  jumpPos = jumps.length;
}

/** Move `n` steps in the jump list (negative = older). Returns { buffer, pos } or null. */
export function jumpStep(n, b = cur()) {
  if (n < 0 && jumpPos === jumps.length) {
    jumps.push({ buffer: b, marker: new Marker(b, b.point.pos) });
    jumpPos = jumps.length - 1;
  }
  let i = jumpPos + n;
  while (i >= 0 && i < jumps.length && !jumps[i].buffer.live) i += Math.sign(n);
  if (i < 0 || i >= jumps.length) return null;
  jumpPos = i;
  return { buffer: jumps[i].buffer, pos: jumps[i].marker.pos };
}

// ---------------------------------------------------------------------------
// Insert sessions

/**
 * Enter insert state. kind: 'i' (plain), 'o'/'O' (count repeats lines), 'replace'.
 * block: { startLine, endLine, v, append } to replicate the insertion down a block.
 */
export function enterInsert(b, { count = 1, kind = 'i', block = null } = {}) {
  const v = vimState(b);
  v.insert?.start.detach();
  v.insert = { start: new Marker(b, b.point.pos), count: count ?? 1, kind, block };
  setState(b, kind === 'replace' ? 'replace' : 'insert');
}

/** Leave insert/replace state: repeat for counts, replicate block inserts, close the undo group. */
export function finishInsert(b) {
  const v = vimState(b);
  const s = v.insert;
  v.insert = null;
  if (s) {
    const end = b.point.pos;
    const text = end >= s.start.pos ? b.getText(s.start.pos, end) : '';
    if (text) setReadOnlyRegister('.', text);
    if (text && s.count > 1) {
      if (s.kind === 'o' || s.kind === 'O') {
        for (let i = 1; i < s.count; i++) {
          b.goto(b.lineEnd(b.lineAt()));
          b.insert(`\n${text}`);
        }
      } else if (s.kind !== 'replace') {
        b.insert(text.repeat(s.count - 1));
      }
    }
    if (s.block && text && !text.includes('\n')) replicateBlockInsert(b, s.block, text);
    s.start.detach();
    v.lastInsertPos?.detach();
    v.lastInsertPos = new Marker(b, b.point.pos);
  }
}

function replicateBlockInsert(b, block, text) {
  const tw = getVarOr('tab-width', 4, b);
  const keep = b.point.pos;
  for (let line = block.startLine + 1; line <= block.endLine; line++) {
    const lineText = b.lineText(line);
    const width = visualColumn(lineText, lineText.length, tw);
    let at;
    if (block.toEol) {
      at = b.lineEnd(line);
    } else if (width < block.v) {
      if (!block.append) continue; // I skips lines too short to reach the block
      b.insertText(b.lineEnd(line), ' '.repeat(block.v - width));
      at = b.lineEnd(line);
    } else {
      at = b.lineStart(line) + columnForVisual(lineText, block.v, tw);
    }
    b.insertText(at, text);
  }
  b.goto(keep);
}

// ---------------------------------------------------------------------------
// Dot-repeat

let recording = null; // { count, register, keys: [...], valid }
let lastChange = null;
let replaying = false;
const repeatable = new Set();

/** Mark commands that start a repeatable change (operators are added automatically). */
export function markRepeatable(...names) { for (const n of names) repeatable.add(n); }

const ignoredWhileRecording = (name) => name.startsWith('helm-') || name === 'vim-repeat';

addHook('pre-command-hook', function vimRecordChange(name, args, keys) {
  const b = cur();
  if (!b) return;
  if (!recording) {
    if (b.state !== 'normal') return;
    if (!repeatable.has(name) && !operators.has(name)) return;
    if (name === 'vim-yank' || name === 'vim-yank-line') return;
    recording = { count: prefix.count, register: prefix.register, keys: [], valid: true };
  }
  if (ignoredWhileRecording(name)) return;
  if (name === 'self-insert-command') recording.keys.push({ text: args[0] });
  else if (name === 'vim-digit-argument' || (name === 'vim-digit-argument-or-beginning-of-line' && prefix.count !== null)) {
    for (const k of keys) recording.keys.push({ key: k, count: true });
  } else for (const k of keys) recording.keys.push(k);
});

addHook('read-char-hook', function vimRecordChar(key) {
  if (recording) recording.keys.push(key);
});

/** Called by commands that prompt (search, ex): their input can't be replayed. */
export function invalidateRecording() {
  if (recording) recording.valid = false;
}

addHook('post-command-hook', function vimFinishRecording() {
  const b = cur();
  if (!recording || !b) return;
  if (b.state === 'normal' && !pending) {
    if (recording.valid && recording.keys.length) lastChange = recording;
    recording = null;
  } else if (b.state === 'visual') {
    recording = null; // visual-mode changes are not repeatable
  }
});

defcommand('vim-repeat', { doc: 'Repeat the last change (.). A count replaces the original count.' }, async () => {
  if (!lastChange || replaying) return;
  const change = lastChange;
  const count = prefix.count;
  replaying = true;
  try {
    prefix.count = count ?? change.count;
    prefix.register = change.register;
    const keys = change.keys
      .filter((k) => !(count !== null && typeof k === 'object' && k.count))
      .map((k) => (typeof k === 'object' && k.key ? k.key : k));
    await executeKeys(keys);
  } finally {
    replaying = false;
  }
});

// ---------------------------------------------------------------------------
// Hooks

// Undo: one boundary per normal-state command, none inside an insert session or while
// an operator waits for its motion, so a whole change undoes as one step.
addHook('pre-command-hook', function vimUndoBoundary() {
  const b = cur();
  if (!b) return;
  if (b.state === 'insert' || b.state === 'replace' || b.state === 'operator') return;
  undoBoundary(b);
});

/** In normal state the cursor sits on a character, never past the end of a non-empty line. */
export function clampNormal(b) {
  if (b.state !== 'normal' && b.state !== 'operator') return;
  const line = b.lineAt();
  const text = b.lineText(line);
  const start = b.lineStart(line);
  if (text.length && b.point.pos - start >= text.length) b.goto(start + text.length - 1);
}

const KEEPS_BLOCK_EOL = new Set(['vim-end-of-line', 'vim-next-line', 'vim-previous-line', 'vim-digit-argument']);

addHook('post-command-hook', function vimPostCommand(name) {
  if (prefix.keep) prefix.keep = false;
  else { prefix.count = null; prefix.register = null; }
  const b = cur();
  if (!b) return;
  const v = vimState(b).visual;
  if (v && v.type === 'block') v.toEol = name === 'vim-end-of-line' || (v.toEol && KEEPS_BLOCK_EOL.has(name));
  clampNormal(b);
  if (b.state === 'visual' || vimState(b).overlays.length) updateVisualOverlays(b);
});

addHook('mouse-set-point-hook', function vimAfterClick() {
  const b = cur();
  if (!b) return;
  if (b.state === 'visual') exitVisual(b);
  if (b.state === 'operator') cancelOperator(b);
  clampNormal(b);
});

addHook('mouse-drag-hook', function vimMouseDrag(win, start, pos) {
  const b = win.buffer;
  if (b.state !== 'visual') enterVisual(b, 'char', start);
  b.goto(pos);
  updateVisualOverlays(b);
  scheduleRedisplay();
});

addHook('unbound-key-hook', function vimCancelOnUnbound(key, b) {
  if (b?.state === 'operator') cancelOperator(b);
});

export { getBuffer, executeKeys };
