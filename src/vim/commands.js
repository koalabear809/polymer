// Vim operators and normal/visual/insert state commands.

import { defcommand, getVarOr, call } from '../core/registry.js';
import { readChar, keyText, thisCommandKeysString } from '../core/command-loop.js';
import { undo, redo, undoBoundary } from '../core/undo.js';
import { selectedWindow, setWindowBuffer, scrollWindow } from '../core/window.js';
import { viewMetrics, visibleLineCount } from '../core/view.js';
import { visualColumn, columnForVisual, cellWidthAt } from '../core/width.js';
import { scheduleRedisplay } from '../core/redisplay.js';
import { message } from '../core/echo.js';
import { PolymerError } from '../core/errors.js';
import { storeRegister, getRegister, validRegister } from './registers.js';
import {
  cur, vimState, setState, prefix, addDigit, setPrefixRegister, defoperator, defmotion,
  rangeText, blockSegments, lineRange, charRange, firstNonBlank, firstNonBlankCol, enterInsert,
  finishInsert, enterVisual, exitVisual, visualRange, updateVisualOverlays, cancelOperator,
  operatorPending, operatorLine, setMark, setGlobalMark, getMark, jumpStep, motionFailed,
  markRepeatable, clampNormal,
} from './core.js';
import { prevWordStart } from './motions.js';

const tabWidth = (b) => getVarOr('tab-width', 4, b);
const count = (dflt = 1) => prefix.count ?? dflt;
const userError = (msg) => new PolymerError('user-error', msg);

// ---------------------------------------------------------------------------
// Range helpers

function linesOf(b, range) {
  if (range.type === 'line' || range.type === 'block') return [range.startLine, range.endLine];
  return [b.lineAt(range.from), b.lineAt(Math.max(range.from, range.to - 1))];
}

/** Delete a range into a register and place the cursor like Vim. */
export function deleteRange(b, range, register) {
  storeRegister(register, rangeText(b, range), range.type, 'delete');
  if (range.type === 'line') {
    const { startLine: s, endLine: e } = range;
    let from;
    let to;
    if (e < b.lineCount - 1) { from = b.lineStart(s); to = b.lineStart(e + 1); }
    else if (s > 0) { from = b.lineEnd(s - 1); to = b.lineEnd(e); }
    else { from = 0; to = b.length; }
    b.deleteText(from, to);
    b.goto(firstNonBlank(b, Math.min(s, b.lineCount - 1)));
  } else if (range.type === 'block') {
    const segs = blockSegments(b, range);
    for (let i = segs.length - 1; i >= 0; i--) b.deleteText(segs[i].from, segs[i].to);
    b.goto(segs[0].from);
  } else {
    b.deleteText(range.from, range.to);
    b.goto(range.from);
  }
}

/** Replace each piece of a range with f(text). */
function mapRange(b, range, f) {
  let segs;
  if (range.type === 'block') segs = blockSegments(b, range);
  else if (range.type === 'line') segs = [{ from: b.lineStart(range.startLine), to: b.lineEnd(range.endLine) }];
  else segs = [{ from: range.from, to: range.to }];
  for (let i = segs.length - 1; i >= 0; i--) {
    const t = b.getText(segs[i].from, segs[i].to);
    const n = f(t);
    if (n !== t) b.replaceText(segs[i].from, segs[i].to, n);
  }
  b.goto(range.type === 'line' ? b.lineStart(range.startLine) + Math.min(b.posAt(range.from).col, b.lineText(range.startLine).length) : range.from);
}

const toggleCase = (t) => [...t].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('');

/** Shift lines s..e right (dir 1) or left (dir -1) by `times` shift widths. */
export function shiftLines(b, s, e, dir, times = 1) {
  const sw = getVarOr('vim-shift-width', 4, b);
  const tw = tabWidth(b);
  const tabs = getVarOr('indent-tabs-mode', false, b);
  for (let l = s; l <= e; l++) {
    const text = b.lineText(l);
    if (!text.trim() && dir > 0) continue;
    const ws = /^[ \t]*/.exec(text)[0];
    const width = visualColumn(ws, ws.length, tw);
    const target = Math.max(0, width + dir * sw * times);
    const indent = tabs ? '\t'.repeat(Math.floor(target / tw)) + ' '.repeat(target % tw) : ' '.repeat(target);
    if (indent !== ws) b.replaceText(b.lineStart(l), b.lineStart(l) + ws.length, indent);
  }
}

