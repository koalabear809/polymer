// Buffers: text + point + markers + overlays + undo + local state.

import { runHooks, setCurrentBufferProvider, defvar, getVarOr } from './registry.js';
import { scheduleRedisplay } from './redisplay.js';
import { PolymerError } from './errors.js';
import { Text } from './text.js';
import { Marker, adjustMarkersForInsert, adjustMarkersForDelete } from './marker.js';
import { initUndo, recordChange } from './undo.js';

defvar('inhibit-read-only', false, { doc: 'When true, read-only buffers can be modified.' });

const buffers = new Map(); // name -> Buffer
let recency = [];          // most recently selected first
let current = null;

export class Buffer {
  constructor(name) {
    this.name = name;
    this.text = new Text('');
    this.version = 0;            // increments on any change (text, overlays, props)
    this.textVersion = 0;        // increments on text changes only
    this.markers = new Set();
    this.overlays = new Set();
    this.decorators = [];        // (buf, line, lineStart, lineText) => [{ from, to, face, priority }]
    this.point = new Marker(this, 0);
    this.mark = null;            // Marker or null
    this.mode = 'fundamental-mode';
    this.minorModes = new Set();
    this.locals = new Map();     // buffer-local variable values
    this.keymap = null;          // optional buffer-local keymap name
    this.state = 'normal';       // vim state
    this.readOnly = false;
    this.readOnlyBefore = null;  // Marker: text before it is read-only (comint-style input areas)
    this.modified = false;
    this.file = null;            // visited file path
    this.fileInfo = null;        // { crlf, mtimeMs }
    this.live = true;
    initUndo(this);
  }

  // ----- reading

  get length() { return this.text.length; }
  getText(from, to) { return this.text.slice(from, to); }
  toString() { return `#<buffer ${this.name}>`; }

  // ----- editing

  checkWritable(opts, pos) {
    if (opts?.inhibitReadOnly || runtimeInhibitReadOnly()) return;
    if (this.readOnly) throw new PolymerError('buffer-read-only', `Buffer is read-only: ${this.name}`);
    if (pos !== undefined && this.readOnlyBefore?.buffer && pos < this.readOnlyBefore.pos) {
      throw new PolymerError('text-read-only', 'Text is read-only');
    }
  }

  /** Insert `str` at `offset`. Options: { inhibitReadOnly, undo: true }. */
  insertText(offset, str, opts = {}) {
    if (!str) return offset;
    offset = this.text.clamp(offset);
    this.checkWritable(opts, offset);
    runHooks('before-change-functions', this, offset, offset);
    this.text.insert(offset, str);
    adjustMarkersForInsert(this, offset, str.length);
    if (opts.undo !== false) recordChange(this, { from: offset, removed: '', inserted: str });
    this.changed(offset, offset + str.length, 0);
    return offset + str.length;
  }

  /** Delete [from, to). Returns the removed text. */
  deleteText(from, to, opts = {}) {
    if (from > to) [from, to] = [to, from];
    from = this.text.clamp(from);
    to = this.text.clamp(to);
    if (from === to) return '';
    from = this.editableFrom(from, to, opts);
    this.checkWritable(opts, from);
    runHooks('before-change-functions', this, from, to);
    const removed = this.text.delete(from, to);
    adjustMarkersForDelete(this, from, to);
    if (opts.undo !== false) recordChange(this, { from, removed, inserted: '' });
    this.changed(from, from, removed.length);
    return removed;
  }

  /**
   * In an input area, a change that reaches back into the read-only text applies only to
   * the editable part (e.g. dd on the last input line, which would take the newline before
   * it). Returns where that part starts.
   */
  editableFrom(from, to, opts = {}) {
    const ro = this.readOnlyBefore?.buffer ? this.readOnlyBefore.pos : 0;
    return from < ro && to > ro && !opts.inhibitReadOnly && !runtimeInhibitReadOnly() ? ro : from;
  }

  replaceText(from, to, str, opts = {}) {
    if (from > to) [from, to] = [to, from];
    from = this.editableFrom(from, to, opts);
    this.deleteText(from, to, opts);
    return this.insertText(from, str, opts);
  }

  /** Insert at point and move point after the text. */
  insert(str) {
    const end = this.insertText(this.point.pos, str);
    this.point.set(end);
    return end;
  }

