// Search: / ? n N * # with incremental search and match highlighting.
//
// Patterns are JavaScript regular expressions, plus Vim's \< and \> word boundaries.
// Matching is case-insensitive unless the pattern contains an uppercase letter.

import { defcommand, defvar, getVarOr } from '../core/registry.js';
import { readString } from '../core/helm/helm.js';
import { message } from '../core/echo.js';
import { PolymerError } from '../core/errors.js';
import { addGlobalDecorator, invalidateAllViews } from '../core/view.js';
import { scheduleRedisplay } from '../core/redisplay.js';
import { defmotion, invalidateRecording } from './core.js';
import { setReadOnlyRegister } from './registers.js';
import { charClass } from './motions.js';

defvar('vim-search-wrap', true, { doc: 'When true, searches wrap around the end of the buffer.' });
defvar('vim-ex-search-highlight-all', true, { doc: 'When true, highlight all matches of the last search.' });
defvar('vim-ex-search-case', 'smart', { doc: 'Search case: "smart" (insensitive unless uppercase), "sensitive" or "insensitive".' });

let lastSearch = null;  // { pattern, forward, ignoreSmartCase }
let highlight = null;   // { re } while matches are highlighted
let current = null;     // { buffer, from, to } during incremental search

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Compile a search pattern into a global RegExp (throws a readable error if invalid).
 * ignoreSmartCase: case-insensitive whenever the mode isn't "sensitive" (used by * and #,
 * which ignore smartcase like Vim).
 */
export function compileSearch(pattern, { ignoreSmartCase = false } = {}) {
  const mode = getVarOr('vim-ex-search-case', 'smart');
  const unescaped = pattern.replace(/\\./g, '');
  const insensitive = mode === 'insensitive'
    || (mode === 'smart' && (ignoreSmartCase || unescaped === unescaped.toLowerCase()));
  const src = pattern.replace(/\\</g, '\\b').replace(/\\>/g, '\\b');
  try {
    return new RegExp(src, insensitive ? 'gi' : 'g');
  } catch (e) {
    throw new PolymerError('invalid-regexp', `Invalid search pattern: ${e.message}`);
  }
}

/** First match at or after `start` (wrapping). Returns { from, to, wrapped } or null. */
function searchForward(b, re, start, wrap) {
  const n = b.lineCount;
  const sp = b.posAt(Math.min(start, b.length));
  for (let i = 0; i <= n; i++) {
    let ln = sp.line + i;
    let wrapped = false;
    if (ln >= n) {
      if (!wrap) return null;
      ln -= n;
      wrapped = true;
    }
    const text = b.lineText(ln);
    re.lastIndex = i === 0 ? sp.col : 0;
    const m = re.exec(text);
    if (!m) continue;
    if (i === n && m.index >= sp.col) return null;
    if (i === 0 && m.index < sp.col) continue;
    const from = b.lineStart(ln) + m.index;
    return { from, to: from + m[0].length, wrapped };
  }
  return null;
}

/** Last match starting before `start` (wrapping). */
function searchBackward(b, re, start, wrap) {
  const n = b.lineCount;
  const sp = b.posAt(Math.min(start, b.length));
  for (let i = 0; i <= n; i++) {
    let ln = sp.line - i;
    let wrapped = false;
    if (ln < 0) {
      if (!wrap) return null;
      ln += n;
      wrapped = true;
    }
    const text = b.lineText(ln);
    re.lastIndex = 0;
    let last = null;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (i === 0 && m.index >= sp.col) break;
      if (!(i === n && m.index <= sp.col)) last = { index: m.index, len: m[0].length };
      if (m[0].length === 0) re.lastIndex++;
    }
    if (last) {
      const from = b.lineStart(ln) + last.index;
      return { from, to: from + last.len, wrapped };
    }
  }
  return null;
}

/** Find the [count]th match from `pos`. */
export function findMatch(b, pattern, pos, forward, count = 1, opts = {}) {
  const re = compileSearch(pattern, opts);
  const wrap = getVarOr('vim-search-wrap', true);
  let p = pos;
  let m = null;
  let wrapped = false;
  for (let i = 0; i < count; i++) {
    m = forward ? searchForward(b, re, p + 1, wrap) : searchBackward(b, re, p, wrap);
    if (!m) return null;
    wrapped ||= m.wrapped;
    p = m.from;
  }
  return { ...m, wrapped };
}

function setHighlight(pattern, opts = {}) {
  try {
    highlight = pattern && getVarOr('vim-ex-search-highlight-all', true) ? { re: compileSearch(pattern, opts) } : null;
  } catch {
    highlight = null;
  }
  invalidateAllViews();
  scheduleRedisplay();
}

