// Vim text objects: iw aw iW aW, quotes, brackets, paragraphs.

import { deftextobject } from './core.js';
import { charClass } from './motions.js';

const charAt = (b, pos) => (pos < 0 || pos >= b.length ? '' : b.text.charAt(pos));

// ---------------------------------------------------------------------------
// Words

function wordObject(count, { buf, start }, big, around) {
  const { line } = buf.posAt(start);
  const ls = buf.lineStart(line);
  const le = buf.lineEnd(line);
  const cls = (p) => (p < ls || p >= le ? -1 : charClass(charAt(buf, p), big));
  let from = start;
  let to = start;
  for (let i = 0; i < count; i++) {
    const c = i === 0 ? cls(from) : cls(to);
    if (i === 0) {
      if (c === -1) return null;
      while (from > ls && cls(from - 1) === c) from--;
      while (to < le && cls(to) === c) to++;
    } else {
      // Each extra count takes the next run (word or whitespace).
      const c2 = cls(to);
      if (c2 === -1) break;
      while (to < le && cls(to) === c2) to++;
    }
  }
  if (around) {
    if (cls(start) !== 0) {
      // Include trailing whitespace, or leading whitespace if there is none trailing.
      const t0 = to;
      while (to < le && cls(to) === 0) to++;
      if (to === t0) while (from > ls && cls(from - 1) === 0) from--;
    } else {
      // On whitespace: whitespace plus the following word.
      const c2 = cls(to);
      if (c2 > 0) while (to < le && cls(to) === c2) to++;
    }
  }
  return { from, to, type: 'char' };
}

deftextobject('vim-inner-word', { doc: 'Inner word (iw).' }, (n, ctx) => wordObject(n, ctx, false, false));
deftextobject('vim-a-word', { doc: 'A word, with whitespace (aw).' }, (n, ctx) => wordObject(n, ctx, false, true));
deftextobject('vim-inner-WORD', { doc: 'Inner WORD (iW).' }, (n, ctx) => wordObject(n, ctx, true, false));
deftextobject('vim-a-WORD', { doc: 'A WORD, with whitespace (aW).' }, (n, ctx) => wordObject(n, ctx, true, true));

// ---------------------------------------------------------------------------
// Quotes (within the line)

function quoteObject(q, { buf, start }, around) {
  const { line, col } = buf.posAt(start);
  const text = buf.lineText(line);
  const ls = buf.lineStart(line);
  // Positions of unescaped quotes on the line.
  const qs = [];
  for (let i = 0; i < text.length; i++) if (text[i] === q && text[i - 1] !== '\\') qs.push(i);
  let open = -1;
  let close = -1;
  for (let i = 0; i + 1 < qs.length; i += 2) {
    if (qs[i] <= col && col <= qs[i + 1]) { open = qs[i]; close = qs[i + 1]; break; }
  }
  if (open < 0) {
    // Not inside a pair: use the first pair after the cursor.
    const next = qs.findIndex((p) => p > col);
    if (next < 0 || next + 1 >= qs.length) return null;
    open = qs[next];
    close = qs[next + 1];
  }
  if (!around) return { from: ls + open + 1, to: ls + close, type: 'char' };
  let to = close + 1;
  let from = open;
  if (/[ \t]/.test(text[to] ?? '')) { while (/[ \t]/.test(text[to] ?? '')) to++; }
  else while (from > 0 && /[ \t]/.test(text[from - 1])) from--;
  return { from: ls + from, to: ls + to, type: 'char' };
}

for (const [q, name] of [['"', 'double-quote'], ["'", 'single-quote'], ['`', 'back-quote']]) {
  deftextobject(`vim-inner-${name}`, { doc: `Inside ${q}…${q} (i${q}).` }, (n, ctx) => quoteObject(q, ctx, false));
  deftextobject(`vim-a-${name}`, { doc: `${q}…${q} including the quotes (a${q}).` }, (n, ctx) => quoteObject(q, ctx, true));
}