// ---------------------------------------------------------------------------
// Operators

defoperator('vim-delete', { doc: 'Delete (d).' }, (range, { buf, register }) => deleteRange(buf, range, register));

defoperator('vim-yank', { doc: 'Yank (y).' }, (range, { buf, register }) => {
  storeRegister(register, rangeText(buf, range), range.type, 'yank');
  if (range.type === 'line') {
    if (range.startLine < buf.lineAt()) buf.goto(buf.offsetAt(range.startLine, buf.posAt(buf.point.pos).col));
    const n = range.endLine - range.startLine + 1;
    if (n > 2) message('%d lines yanked', n);
  } else {
    buf.goto(range.from);
  }
});

defoperator('vim-change', { doc: 'Change (c).' }, (range, { buf, register }) => {
  buf.checkWritable();
  if (range.type === 'line') {
    storeRegister(register, rangeText(buf, range), 'line', 'delete');
    const indent = getVarOr('electric-indent-mode', true, buf) ? /^[ \t]*/.exec(buf.lineText(range.startLine))[0] : '';
    buf.replaceText(buf.lineStart(range.startLine), buf.lineEnd(range.endLine), indent);
    buf.goto(buf.lineStart(range.startLine) + indent.length);
    enterInsert(buf);
  } else if (range.type === 'block') {
    deleteRange(buf, range, register);
    enterInsert(buf, { block: { startLine: range.startLine, endLine: range.endLine, v: range.startV, append: false } });
  } else {
    storeRegister(register, rangeText(buf, range), 'char', 'delete');
    buf.deleteText(range.from, range.to);
    buf.goto(range.from);
    enterInsert(buf);
  }
});

defoperator('vim-shift-right', { doc: 'Indent lines (>).' }, (range, { buf, count: n, visual }) => {
  const [s, e] = linesOf(buf, range);
  shiftLines(buf, s, e, 1, visual ? n ?? 1 : 1);
  buf.goto(firstNonBlank(buf, s));
});

defoperator('vim-shift-left', { doc: 'Unindent lines (<).' }, (range, { buf, count: n, visual }) => {
  const [s, e] = linesOf(buf, range);
  shiftLines(buf, s, e, -1, visual ? n ?? 1 : 1);
  buf.goto(firstNonBlank(buf, s));
});

defoperator('vim-invert-case', { doc: 'Toggle case (g~).' }, (range, { buf }) => mapRange(buf, range, toggleCase));
defoperator('vim-downcase', { doc: 'Lowercase (gu).' }, (range, { buf }) => mapRange(buf, range, (t) => t.toLowerCase()));
defoperator('vim-upcase', { doc: 'Uppercase (gU).' }, (range, { buf }) => mapRange(buf, range, (t) => t.toUpperCase()));

// g~~ / guu / gUU: the second key repeats the operator linewise.
defcommand('vim-operator-line-case', { doc: 'In operator-pending state, apply g~/gu/gU to whole lines.' }, () => {
  const p = operatorPending();
  const key = thisCommandKeysString().split(' ').at(-1);
  const expected = { '~': 'vim-invert-case', u: 'vim-downcase', U: 'vim-upcase' }[key];
  if (p && p.op === expected) return operatorLine();
  cancelOperator();
});

// ---------------------------------------------------------------------------
// Single-key changes

defcommand('vim-delete-char', { doc: 'Delete [count] characters under the cursor (x).' }, () => {
  const b = cur();
  const { line } = b.posAt(b.point.pos);
  const end = Math.min(b.lineEnd(line), b.point.pos + count());
  if (end <= b.point.pos) throw motionFailed();
  deleteRange(b, charRange(b.point.pos, end), prefix.register);
});

defcommand('vim-delete-backward-char', { doc: 'Delete [count] characters before the cursor (X).' }, () => {
  const b = cur();
  const start = Math.max(b.lineStart(b.lineAt()), b.point.pos - count());
  if (start >= b.point.pos) throw motionFailed();
  deleteRange(b, charRange(start, b.point.pos), prefix.register);
});

defcommand('vim-substitute', { doc: 'Delete [count] characters and insert (s).' }, () => {
  const b = cur();
  b.checkWritable();
  const end = Math.min(b.lineEnd(b.lineAt()), b.point.pos + count());
  if (end > b.point.pos) storeRegister(prefix.register, b.getText(b.point.pos, end), 'char', 'delete');
  b.deleteText(b.point.pos, end);
  enterInsert(b);
});

