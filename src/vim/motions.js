// Vim motions.

import { getVarOr } from '../core/registry.js';
import { readChar, keyText } from '../core/command-loop.js';
import { selectedWindow } from '../core/window.js';
import { viewMetrics } from '../core/view.js';
import { visualColumn, columnForVisual } from '../core/width.js';
import { defmotion, firstNonBlank, firstNonBlankCol, motionFailed } from './core.js';

// ---------------------------------------------------------------------------
// Character classes: 0 = whitespace, 1 = punctuation, 2 = word (keyword) characters.
// For WORD motions, any non-whitespace is class 1.

const isWordChar = (c) => /[\p{L}\p{N}_]/u.test(c);

function charClass(c, big) {
  if (c === '' || c === ' ' || c === '\t' || c === '\n' || c === '\r') return 0;
  if (big) return 1;
  return isWordChar(c) ? 2 : 1;
}

const charAt = (b, pos) => (pos < 0 || pos >= b.length ? '' : b.text.charAt(pos));
const isEmptyLineAt = (b, pos) => {
  const { line, col } = b.posAt(pos);
  return col === 0 && b.lineText(line).length === 0;
};

/** Start of the next word (w / W). */
export function nextWordStart(b, pos, big) {
  const len = b.length;
  if (pos >= len) return null;
  const cls = charClass(charAt(b, pos), big);
  let p = pos;
  if (cls !== 0) while (p < len && charClass(charAt(b, p), big) === cls) p++;
  // Skip whitespace, stopping at an empty line.
  while (p < len && charClass(charAt(b, p), big) === 0) {
    if (p > pos && isEmptyLineAt(b, p)) return p;
    p++;
  }
  return p;
}

/** End of the current/next word (e / E). */
export function wordEnd(b, pos, big) {
  const len = b.length;
  let p = pos + 1;
  while (p < len && charClass(charAt(b, p), big) === 0) p++;
  if (p >= len) return pos + 1 >= len ? null : len - 1;
  const cls = charClass(charAt(b, p), big);
  while (p + 1 < len && charClass(charAt(b, p + 1), big) === cls) p++;
  return p;
}

/** Start of the current/previous word (b / B). */
export function prevWordStart(b, pos, big) {
  if (pos <= 0) return null;
  let p = pos - 1;
  while (p > 0 && charClass(charAt(b, p), big) === 0) {
    if (isEmptyLineAt(b, p)) return p;
    p--;
  }
  const cls = charClass(charAt(b, p), big);
  while (p > 0 && charClass(charAt(b, p - 1), big) === cls) p--;
  return p;
}

/** End of the previous word (ge / gE). */
export function prevWordEnd(b, pos, big) {
  if (pos <= 0) return null;
  let p = pos;
  const cls = charClass(charAt(b, p), big);
  if (cls !== 0) while (p > 0 && charClass(charAt(b, p), big) === cls) p--;
  while (p > 0 && charClass(charAt(b, p), big) === 0) {
    if (isEmptyLineAt(b, p) && p < pos) return p;
    p--;
  }
  return p;
}

function repeatMotion(count, pos, step) {
  let p = pos;
  for (let i = 0; i < (count ?? 1); i++) {
    const next = step(p);
    if (next === null || next === undefined) return i === 0 ? null : p;
    p = next;
  }
  return p;
}

// ---------------------------------------------------------------------------
// Characters and lines

defmotion('vim-backward-char', { type: 'exclusive', doc: 'Move left within the line (h).' }, (count, { buf, start }) => {
  const { col } = buf.posAt(start);
  if (col === 0) return null;
  return start - Math.min(col, count ?? 1);
});

defmotion('vim-forward-char', { type: 'exclusive', doc: 'Move right within the line (l).' }, (count, { buf, start, operator }) => {
  const { line, col } = buf.posAt(start);
  const len = buf.lineText(line).length;
  // With an operator, l can reach the end of the line (dl on the last char deletes it).
  const limit = operator || buf.state === 'visual' ? len : Math.max(0, len - 1);
  if (col >= limit) return null;
  return start + Math.min(limit - col, count ?? 1);
});

/** Vertical motion keeping the goal (visual) column across consecutive j/k. */
function verticalTarget(buf, start, n) {
  const { line, col } = buf.posAt(start);
  const target = line + n;
  if (target < 0 || target >= buf.lineCount) return null;
  const tw = getVarOr('tab-width', 4, buf);
  const last = getVarOr('last-command', null, null);
  if (!VERTICAL.has(last) || buf.goalColumn === undefined) buf.goalColumn = visualColumn(buf.lineText(line), col, tw);
  const goal = buf.goalColumn;
  const t = buf.lineText(target);
  return buf.lineStart(target) + (goal === Infinity ? t.length : columnForVisual(t, goal, tw));
}