// ---------------------------------------------------------------------------
// Brackets (nesting, across lines)

/** Offset of the opener enclosing `pos` (or at `pos`), or -1. */
function enclosingOpener(text, pos, open, close) {
  let depth = 0;
  for (let p = pos; p >= 0; p--) {
    const ch = text[p];
    if (ch === close && p !== pos) depth++;
    else if (ch === open) {
      if (depth === 0) return p;
      depth--;
    }
  }
  return -1;
}

function matchingCloser(text, o, open, close) {
  let depth = 0;
  for (let p = o + 1; p < text.length; p++) {
    if (text[p] === open) depth++;
    else if (text[p] === close) {
      if (depth === 0) return p;
      depth--;
    }
  }
  return -1;
}

function bracketObject(open, close, count, { buf, start }, around) {
  const text = buf.getText();
  let o = -1;
  let c = -1;
  let from = start;
  for (let i = 0; i < count; i++) {
    o = enclosingOpener(text, from, open, close);
    if (o < 0) return null;
    c = matchingCloser(text, o, open, close);
    if (c < 0) return null;
    from = o - 1; // the next count looks for the block around this one
    if (from < 0 && i + 1 < count) return null;
  }
  if (around) return { from: o, to: c + 1, type: 'char' };
  const s = o + 1;
  const e = c;
  // A block whose braces sit on their own lines is linewise inside, like Vim: "di{"
  // removes the inner lines and "ci{" leaves one indented line to type on.
  const closerLineStart = text.lastIndexOf('\n', e - 1) + 1;
  if (text[s] === '\n' && closerLineStart > s + 1 && /^[ \t]*$/.test(text.slice(closerLineStart, e))) {
    return { from: s + 1, to: closerLineStart - 1, type: 'line' };
  }
  return { from: s, to: e, type: 'char' };
}

for (const [open, close, names] of [['(', ')', ['paren', 'b']], ['[', ']', ['bracket']], ['{', '}', ['curly', 'B']], ['<', '>', ['angle']]]) {
  const label = names[0];
  deftextobject(`vim-inner-${label}`, { doc: `Inside ${open}…${close}.` }, (n, ctx) => bracketObject(open, close, n, ctx, false));
  deftextobject(`vim-a-${label}`, { doc: `${open}…${close} including the brackets.` }, (n, ctx) => bracketObject(open, close, n, ctx, true));
}

// ---------------------------------------------------------------------------
// Paragraphs (linewise)

const blank = (buf, line) => /^\s*$/.test(buf.lineText(line));

function paragraphObject(count, { buf, start }, around) {
  let s = buf.lineAt(start);
  const kind = blank(buf, s);
  while (s > 0 && blank(buf, s - 1) === kind) s--;
  let e = buf.lineAt(start);
  for (let i = 0; i < count; i++) {
    const k = i === 0 ? kind : blank(buf, e + 1);
    if (i > 0) { if (e + 1 >= buf.lineCount) break; e++; }
    while (e + 1 < buf.lineCount && blank(buf, e + 1) === k) e++;
  }
  if (around) {
    if (!kind && e + 1 < buf.lineCount) {
      while (e + 1 < buf.lineCount && blank(buf, e + 1)) e++;
    } else if (!kind) {
      while (s > 0 && blank(buf, s - 1)) s--;
    } else {
      while (e + 1 < buf.lineCount && !blank(buf, e + 1)) e++;
    }
  }
  return { from: buf.lineStart(s), to: buf.lineEnd(e), type: 'line' };
}

deftextobject('vim-inner-paragraph', { doc: 'Inner paragraph (ip).' }, (n, ctx) => paragraphObject(n, ctx, false));
deftextobject('vim-a-paragraph', { doc: 'A paragraph, with trailing blank lines (ap).' }, (n, ctx) => paragraphObject(n, ctx, true));