defcommand('vim-change-whole-line', { doc: 'Change [count] whole lines (S, cc).' }, () => {
  const b = cur();
  const line = b.lineAt();
  return call('vim-change-range', lineRange(b, line, Math.min(b.lineCount - 1, line + count() - 1)));
});

defcommand('vim-change-line', { doc: 'Change to the end of the line (C).' }, () => {
  const b = cur();
  const last = Math.min(b.lineCount - 1, b.lineAt() + count() - 1);
  return call('vim-change-range', charRange(b.point.pos, b.lineEnd(last)));
});

defcommand('vim-delete-line', { doc: 'Delete to the end of the line (D).' }, () => {
  const b = cur();
  const last = Math.min(b.lineCount - 1, b.lineAt() + count() - 1);
  deleteRange(b, charRange(b.point.pos, b.lineEnd(last)), prefix.register);
});

defcommand('vim-yank-line', { doc: 'Yank to the end of the line (Y), or whole lines if vim-want-Y-yank-to-eol is false.' }, () => {
  const b = cur();
  const line = b.lineAt();
  const last = Math.min(b.lineCount - 1, line + count() - 1);
  if (getVarOr('vim-want-Y-yank-to-eol', true, b)) {
    storeRegister(prefix.register, b.getText(b.point.pos, b.lineEnd(last)), 'char', 'yank');
  } else {
    storeRegister(prefix.register, rangeText(b, lineRange(b, line, last)), 'line', 'yank');
  }
});

/** Shared by S/C/cc: change a given range. */
defcommand('vim-change-range', { doc: 'Change a range (internal).' }, (range) => {
  const b = cur();
  const reg = prefix.register;
  b.checkWritable();
  if (range.type === 'line') {
    storeRegister(reg, rangeText(b, range), 'line', 'delete');
    const indent = getVarOr('electric-indent-mode', true, b) ? /^[ \t]*/.exec(b.lineText(range.startLine))[0] : '';
    b.replaceText(b.lineStart(range.startLine), b.lineEnd(range.endLine), indent);
    b.goto(b.lineStart(range.startLine) + indent.length);
  } else {
    if (range.to > range.from) storeRegister(reg, b.getText(range.from, range.to), 'char', 'delete');
    b.deleteText(range.from, range.to);
    b.goto(range.from);
  }
  enterInsert(b);
});

defcommand('vim-replace', { doc: 'Replace [count] characters with the next one typed (r).' }, async () => {
  const b = cur();
  const n = count();
  const ch = keyText(await readChar());
  b.checkWritable();
  if (b.state === 'visual') {
    const range = visualRange(b);
    exitVisual(b);
    mapRange(b, range, (t) => t.replace(/[^\n]/g, ch));
    return;
  }
  const { line, col } = b.posAt(b.point.pos);
  if (col + n > b.lineText(line).length) throw motionFailed();
  const p = b.point.pos;
  if (ch === '\n') {
    b.replaceText(p, p + n, '\n');
    b.goto(p + 1);
  } else {
    b.replaceText(p, p + n, ch.repeat(n));
    b.goto(p + n - 1);
  }
});

defcommand('vim-invert-char', { doc: 'Toggle the case of [count] characters and move right (~).' }, () => {
  const b = cur();
  if (b.state === 'visual') return call('vim-invert-case');
  const { line } = b.posAt(b.point.pos);
  const end = Math.min(b.lineEnd(line), b.point.pos + count());
  if (end <= b.point.pos) throw motionFailed();
  const p = b.point.pos;
  b.replaceText(p, end, toggleCase(b.getText(p, end)));
  b.goto(Math.min(end, b.lineEnd(line)));
});

function joinLines(b, line, joins, spaces) {
  let pos = null;
  for (let i = 0; i < joins; i++) {
    if (line >= b.lineCount - 1) break;
    const end = b.lineEnd(line);
    const curText = b.lineText(line);
    const next = b.lineText(line + 1);
    const lead = spaces ? /^[ \t]*/.exec(next)[0].length : 0;
    const rest = next.slice(lead);
    const sep = spaces && curText.length && !/[ \t]$/.test(curText) && rest.length && !rest.startsWith(')') ? ' ' : '';
    b.replaceText(end, end + 1 + lead, sep);
    pos = end;
  }
  if (pos === null) throw motionFailed();
  b.goto(pos);
}