addGlobalDecorator((buf, line, start, text) => {
  const out = [];
  if (highlight) {
    const re = highlight.re;
    re.lastIndex = 0;
    let guard = 0;
    for (let m = re.exec(text); m && guard < 1000; m = re.exec(text), guard++) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      out.push({ from: m.index, to: m.index + m[0].length, face: 'search-match', priority: 10 });
    }
  }
  if (current && current.buffer === buf && current.from < start + text.length + 1 && current.to > start) {
    out.push({ from: Math.max(0, current.from - start), to: Math.min(text.length, current.to - start), face: 'search-current', priority: 20 });
  }
  return out;
});

function remember(pattern, forward, ignoreSmartCase = false) {
  lastSearch = { pattern, forward, ignoreSmartCase };
  setReadOnlyRegister('/', pattern);
}

function reportMatch(m, pattern) {
  if (!m) throw new PolymerError('search-failed', `Pattern not found: ${pattern}`);
  if (m.wrapped) message('Search wrapped');
}

async function promptSearch(forward, count, { buf, start }) {
  invalidateRecording();
  const origin = start;
  try {
    const pattern = await readString(forward ? '/' : '?', {
      history: 'vim-search-history',
      onInput: (q) => {
        current = null;
        if (q) {
          try {
            const m = findMatch(buf, q, origin, forward, count ?? 1);
            if (m) {
              current = { buffer: buf, from: m.from, to: m.to };
              buf.point.set(m.from);
            } else {
              buf.point.set(origin);
            }
          } catch {
            // Incomplete pattern while typing; ignore.
          }
        } else {
          buf.point.set(origin);
        }
        setHighlight(q);
      },
    });
    buf.point.set(origin);
    current = null;
    const p = pattern || lastSearch?.pattern;
    if (!p) return null;
    remember(p, forward);
    setHighlight(p);
    const m = findMatch(buf, p, origin, forward, count ?? 1);
    reportMatch(m, p);
    return m.from;
  } catch (e) {
    buf.point.set(origin);
    current = null;
    setHighlight(lastSearch?.pattern ?? null);
    throw e;
  }
}

defmotion('vim-search-forward', { type: 'exclusive', jump: true, doc: 'Search forward for a pattern (/).' }, (count, ctx) => promptSearch(true, count, ctx));
defmotion('vim-search-backward', { type: 'exclusive', jump: true, doc: 'Search backward for a pattern (?).' }, (count, ctx) => promptSearch(false, count, ctx));

function repeatSearch(reverse, count, { buf, start }) {
  if (!lastSearch) throw new PolymerError('search-failed', 'No previous search');
  const forward = reverse ? !lastSearch.forward : lastSearch.forward;
  const opts = { ignoreSmartCase: lastSearch.ignoreSmartCase };
  setHighlight(lastSearch.pattern, opts);
  const m = findMatch(buf, lastSearch.pattern, start, forward, count ?? 1, opts);
  reportMatch(m, lastSearch.pattern);
  return m.from;
}

defmotion('vim-search-next', { type: 'exclusive', jump: true, doc: 'Repeat the last search (n).' }, (count, ctx) => repeatSearch(false, count, ctx));
defmotion('vim-search-previous', { type: 'exclusive', jump: true, doc: 'Repeat the last search in the opposite direction (N).' }, (count, ctx) => repeatSearch(true, count, ctx));

function wordSearch(forward, count, { buf, start }) {
  const { line, col } = buf.posAt(start);
  const text = buf.lineText(line);
  // Word under the cursor, or the next word on the line.
  let s = col;
  while (s < text.length && charClass(text[s], false) !== 2) s++;
  if (s >= text.length) throw new PolymerError('search-failed', 'No word under cursor');
  let e = s;
  while (e < text.length && charClass(text[e], false) === 2) e++;
  while (s > 0 && charClass(text[s - 1], false) === 2) s--;
  const pattern = `\\<${escapeRegExp(text.slice(s, e))}\\>`;
  const opts = { ignoreSmartCase: true };
  remember(pattern, forward, true);
  setHighlight(pattern, opts);
  const from = buf.lineStart(line) + s;
  const m = findMatch(buf, pattern, from, forward, count ?? 1, opts);
  reportMatch(m, pattern);
  return m.from;
}

defmotion('vim-search-word-forward', { type: 'exclusive', jump: true, doc: 'Search forward for the word under the cursor (*).' }, (count, ctx) => wordSearch(true, count, ctx));
defmotion('vim-search-word-backward', { type: 'exclusive', jump: true, doc: 'Search backward for the word under the cursor (#).' }, (count, ctx) => wordSearch(false, count, ctx));

defcommand('vim-ex-nohighlight', { doc: 'Stop highlighting search matches (:noh).' }, () => {
  if (highlight) setHighlight(null);
});

/** Used by :s to make its pattern the last search. */
export function setLastSearch(pattern) {
  remember(pattern, true);
  setHighlight(pattern);
}

export const lastSearchPattern = () => lastSearch?.pattern ?? null;