const VERTICAL = new Set(['vim-next-line', 'vim-previous-line', 'vim-next-visual-line', 'vim-previous-visual-line', 'vim-scroll-down', 'vim-scroll-up', 'vim-scroll-page-down', 'vim-scroll-page-up', 'next-line', 'previous-line']);

defmotion('vim-next-line', { type: 'line', doc: 'Move down [count] lines (j).' }, (count, { buf, start }) => verticalTarget(buf, start, count ?? 1));
defmotion('vim-previous-line', { type: 'line', doc: 'Move up [count] lines (k).' }, (count, { buf, start }) => verticalTarget(buf, start, -(count ?? 1)));
defmotion('vim-next-visual-line', { type: 'exclusive', doc: 'Move down a screen line (gj; lines are not wrapped yet).' }, (count, { buf, start }) => verticalTarget(buf, start, count ?? 1));
defmotion('vim-previous-visual-line', { type: 'exclusive', doc: 'Move up a screen line (gk).' }, (count, { buf, start }) => verticalTarget(buf, start, -(count ?? 1)));

defmotion('vim-beginning-of-line', { type: 'exclusive', doc: 'First column (0).' }, (count, { buf, start }) => buf.lineStart(buf.lineAt(start)));

defmotion('vim-first-non-blank', { type: 'exclusive', doc: 'First non-blank character (^).' }, (count, { buf, start }) => firstNonBlank(buf, buf.lineAt(start)));

defmotion('vim-end-of-line', { type: 'inclusive', doc: 'End of the line; with a count, [count]-1 lines down ($).' }, (count, { buf, start }) => {
  const line = Math.min(buf.lineCount - 1, buf.lineAt(start) + (count ?? 1) - 1);
  buf.goalColumn = Infinity;
  const len = buf.lineText(line).length;
  return buf.lineStart(line) + Math.max(0, len - 1);
});

defmotion('vim-last-non-blank', { type: 'inclusive', doc: 'Last non-blank character (g_).' }, (count, { buf, start }) => {
  const line = Math.min(buf.lineCount - 1, buf.lineAt(start) + (count ?? 1) - 1);
  const t = buf.lineText(line);
  const trimmed = t.replace(/[ \t]+$/, '');
  return buf.lineStart(line) + Math.max(0, trimmed.length - 1);
});

defmotion('vim-goto-column', { type: 'exclusive', doc: 'Go to column [count] (|).' }, (count, { buf, start }) => {
  const line = buf.lineAt(start);
  const t = buf.lineText(line);
  return buf.lineStart(line) + Math.min(t.length, Math.max(0, (count ?? 1) - 1));
});

defmotion('vim-next-line-first-non-blank', { type: 'line', doc: 'First non-blank of the line [count] down (+ / RET).' }, (count, { buf, start }) => {
  const line = buf.lineAt(start) + (count ?? 1);
  return line < buf.lineCount ? firstNonBlank(buf, line) : null;
});

defmotion('vim-previous-line-first-non-blank', { type: 'line', doc: 'First non-blank of the line [count] up (-).' }, (count, { buf, start }) => {
  const line = buf.lineAt(start) - (count ?? 1);
  return line >= 0 ? firstNonBlank(buf, line) : null;
});

defmotion('vim-first-non-blank-of-line', { type: 'line', doc: 'First non-blank of the line [count]-1 down (_).' }, (count, { buf, start }) => {
  const line = Math.min(buf.lineCount - 1, buf.lineAt(start) + (count ?? 1) - 1);
  return firstNonBlank(buf, line);
});

defmotion('vim-goto-first-line', { type: 'line', jump: true, doc: 'Go to line [count], default the first (gg).' }, (count, { buf }) => {
  const line = Math.max(0, Math.min(buf.lineCount - 1, (count ?? 1) - 1));
  return firstNonBlank(buf, line);
});

defmotion('vim-goto-line', { type: 'line', jump: true, doc: 'Go to line [count], default the last (G).' }, (count, { buf }) => {
  const line = count === null ? buf.lineCount - 1 : Math.max(0, Math.min(buf.lineCount - 1, count - 1));
  return firstNonBlank(buf, line);
});

// ---------------------------------------------------------------------------
// Words