defcommand('vim-join', { doc: 'Join [count] lines (J).' }, () => {
  const b = cur();
  if (b.state === 'visual') {
    const r = visualRange(b);
    exitVisual(b);
    const [s, e] = linesOf(b, r);
    return joinLines(b, s, Math.max(1, e - s), true);
  }
  joinLines(b, b.lineAt(), Math.max(1, count(2) - 1), true);
});

defcommand('vim-join-whitespace', { doc: 'Join lines without adding or removing spaces (gJ).' }, () => {
  const b = cur();
  if (b.state === 'visual') {
    const r = visualRange(b);
    exitVisual(b);
    const [s, e] = linesOf(b, r);
    return joinLines(b, s, Math.max(1, e - s), false);
  }
  joinLines(b, b.lineAt(), Math.max(1, count(2) - 1), false);
});

// ---------------------------------------------------------------------------
// Paste

async function paste(after) {
  const b = cur();
  const n = count();
  const name = prefix.register ?? '"';
  const r = await getRegister(name);
  if (!r || !r.text) throw userError(`Register ${name} is empty`);
  b.checkWritable();

  if (b.state === 'visual') return pasteOverSelection(b, r, n);

  if (r.type === 'line') {
    const text = (r.text.endsWith('\n') ? r.text : `${r.text}\n`).repeat(n);
    const line = b.lineAt();
    if (!after) {
      b.insertText(b.lineStart(line), text);
      b.goto(firstNonBlank(b, line));
    } else if (line === b.lineCount - 1) {
      b.insertText(b.length, `\n${text.slice(0, -1)}`);
      b.goto(firstNonBlank(b, line + 1));
    } else {
      b.insertText(b.lineStart(line + 1), text);
      b.goto(firstNonBlank(b, line + 1));
    }
  } else if (r.type === 'block') {
    pasteBlock(b, r.text.split('\n'), after, n);
  } else {
    const text = r.text.repeat(n);
    const lineText = b.lineText(b.lineAt());
    const at = after && lineText.length ? b.point.pos + 1 : b.point.pos;
    b.insertText(at, text);
    b.goto(text.includes('\n') ? at : at + text.length - 1);
  }
}

function pasteBlock(b, rows, after, n) {
  const tw = tabWidth(b);
  const { line, col } = b.posAt(b.point.pos);
  const lt = b.lineText(line);
  const v = visualColumn(lt, col, tw) + (after && lt.length ? cellWidthAt(lt, col, tw) : 0);
  const width = Math.max(...rows.map((r) => visualColumn(r, r.length, tw)));
  for (let i = 0; i < rows.length; i++) {
    const target = line + i;
    if (target >= b.lineCount) b.insertText(b.length, '\n');
    let t = b.lineText(target);
    const w = visualColumn(t, t.length, tw);
    if (w < v) { b.insertText(b.lineEnd(target), ' '.repeat(v - w)); t = b.lineText(target); }
    const row = n > 1 ? rows[i].padEnd(width, ' ').repeat(n) : rows[i];
    b.insertText(b.lineStart(target) + columnForVisual(t, v, tw), row);
  }
  b.goto(b.lineStart(line) + columnForVisual(b.lineText(line), v, tw));
}

function pasteOverSelection(b, r, n) {
  const range = visualRange(b);
  exitVisual(b);
  // The replaced text goes to the unnamed register (so you can swap two pieces of text).
  storeRegister(null, rangeText(b, range), range.type, 'delete');
  const text = r.text.repeat(n);
  if (range.type === 'line') {
    deleteRangeNoRegister(b, range);
    const line = Math.min(range.startLine, b.lineCount);
    const lineText = r.type === 'line' ? text : `${text}\n`;
    if (line >= b.lineCount || (range.startLine > 0 && range.startLine > b.lineCount - 1)) {
      b.insertText(b.length, `\n${lineText.replace(/\n$/, '')}`);
      b.goto(firstNonBlank(b, b.lineCount - 1));
    } else if (b.length === 0) {
      b.insertText(0, lineText.replace(/\n$/, ''));
      b.goto(0);
    } else {
      b.insertText(b.lineStart(line), lineText);
      b.goto(firstNonBlank(b, line));
    }
  } else {
    deleteRangeNoRegister(b, range);
    const at = range.from;
    const t = r.type === 'line' ? `\n${text}` : text;
    b.insertText(at, t);
    b.goto(r.type === 'line' ? at + 1 : Math.max(at, at + t.length - 1));
  }
}