  /**
   * Replace the whole text. Programmatic: ignores read-only, doesn't record undo,
   * and resets undo history unless { keepUndo: true }.
   */
  setText(str, { keepUndo = false } = {}) {
    runHooks('before-change-functions', this, 0, this.text.length);
    const oldLen = this.text.length;
    this.text = new Text(str);
    for (const m of this.markers) m.pos = Math.min(m.pos, this.text.length);
    if (!keepUndo) initUndo(this);
    this.changed(0, str.length, oldLen, { setModified: false });
  }

  /** Append text at the end (programmatic, like setText). */
  append(str) {
    if (!str) return;
    const at = this.text.length;
    this.insertText(at, str, { inhibitReadOnly: true, undo: false });
  }

  changed(from, to, oldLen, { setModified = true } = {}) {
    this.textVersion++;
    if (setModified && !this.modified) {
      this.modified = true;
      runHooks('first-change-hook', this);
    }
    runHooks('after-change-functions', this, from, to, oldLen);
    this.touch();
  }

  touch() {
    this.version++;
    scheduleRedisplay();
  }

  // ----- positions

  get pointPos() { return this.point.pos; }
  goto(pos) { this.point.set(pos); return this.point.pos; }
  posAt(offset) { return this.text.posAt(offset); }
  offsetAt(line, col) { return this.text.offsetAt(line, col); }
  lineAt(offset = this.point.pos) { return this.text.lineAt(offset); }
  lineStart(line) { return this.text.lineStart(line); }
  lineEnd(line) { return this.text.lineEnd(line); }
  lineText(line) { return this.text.line(line); }
  get lineCount() { return this.text.lineCount; }
}

function runtimeInhibitReadOnly() {
  return !!getVarOr('inhibit-read-only', false, null);
}

export function getBuffer(nameOrBuffer) {
  if (nameOrBuffer instanceof Buffer) return nameOrBuffer.live ? nameOrBuffer : null;
  return buffers.get(nameOrBuffer) ?? null;
}

/** Return the named buffer, creating it if it doesn't exist. */
export function getBufferCreate(name) {
  let b = buffers.get(name);
  if (!b) {
    b = new Buffer(name);
    buffers.set(name, b);
    recency.push(b);
    runHooks('buffer-list-update-hook');
  }
  return b;
}

/** A name not already taken: "name", "name<2>", "name<3>", ... */
export function generateNewBufferName(name) {
  if (!buffers.has(name)) return name;
  for (let i = 2; ; i++) if (!buffers.has(`${name}<${i}>`)) return `${name}<${i}>`;
}

export function generateNewBuffer(name) {
  return getBufferCreate(generateNewBufferName(name));
}

/** Buffers, most recently selected first. Names starting with a space are hidden unless `all`. */
export function bufferList({ all = false } = {}) {
  return recency.filter((b) => all || !b.name.startsWith(' '));
}

export function currentBuffer() { return current; }

/** Make `buf` current (does not change which buffer windows show). */
export function setBuffer(buf) {
  const b = getBuffer(buf);
  if (!b) throw new PolymerError('error', `No such buffer: ${buf}`);
  current = b;
  return b;
}

/** Record that `buf` was selected, for buffer-list ordering. */
export function bumpBuffer(buf) {
  recency = [buf, ...recency.filter((b) => b !== buf)];
}

/** Run `fn` with `buf` temporarily current. */
export function withBuffer(buf, fn) {
  const prev = current;
  current = getBuffer(buf);
  try {
    return fn(current);
  } finally {
    current = prev;
  }
}

/** The live buffer visiting `path`, if any. */
export function findBufferVisiting(path) {
  for (const b of buffers.values()) if (b.file === path) return b;
  return null;
}

export function killBufferInternal(buf) {
  const b = getBuffer(buf);
  if (!b) return false;
  runHooks('kill-buffer-hook', b);
  b.live = false;
  for (const m of [...b.markers]) m.detach();
  b.overlays.clear();
  buffers.delete(b.name);
  recency = recency.filter((x) => x !== b);
  if (current === b) current = recency[0] ?? null;
  runHooks('buffer-list-update-hook');
  scheduleRedisplay();
  return true;
}

export function renameBuffer(buf, newName) {
  const b = getBuffer(buf);
  if (buffers.has(newName)) throw new PolymerError('error', `Buffer name "${newName}" is in use`);
  buffers.delete(b.name);
  b.name = newName;
  buffers.set(newName, b);
  b.touch();
}

setCurrentBufferProvider(() => current);