defmotion('vim-forward-word-begin', { type: 'exclusive', doc: 'Start of the next word (w).' }, (count, ctx) => wordForward(count, ctx, false));
defmotion('vim-forward-WORD-begin', { type: 'exclusive', doc: 'Start of the next WORD (W).' }, (count, ctx) => wordForward(count, ctx, true));

function wordForward(count, { buf, start, operator }, big) {
  const n = count ?? 1;
  // cw on a word behaves like ce (:help cw): change to the end of the word.
  if (operator === 'vim-change' && charClass(charAt(buf, start), big) !== 0) {
    const cls = charClass(charAt(buf, start), big);
    let p = start;
    while (p + 1 < buf.length && charClass(charAt(buf, p + 1), big) === cls) p++;
    for (let i = 1; i < n; i++) {
      const e = wordEnd(buf, p, big);
      if (e === null) break;
      p = e;
    }
    return { pos: p, type: 'inclusive' };
  }
  let prev = start;
  let p = start;
  for (let i = 0; i < n; i++) {
    const next = nextWordStart(buf, p, big);
    if (next === null) { if (i === 0) return null; break; }
    prev = p;
    p = next;
  }
  // With an operator, if the last word moved over ends its line, stop at the end of
  // that line instead of the next line's first word (dw on the last word of a line).
  if (operator && buf.lineAt(p) > buf.lineAt(prev)) {
    const end = buf.lineEnd(buf.lineAt(prev));
    if (end > start) return end;
  }
  return p;
}

defmotion('vim-forward-word-end', { type: 'inclusive', doc: 'End of the word (e).' }, (count, { buf, start }) => repeatMotion(count, start, (p) => wordEnd(buf, p, false)));
defmotion('vim-forward-WORD-end', { type: 'inclusive', doc: 'End of the WORD (E).' }, (count, { buf, start }) => repeatMotion(count, start, (p) => wordEnd(buf, p, true)));
defmotion('vim-backward-word-begin', { type: 'exclusive', doc: 'Start of the previous word (b).' }, (count, { buf, start }) => repeatMotion(count, start, (p) => prevWordStart(buf, p, false)));
defmotion('vim-backward-WORD-begin', { type: 'exclusive', doc: 'Start of the previous WORD (B).' }, (count, { buf, start }) => repeatMotion(count, start, (p) => prevWordStart(buf, p, true)));
defmotion('vim-backward-word-end', { type: 'inclusive', doc: 'End of the previous word (ge).' }, (count, { buf, start }) => repeatMotion(count, start, (p) => prevWordEnd(buf, p, false)));
defmotion('vim-backward-WORD-end', { type: 'inclusive', doc: 'End of the previous WORD (gE).' }, (count, { buf, start }) => repeatMotion(count, start, (p) => prevWordEnd(buf, p, true)));

// ---------------------------------------------------------------------------
// f / t / F / T and ; ,

let lastFind = null; // { forward, till, ch }

function findInLine(buf, start, { forward, till, ch }, count, repeat) {
  const { line, col } = buf.posAt(start);
  const text = buf.lineText(line);
  let c = col;
  for (let i = 0; i < (count ?? 1); i++) {
    // When repeating a t/T with ; or , skip the adjacent match so it makes progress.
    let from = forward ? c + 1 : c - 1;
    if (till && repeat && i === 0) from = forward ? c + 2 : c - 2;
    const idx = forward ? text.indexOf(ch, from) : (from < 0 ? -1 : text.lastIndexOf(ch, from));
    if (idx < 0) return null;
    c = idx;
  }
  if (till) c = forward ? c - 1 : c + 1;
  return buf.lineStart(line) + c;
}

function defFind(name, forward, till, key) {
  defmotion(name, { type: forward ? 'inclusive' : 'exclusive', doc: `Find a character in the line (${key}).` }, async (count, { buf, start }) => {
    const ch = keyText(await readChar());
    lastFind = { forward, till, ch };
    return findInLine(buf, start, lastFind, count, false);
  });
}
defFind('vim-find-char', true, false, 'f');
defFind('vim-find-char-to', true, true, 't');
defFind('vim-find-char-backward', false, false, 'F');
defFind('vim-find-char-to-backward', false, true, 'T');

defmotion('vim-repeat-find-char', { type: 'inclusive', doc: 'Repeat the last f/t/F/T (;).' }, (count, { buf, start }) => {
  if (!lastFind) return null;
  const pos = findInLine(buf, start, lastFind, count, true);
  return pos === null ? null : { pos, type: lastFind.forward ? 'inclusive' : 'exclusive' };
});