function deleteRangeNoRegister(b, range) {
  deleteRange(b, range, '_');
}

defcommand('vim-paste-after', { doc: 'Paste after the cursor (p).' }, () => paste(true));
defcommand('vim-paste-before', { doc: 'Paste before the cursor (P).' }, () => paste(false));

/** Paste text from the system clipboard (Cmd-V outside insert state). */
defcommand('vim-paste-from-clipboard', { doc: 'Paste the given text after the cursor.' }, (text) => {
  const b = cur();
  b.checkWritable();
  if (b.state === 'visual') {
    pasteOverSelection(b, { text, type: text.endsWith('\n') ? 'line' : 'char' }, 1);
    return;
  }
  const lineText = b.lineText(b.lineAt());
  const at = lineText.length ? b.point.pos + 1 : b.point.pos;
  b.insertText(at, text);
  b.goto(Math.max(at, at + text.length - 1));
});

// ---------------------------------------------------------------------------
// Insert state entry

defcommand('vim-insert', { doc: 'Insert before the cursor (i).' }, () => {
  const b = cur();
  if (b.state === 'visual') return call('vim-visual-insert');
  enterInsert(b, { count: count() });
});

defcommand('vim-append', { doc: 'Insert after the cursor (a).' }, () => {
  const b = cur();
  if (b.state === 'visual') return call('vim-visual-append');
  const { line, col } = b.posAt(b.point.pos);
  if (col < b.lineText(line).length) b.goto(b.point.pos + 1);
  enterInsert(b, { count: count() });
});

defcommand('vim-insert-line', { doc: 'Insert before the first non-blank (I).' }, () => {
  const b = cur();
  b.goto(firstNonBlank(b, b.lineAt()));
  enterInsert(b, { count: count() });
});

defcommand('vim-append-line', { doc: 'Insert at the end of the line (A).' }, () => {
  const b = cur();
  b.goto(b.lineEnd(b.lineAt()));
  enterInsert(b, { count: count() });
});

defcommand('vim-open-below', { doc: 'Open a line below and insert (o).' }, () => {
  const b = cur();
  b.checkWritable();
  const line = b.lineAt();
  const indent = getVarOr('electric-indent-mode', true, b) ? /^[ \t]*/.exec(b.lineText(line))[0] : '';
  b.goto(b.lineEnd(line));
  b.insert(`\n${indent}`);
  enterInsert(b, { count: count(), kind: 'o' });
});

defcommand('vim-open-above', { doc: 'Open a line above and insert (O).' }, () => {
  const b = cur();
  b.checkWritable();
  const line = b.lineAt();
  const indent = getVarOr('electric-indent-mode', true, b) ? /^[ \t]*/.exec(b.lineText(line))[0] : '';
  const start = b.lineStart(line);
  b.insertText(start, `${indent}\n`);
  b.goto(start + indent.length);
  enterInsert(b, { count: count(), kind: 'O' });
});

defcommand('vim-insert-resume', { doc: 'Insert where insert state was last left (gi).' }, () => {
  const b = cur();
  const m = getMark(b, '.');
  if (m) b.goto(m.pos);
  enterInsert(b, { count: count() });
});

defcommand('vim-replace-state', { doc: 'Replace state: typed characters overwrite (R).' }, () => {
  enterInsert(cur(), { count: count(), kind: 'replace' });
});

defcommand('vim-normal-state', { doc: 'Return to normal state (Esc).' }, () => {
  const b = cur();
  if (b.state === 'insert' || b.state === 'replace') {
    finishInsert(b);
    setState(b, 'normal');
    undoBoundary(b);
    const { col } = b.posAt(b.point.pos);
    if (col > 0 && getVarOr('vim-move-cursor-back', true, b)) b.goto(b.point.pos - 1);
    return;
  }
  if (b.state === 'visual') return exitVisual(b);
  if (b.state === 'operator') return cancelOperator(b);
  call('vim-ex-nohighlight');
});

// ---------------------------------------------------------------------------
// Visual state

function toggleVisual(type) {
  const b = cur();
  if (b.state === 'visual') {
    const v = vimState(b).visual;
    if (v.type === type) return exitVisual(b);
    v.type = type;
    updateVisualOverlays(b);
    b.touch();
    return;
  }
  enterVisual(b, type);
}

defcommand('vim-visual-char', { doc: 'Characterwise visual state (v).' }, () => toggleVisual('char'));
defcommand('vim-visual-line', { doc: 'Linewise visual state (V).' }, () => toggleVisual('line'));
defcommand('vim-visual-block', { doc: 'Blockwise visual state (C-v).' }, () => toggleVisual('block'));

defcommand('vim-visual-restore', { doc: 'Reselect the last visual selection (gv).' }, () => {
  const b = cur();
  const last = vimState(b).lastVisual;
  if (!last) throw userError('No previous visual selection');
  const { type, anchor, point, toEol } = last;
  if (b.state === 'visual') exitVisual(b);
  enterVisual(b, type, anchor.pos);
  vimState(b).visual.toEol = toEol;
  b.goto(point.pos);
  updateVisualOverlays(b);
});

defcommand('vim-visual-exchange-corners', { doc: 'Move the cursor to the other end of the selection (o).' }, () => {
  const b = cur();
  const v = vimState(b).visual;
  if (!v) return;
  const a = v.anchor.pos;
  v.anchor.set(b.point.pos);
  b.goto(a);
  updateVisualOverlays(b);
});

defcommand('vim-visual-insert', { doc: 'Visual I: insert before the selection; on every line of a block.' }, () => {
  const b = cur();
  const r = visualRange(b);
  exitVisual(b);
  if (r.type === 'block') {
    b.goto(blockSegments(b, r)[0].from);
    enterInsert(b, { block: { startLine: r.startLine, endLine: r.endLine, v: r.startV, append: false } });
  } else {
    b.goto(r.type === 'line' ? firstNonBlank(b, r.startLine) : r.from);
    enterInsert(b);
  }
});

defcommand('vim-visual-append', { doc: 'Visual A: append after the selection; on every line of a block.' }, () => {
  const b = cur();
  const r = visualRange(b);
  exitVisual(b);
  if (r.type === 'block') {
    const toEol = r.endV === Infinity;
    const first = blockSegments(b, r)[0];
    b.goto(toEol ? b.lineEnd(r.startLine) : first.to);
    const tw = tabWidth(b);
    const t = b.lineText(r.startLine);
    // Pad the first line if it is shorter than the block.
    const w = visualColumn(t, t.length, tw);
    if (!toEol && w < r.endV) { b.insertText(b.lineEnd(r.startLine), ' '.repeat(r.endV - w)); b.goto(b.lineEnd(r.startLine)); }
    enterInsert(b, { block: { startLine: r.startLine, endLine: r.endLine, v: r.endV, append: true, toEol } });
  } else {
    b.goto(r.type === 'line' ? b.lineEnd(r.endLine) : r.to);
    enterInsert(b);
  }
});

defcommand('vim-visual-delete-lines', { doc: 'Visual D/X: delete the selected lines.' }, () => {
  const b = cur();
  const r = visualRange(b);
  exitVisual(b);
  const [s, e] = linesOf(b, r);
  deleteRange(b, r.type === 'block' ? { ...r, endV: Infinity } : lineRange(b, s, e), prefix.register);
});

defcommand('vim-visual-yank-lines', { doc: 'Visual Y: yank the selected lines.' }, () => {
  const b = cur();
  const r = visualRange(b);
  exitVisual(b);
  const [s, e] = linesOf(b, r);
  storeRegister(prefix.register, rangeText(b, lineRange(b, s, e)), 'line', 'yank');
  b.goto(firstNonBlank(b, s));
});

defcommand('vim-visual-change-lines', { doc: 'Visual S/R: change the selected lines.' }, () => {
  const b = cur();
  const r = visualRange(b);
  exitVisual(b);
  const [s, e] = linesOf(b, r);
  return call('vim-change-range', lineRange(b, s, e));
});

// ---------------------------------------------------------------------------
// Undo, counts, registers, marks, jumps

defcommand('vim-undo', { doc: 'Undo [count] changes (u).' }, () => {
  const b = cur();
  for (let i = 0; i < count(); i++) if (!undo(b)) { if (i === 0) throw userError('Already at oldest change'); break; }
});