defmotion('vim-repeat-find-char-reverse', { type: 'exclusive', doc: 'Repeat the last f/t/F/T backwards (,).' }, (count, { buf, start }) => {
  if (!lastFind) return null;
  const rev = { ...lastFind, forward: !lastFind.forward };
  const pos = findInLine(buf, start, rev, count, true);
  return pos === null ? null : { pos, type: rev.forward ? 'inclusive' : 'exclusive' };
});

// ---------------------------------------------------------------------------
// Paragraphs, brackets, screen

const blank = (buf, line) => /^\s*$/.test(buf.lineText(line));

defmotion('vim-forward-paragraph', { type: 'exclusive', jump: true, doc: 'Next blank line after a paragraph (}).' }, (count, { buf, start }) => {
  let line = buf.lineAt(start);
  for (let i = 0; i < (count ?? 1); i++) {
    while (line < buf.lineCount - 1 && blank(buf, line)) line++;
    while (line < buf.lineCount - 1 && !blank(buf, line)) line++;
    if (line === buf.lineCount - 1 && !blank(buf, line)) return buf.length;
  }
  return buf.lineStart(line);
});

defmotion('vim-backward-paragraph', { type: 'exclusive', jump: true, doc: 'Previous blank line before a paragraph ({).' }, (count, { buf, start }) => {
  let line = buf.lineAt(start);
  for (let i = 0; i < (count ?? 1); i++) {
    while (line > 0 && blank(buf, line)) line--;
    while (line > 0 && !blank(buf, line)) line--;
  }
  return buf.lineStart(line);
});

const PAIRS = { '(': ')', '[': ']', '{': '}', ')': '(', ']': '[', '}': '{' };
const OPENERS = new Set(['(', '[', '{']);

/** Offset of the bracket matching the one at `pos`, or null. */
export function matchingBracket(buf, pos) {
  const ch = charAt(buf, pos);
  const other = PAIRS[ch];
  if (!other) return null;
  const forward = OPENERS.has(ch);
  let depth = 0;
  const text = buf.getText();
  if (forward) {
    for (let p = pos; p < text.length; p++) {
      if (text[p] === ch) depth++;
      else if (text[p] === other && --depth === 0) return p;
    }
  } else {
    for (let p = pos; p >= 0; p--) {
      if (text[p] === ch) depth++;
      else if (text[p] === other && --depth === 0) return p;
    }
  }
  return null;
}

defmotion('vim-jump-item', { type: 'inclusive', jump: true, doc: 'Jump to the matching bracket; with a count, to [count]% of the file (%).' }, (count, { buf, start }) => {
  if (count !== null) {
    const line = Math.max(0, Math.min(buf.lineCount - 1, Math.ceil((count * buf.lineCount) / 100) - 1));
    return { pos: firstNonBlank(buf, line), type: 'line' };
  }
  const { line, col } = buf.posAt(start);
  const text = buf.lineText(line);
  for (let c = col; c < text.length; c++) {
    if (PAIRS[text[c]]) return matchingBracket(buf, buf.lineStart(line) + c);
  }
  return null;
});

function screenLines() {
  const win = selectedWindow();
  const { lh } = viewMetrics();
  const top = Math.ceil(win.bodyEl.scrollTop / lh);
  const visible = Math.max(1, Math.floor(win.bodyEl.clientHeight / lh));
  return { top, bottom: top + visible - 1, visible };
}

const scrollOff = (visible) => Math.min(getVarOr('scroll-margin', 3), Math.floor((visible - 1) / 2));

defmotion('vim-window-top', { type: 'line', jump: true, doc: 'Top line of the window (H).' }, (count, { buf }) => {
  const { top, visible } = screenLines();
  const off = top > 0 ? scrollOff(visible) : 0;
  return firstNonBlank(buf, Math.min(buf.lineCount - 1, top + Math.max(off, (count ?? 1) - 1)));
});

defmotion('vim-window-middle', { type: 'line', jump: true, doc: 'Middle line of the window (M).' }, (count, { buf }) => {
  const { top, bottom } = screenLines();
  const last = Math.min(buf.lineCount - 1, bottom);
  return firstNonBlank(buf, Math.floor((top + last) / 2));
});

defmotion('vim-window-bottom', { type: 'line', jump: true, doc: 'Bottom line of the window (L).' }, (count, { buf }) => {
  const { bottom, visible } = screenLines();
  const last = Math.min(buf.lineCount - 1, bottom);
  const off = bottom < buf.lineCount - 1 ? scrollOff(visible) : 0;
  return firstNonBlank(buf, Math.max(0, last - Math.max(off, (count ?? 1) - 1)));
});

export { charClass, motionFailed };