defcommand('vim-redo', { doc: 'Redo [count] changes (C-r).' }, () => {
  const b = cur();
  for (let i = 0; i < count(); i++) if (!redo(b)) { if (i === 0) throw userError('Already at newest change'); break; }
});

defcommand('vim-digit-argument', { doc: 'Add a digit to the count.' }, () => {
  addDigit(Number(thisCommandKeysString().split(' ').at(-1)));
});

defcommand('vim-digit-argument-or-beginning-of-line', { doc: '0: a digit in a count, otherwise the first column.' }, () => {
  if (prefix.count !== null) return addDigit(0);
  return call('vim-beginning-of-line');
});

defcommand('vim-use-register', { doc: 'Use a register for the next command (").' }, async () => {
  const keep = prefix.count;
  const r = keyText(await readChar('"'));
  if (!validRegister(r)) throw userError(`Invalid register: ${r}`);
  prefix.count = keep;
  setPrefixRegister(r);
});

defcommand('vim-set-marker', { doc: 'Set a mark (m).' }, async () => {
  const b = cur();
  const c = keyText(await readChar());
  if (/^[a-z<>]$/.test(c)) setMark(b, c, b.point.pos);
  else if (/^[A-Z]$/.test(c)) setGlobalMark(c, b, b.point.pos);
  else throw userError(`Invalid mark: ${c}`);
});

async function markTarget(line) {
  const b = cur();
  const c = keyText(await readChar());
  const m = getMark(b, c);
  if (!m) throw userError(`Mark not set: ${c}`);
  if (m.buffer !== b) {
    if (b.state === 'operator') return null;
    setWindowBuffer(selectedWindow(), m.buffer);
    m.buffer.goto(line ? firstNonBlank(m.buffer, m.buffer.lineAt(m.pos)) : m.pos);
    return { handled: true };
  }
  return line ? firstNonBlank(b, b.lineAt(m.pos)) : m.pos;
}

defmotion('vim-goto-mark', { type: 'exclusive', jump: true, doc: 'Go to a mark (`).' }, () => markTarget(false));
defmotion('vim-goto-mark-line', { type: 'line', jump: true, doc: 'Go to the line of a mark (\').' }, () => markTarget(true));

function jump(n) {
  const b = cur();
  const j = jumpStep(n, b);
  if (!j) throw userError(n < 0 ? 'At the start of the jump list' : 'At the end of the jump list');
  if (j.buffer !== b) setWindowBuffer(selectedWindow(), j.buffer);
  j.buffer.goto(j.pos);
}

defcommand('vim-jump-backward', { doc: 'Go to an older position in the jump list (C-o).' }, () => jump(-count()));
defcommand('vim-jump-forward', { doc: 'Go to a newer position in the jump list (C-i).' }, () => jump(count()));

// ---------------------------------------------------------------------------
// Scrolling

function scrollAndMove(lines) {
  const b = cur();
  const win = selectedWindow();
  const { lh } = viewMetrics();
  win.programmaticScroll = true;
  win.bodyEl.scrollTop += lines * lh;
  win.scrollTop = win.bodyEl.scrollTop;
  const { line, col } = b.posAt(b.point.pos);
  const target = Math.max(0, Math.min(b.lineCount - 1, line + lines));
  const tw = tabWidth(b);
  const v = visualColumn(b.lineText(line), col, tw);
  b.goto(b.lineStart(target) + columnForVisual(b.lineText(target), v, tw));
  scheduleRedisplay();
}

defcommand('vim-scroll-down', { doc: 'Scroll down half a window, moving the cursor (C-d).' }, () => scrollAndMove(prefix.count ?? Math.ceil(visibleLineCount(selectedWindow()) / 2)));
defcommand('vim-scroll-up', { doc: 'Scroll up half a window, moving the cursor (C-u).' }, () => scrollAndMove(-(prefix.count ?? Math.ceil(visibleLineCount(selectedWindow()) / 2))));
defcommand('vim-scroll-page-down', { doc: 'Scroll down a window (C-f).' }, () => scrollAndMove(Math.max(1, visibleLineCount(selectedWindow()) - 2) * count()));
defcommand('vim-scroll-page-up', { doc: 'Scroll up a window (C-b).' }, () => scrollAndMove(-Math.max(1, visibleLineCount(selectedWindow()) - 2) * count()));
defcommand('vim-scroll-line-down', { doc: 'Scroll the text up [count] lines (C-e).' }, () => scrollWindow(count()));
defcommand('vim-scroll-line-up', { doc: 'Scroll the text down [count] lines (C-y).' }, () => scrollWindow(-count()));

function recenter(where) {
  const b = cur();
  const win = selectedWindow();
  const { lh } = viewMetrics();
  const visible = visibleLineCount(win);
  const line = b.lineAt();
  const margin = Math.min(getVarOr('scroll-margin', 3), Math.floor((visible - 1) / 2));
  let top;
  if (where === 'top') top = line - margin;
  else if (where === 'bottom') top = line - visible + 1 + margin;
  else top = line - Math.floor(visible / 2);
  win.programmaticScroll = true;
  win.bodyEl.scrollTop = Math.max(0, top) * lh;
  win.scrollTop = win.bodyEl.scrollTop;
  scheduleRedisplay();
}

defcommand('vim-scroll-line-to-center', { doc: 'Scroll so the cursor line is centered (zz).' }, () => recenter('center'));
defcommand('vim-scroll-line-to-top', { doc: 'Scroll so the cursor line is at the top (zt).' }, () => recenter('top'));
defcommand('vim-scroll-line-to-bottom', { doc: 'Scroll so the cursor line is at the bottom (zb).' }, () => recenter('bottom'));

// ---------------------------------------------------------------------------
// Insert state helpers

defcommand('vim-delete-backward-word', { doc: 'Delete the word before the cursor (C-w in insert state).' }, () => {
  const b = cur();
  const p = b.point.pos;
  const ls = b.lineStart(b.lineAt());
  if (p === 0) return;
  const target = p === ls ? p - 1 : Math.max(ls, prevWordStart(b, p, false) ?? ls);
  b.deleteText(target, p);
});

defcommand('vim-delete-back-to-indentation', { doc: 'Delete back to the indentation, or to the line start (C-u in insert state).' }, () => {
  const b = cur();
  const p = b.point.pos;
  const line = b.lineAt();
  const fnb = firstNonBlank(b, line);
  const target = p > fnb ? fnb : b.lineStart(line);
  b.deleteText(target, p);
});

defcommand('vim-paste-register-insert', { doc: 'Insert the contents of a register (C-r in insert state).' }, async () => {
  const b = cur();
  const name = keyText(await readChar('C-r'));
  const r = await getRegister(name);
  if (!r) throw userError(`Register ${name} is empty`);
  b.insert(r.text);
});

defcommand('vim-shift-right-line', { doc: 'Indent the current line (C-t in insert state).' }, () => {
  const b = cur();
  const line = b.lineAt();
  const fromEnd = b.lineEnd(line) - b.point.pos;
  shiftLines(b, line, line, 1);
  b.goto(b.lineEnd(line) - fromEnd);
});

defcommand('vim-shift-left-line', { doc: 'Unindent the current line (C-d in insert state).' }, () => {
  const b = cur();
  const line = b.lineAt();
  const fromEnd = b.lineEnd(line) - b.point.pos;
  shiftLines(b, line, line, -1);
  b.goto(Math.max(b.lineStart(line), b.lineEnd(line) - fromEnd));
});

defcommand('vim-replace-backspace', { doc: 'In replace state, move back a character.' }, () => {
  const b = cur();
  if (b.point.pos > b.lineStart(b.lineAt())) b.goto(b.point.pos - 1);
});

// ---------------------------------------------------------------------------
// Quitting

defcommand('vim-save-and-close', { doc: 'Save if modified, then close the window (ZZ).' }, () => call('vim-ex-execute', 'x'));
defcommand('vim-quit-without-save', { doc: 'Close the window without saving (ZQ).' }, () => call('vim-ex-execute', 'q!'));

// Commands that start a change dot-repeat can replay. (Operators are added automatically.)
markRepeatable(
  'vim-delete-char', 'vim-delete-backward-char', 'vim-substitute', 'vim-change-whole-line',
  'vim-change-line', 'vim-delete-line', 'vim-replace', 'vim-invert-char', 'vim-join',
  'vim-join-whitespace', 'vim-paste-after', 'vim-paste-before', 'vim-insert', 'vim-append',
  'vim-insert-line', 'vim-append-line', 'vim-open-below', 'vim-open-above', 'vim-replace-state',
);

export { clampNormal };
