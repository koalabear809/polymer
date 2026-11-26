// Window view: renders a buffer into a window body.
//
// Only visible lines are in the DOM. Layout assumes a monospace grid (char width cw,
// line height lh); lines that aren't plain ASCII are measured with DOM ranges, so
// wide characters and fallback fonts still put the cursor in the right place.
//
// Each rendered line:  <div class="line"><span class="gutter">12</span><span class="lt">…</span></div>
// The gutter is position: sticky, so it stays put when scrolling horizontally.

import { defvar, getVarOr } from './registry.js';
import { overlaysIn } from './marker.js';
import { isPlainLine, visualColumn, columnForVisual, cellWidthAt } from './width.js';

defvar('display-line-numbers', 'relative', { doc: 'Show line numbers: "relative" (default; the cursor line shows its absolute number), true for absolute, or false.' });
defvar('scroll-margin', 3, { doc: 'Lines of context kept above and below the cursor when scrolling.' });
defvar('global-hl-line-mode', true, { doc: 'Highlight the cursor line in the selected window.' });
defvar('tab-width', 4, { doc: 'Display width of a tab character, in columns.' });
defvar('cursor-in-non-selected-windows', true, { doc: 'Show a hollow cursor in windows that are not selected.' });

let metrics = null;
let epoch = 0;                 // bumped to force all windows to re-render their lines
const globalDecorators = [];   // like buffer.decorators, but applied to every buffer

/** Add a decorator for every buffer: (buf, line, lineStart, lineText) => [{ from, to, face, priority }]. */
export function addGlobalDecorator(fn) { if (!globalDecorators.includes(fn)) globalDecorators.push(fn); }
export function removeGlobalDecorator(fn) { const i = globalDecorators.indexOf(fn); if (i >= 0) globalDecorators.splice(i, 1); }

/** Re-render every window's lines on the next redisplay (after a global decoration change). */
export function invalidateAllViews() { epoch++; }

/** { cw, lh }: character width and line height in px. */
export function viewMetrics() {
  if (!metrics) measure();
  return metrics;
}

export function measure() {
  const probe = document.createElement('div');
  probe.className = 'line';
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
  const span = document.createElement('span');
  span.textContent = 'M'.repeat(200);
  probe.appendChild(span);
  document.body.appendChild(probe);
  const r = span.getBoundingClientRect();
  const lh = probe.getBoundingClientRect().height;
  probe.remove();
  metrics = { cw: r.width / 200 || 8, lh: lh || 20 };
  return metrics;
}

/** Forget cached metrics (after font changes). */
export function invalidateMetrics() { metrics = null; }

// ---------------------------------------------------------------------------
// DOM construction

export function createView(win, onScroll) {
  const body = document.createElement('div');
  body.className = 'window-body';
  const spacer = document.createElement('div');
  spacer.className = 'view-spacer';
  const lines = document.createElement('div');
  lines.className = 'view-lines';
  const cursor = document.createElement('div');
  cursor.className = 'cursor';
  body.append(spacer, lines, cursor);
  body.addEventListener('scroll', () => {
    win.scrollTop = body.scrollTop;
    win.scrollLeft = body.scrollLeft;
    if (!win.programmaticScroll) win.userScrolled = true;
    win.programmaticScroll = false;
    onScroll();
  });
  Object.assign(win, { bodyEl: body, spacerEl: spacer, linesEl: lines, cursorEl: cursor });
  win.lineEls = new Map(); // line number -> element (visible lines only)
  win.renderKey = null;
  return body;
}

const FRINGE = 8; // px of space before the text, like Emacs's fringe

function gutterWidthChars(buf) {
  if (!getVarOr('display-line-numbers', 'relative', buf)) return 0;
  return Math.max(3, String(buf.lineCount).length) + 1;
}

/** Width of the gutter (line numbers + fringe) in px. */
function gutterPixels(buf) {
  return gutterWidthChars(buf) * viewMetrics().cw + FRINGE;
}

/** Widest line in cells, accounting for tabs. */
function maxColumns(buf, tabWidth) {
  let m = 0;
  for (const l of buf.text.lines) {
    const w = l.includes('\t') ? visualColumn(l, l.length, tabWidth) : l.length;
    if (w > m) m = w;
  }
  return m;
}

// ---------------------------------------------------------------------------
// Line rendering

/** Decorations for one line: [{ from, to, face, priority }] in line-relative columns. */
function lineDecorations(buf, line, start, text) {
  const end = start + text.length;
  const decos = [];
  const virtual = [];  // { at, text, face, before }
  const lineFaces = [];
  for (const ov of overlaysIn(buf, start, end)) {
    const p = ov.props;
    if (p.lineFace) lineFaces.push(p.lineFace);
    if (p.face && ov.end > start && ov.start < end + 1) {
      const from = Math.max(0, ov.start - start);
      const to = Math.min(text.length, ov.end - start);
      if (to > from) decos.push({ from, to, face: p.face, priority: p.priority ?? 0 });
    }
    if (p.beforeString && ov.start >= start && ov.start <= end) {
      virtual.push({ at: ov.start - start, text: p.beforeString, face: p.beforeFace ?? '', before: true, priority: p.priority ?? 0 });
    }
    if (p.afterString && ov.end >= start && ov.end <= end) {
      virtual.push({ at: ov.end - start, text: p.afterString, face: p.afterFace ?? '', before: false, priority: p.priority ?? 0 });
    }
  }
  for (const d of [...buf.decorators, ...globalDecorators]) {
    try {
      for (const x of d(buf, line, start, text) ?? []) decos.push({ priority: 0, ...x });
    } catch (e) {
      console.error('decorator failed:', e);
    }
  }
  return { decos, virtual, lineFaces };
}

function virtualSpan(v) {
  const s = document.createElement('span');
  s.className = `virtual ${v.face}`.trim();
  s.dataset.virtual = '1';
  s.textContent = v.text;
  return s;
}

function renderLineText(text, decos, virtual) {
  const lt = document.createElement('span');
  lt.className = 'lt';
  if (!decos.length && !virtual.length) {
    lt.textContent = text;
    return lt;
  }
  const cuts = new Set([0, text.length]);
  for (const d of decos) { cuts.add(d.from); cuts.add(d.to); }
  for (const v of virtual) cuts.add(v.at);
  const points = [...cuts].filter((c) => c >= 0 && c <= text.length).sort((a, b) => a - b);
  virtual.sort((a, b) => a.at - b.at || (a.before === b.before ? a.priority - b.priority : a.before ? 1 : -1));
  let vi = 0;
  const emitVirtual = (at) => {
    while (vi < virtual.length && virtual[vi].at === at) lt.appendChild(virtualSpan(virtual[vi++]));
  };
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    emitVirtual(a);
    const b = points[i + 1];
    if (b === undefined || b <= a) continue;
    const seg = text.slice(a, b);
    const faces = decos.filter((d) => d.from <= a && d.to >= b).sort((x, y) => x.priority - y.priority);
    if (!faces.length) {
      lt.append(seg);
    } else {
      const span = document.createElement('span');
      span.className = faces.map((f) => f.face).join(' ');
      span.textContent = seg;
      lt.appendChild(span);
    }
  }
  emitVirtual(text.length);
  return lt;
}

function renderLine(buf, line, { gutterChars, gutterPx, numbers, pointLine, hl }) {
  const el = document.createElement('div');
  el.className = 'line';
  const text = buf.lineText(line);
  const start = buf.lineStart(line);
  const { decos, virtual, lineFaces } = lineDecorations(buf, line, start, text);
  if (hl && line === pointLine) el.classList.add('hl-line');
  for (const f of lineFaces) el.classList.add(...f.split(/\s+/).filter(Boolean));
  const g = document.createElement('span');
  g.className = line === pointLine ? 'gutter current' : 'gutter';
  g.style.width = `${gutterPx}px`;
  if (gutterChars) {
    let n = line + 1;
    if (numbers === 'relative' && line !== pointLine) n = Math.abs(line - pointLine);
    g.textContent = String(n).padStart(gutterChars - 1);
  }
  el.appendChild(g);
  el.appendChild(renderLineText(text, decos, virtual));
  return el;
}

// ---------------------------------------------------------------------------
// Measurement helpers

/** DOM text position of UTF-16 column `col` inside a rendered .lt element. */
function domPosition(lt, col) {
  let remaining = col;
  const walker = document.createTreeWalker(lt, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('[data-virtual]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let last = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (remaining <= n.length) return { node: n, offset: remaining };
    remaining -= n.length;
    last = n;
  }
  return last ? { node: last, offset: last.length } : null;
}

/** Pixel x of column `col` in a rendered line, relative to the start of the text. */
function measureX(lt, col) {
  const pos = domPosition(lt, col);
  if (!pos) return 0;
  const range = document.createRange();
  range.setStart(pos.node, pos.offset);
  range.collapse(true);
  let rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height && pos.offset > 0) {
    // Some engines return an empty rect for collapsed ranges; measure the previous char.
    range.setStart(pos.node, pos.offset - 1);
    range.setEnd(pos.node, pos.offset);
    rect = range.getBoundingClientRect();
    return rect.right - lt.getBoundingClientRect().left;
  }
  return rect.left - lt.getBoundingClientRect().left;
}

function measureWidth(lt, col) {
  const a = domPosition(lt, col);
  const b = domPosition(lt, col + 1);
  if (!a || !b || a.node !== b.node) return null;
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  return range.getBoundingClientRect().width || null;
}

/** Pixel position of a buffer column within a line: { x, w }. */
function columnGeometry(win, buf, line, col, tabWidth) {
  const { cw } = viewMetrics();
  const text = buf.lineText(line);
  const lineEl = win.lineEls.get(line);
  if (isPlainLine(text) || !lineEl) {
    const v = visualColumn(text, col, tabWidth);
    return { x: v * cw, w: cellWidthAt(text, col, tabWidth) * cw };
  }
  const lt = lineEl.querySelector('.lt');
  const x = measureX(lt, col);
  let w = col < text.length ? measureWidth(lt, col) : null;
  if (w === null) w = cellWidthAt(text, col, tabWidth) * cw;
  return { x, w };
}

/** Buffer offset for a mouse event inside a window body. */
export function offsetFromEvent(win, e) {
  const buf = win.buffer;
  const { cw, lh } = viewMetrics();
  const rect = win.bodyEl.getBoundingClientRect();
  const y = e.clientY - rect.top + win.bodyEl.scrollTop;
  const line = Math.max(0, Math.min(buf.lineCount - 1, Math.floor(y / lh)));
  const text = buf.lineText(line);
  const x = e.clientX - rect.left + win.bodyEl.scrollLeft - gutterPixels(buf);
  if (x <= 0) return buf.lineStart(line);
  const tabWidth = getVarOr('tab-width', 4, buf);
  const lineEl = win.lineEls.get(line);
  if (!isPlainLine(text) && lineEl && document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(e.clientX, e.clientY);
    const lt = lineEl.querySelector('.lt');
    if (r && lt.contains(r.startContainer)) {
      let col = 0;
      const walker = document.createTreeWalker(lt, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement?.closest('[data-virtual]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n === r.startContainer) { col += r.startOffset; break; }
        col += n.length;
      }
      return buf.lineStart(line) + Math.min(col, text.length);
    }
  }
  const col = columnForVisual(text, Math.round(x / cw), tabWidth);
  return buf.lineStart(line) + Math.min(col, text.length);
}


// ---------------------------------------------------------------------------
// Rendering

/** Scroll without the resulting scroll event counting as a user scroll. */
function setScroll(win, top, left) {
  const body = win.bodyEl;
  if (top !== undefined && Math.abs(body.scrollTop - top) >= 1) {
    win.programmaticScroll = true;
    body.scrollTop = top;
  }
  if (left !== undefined && Math.abs(body.scrollLeft - left) >= 1) {
    win.programmaticScroll = true;
    body.scrollLeft = left;
  }
}

/**
 * Render `win`. `selected`: whether it's the selected window. `point` is the offset to
 * display the cursor at; returns a (possibly adjusted) point if the user scrolled the
 * cursor out of view.
 */
export function renderView(win, selected, point) {
  const buf = win.buffer;
  const body = win.bodyEl;
  const { cw, lh } = viewMetrics();
  const lineCount = buf.lineCount;
  const tabWidth = getVarOr('tab-width', 4, buf);
  const numbers = getVarOr('display-line-numbers', 'relative', buf);
  const gutterChars = gutterWidthChars(buf);
  const gutterPx = gutterPixels(buf);
  body.style.setProperty('--tab-width', tabWidth);

  // Content size (recomputed only when the text changes).
  const sizeKey = `${buf.textVersion}|${tabWidth}`;
  if (win.maxColsKey !== sizeKey || win.maxColsBuffer !== buf) {
    win.maxCols = maxColumns(buf, tabWidth);
    win.maxColsKey = sizeKey;
    win.maxColsBuffer = buf;
  }
  const contentW = gutterPx + (win.maxCols + 2) * cw;
  win.spacerEl.style.height = `${lineCount * lh}px`;
  win.spacerEl.style.width = `${contentW}px`;
  win.linesEl.style.minWidth = `max(${contentW}px, 100%)`;

  const viewH = body.clientHeight;
  const visibleLines = Math.max(1, Math.floor(viewH / lh));
  const margin = Math.max(0, Math.min(getVarOr('scroll-margin', 3), Math.floor((visibleLines - 1) / 2)));

  let pos = buf.posAt(point);
  const pointMoved = win.lastPoint !== point || win.lastTextVersion !== buf.textVersion || win.renderedBuffer !== buf;

  if (win.renderedBuffer !== buf) setScroll(win, win.scrollTop ?? 0, 0);

  // Keep the cursor visible, or (after a user scroll) keep the cursor inside the view.
  let newPoint = point;
  if (pointMoved) {
    const top = (pos.line - margin) * lh;
    const bottom = (pos.line + 1 + margin) * lh;
    if (top < body.scrollTop) setScroll(win, Math.max(0, top));
    else if (bottom > body.scrollTop + viewH) setScroll(win, bottom - viewH);
  } else if (win.userScrolled) {
    const first = Math.ceil(body.scrollTop / lh) + (body.scrollTop > 0 ? margin : 0);
    const last = Math.floor((body.scrollTop + viewH) / lh) - 1 - (body.scrollTop + viewH < lineCount * lh ? margin : 0);
    let line = pos.line;
    if (line < first) line = first;
    if (line > last) line = last;
    line = Math.max(0, Math.min(lineCount - 1, line));
    if (line !== pos.line) {
      const v = visualColumn(buf.lineText(pos.line), pos.col, tabWidth);
      newPoint = buf.offsetAt(line, columnForVisual(buf.lineText(line), v, tabWidth));
      pos = buf.posAt(newPoint);
    }
  }
  win.userScrolled = false;

  // Visible line range.
  const first = Math.max(0, Math.floor(body.scrollTop / lh) - 2);
  const last = Math.min(lineCount - 1, Math.ceil((body.scrollTop + viewH) / lh) + 2);
  const hl = selected && getVarOr('global-hl-line-mode', true, buf);
  const key = `${epoch}|${buf.version}|${first}|${last}|${hl ? pos.line : -1}|${numbers === 'relative' ? pos.line : ''}|${gutterChars}|${tabWidth}`;
  if (key !== win.renderKey || win.renderedBuffer !== buf) {
    const opts = { gutterChars, gutterPx, numbers, pointLine: pos.line, hl };
    const els = [];
    win.lineEls = new Map();
    for (let i = first; i <= last; i++) {
      const el = renderLine(buf, i, opts);
      win.lineEls.set(i, el);
      els.push(el);
    }
    win.linesEl.replaceChildren(...els);
    win.linesEl.style.transform = `translateY(${first * lh}px)`;
    win.renderKey = key;
  }

  // Cursor.
  const cursor = win.cursorEl;
  const showCursor = selected || getVarOr('cursor-in-non-selected-windows', true, buf);
  cursor.hidden = !showCursor;
  if (showCursor) {
    const { x, w } = columnGeometry(win, buf, pos.line, pos.col, tabWidth);
    const lineText = buf.lineText(pos.line);
    const ch = pos.col < lineText.length ? lineText[pos.col] : ' ';
    const state = selected ? buf.state : 'inactive';
    const shape = { insert: 'bar', replace: 'underline', operator: 'underline', inactive: 'hollow' }[state] ?? 'block';
    cursor.className = `cursor cursor-${shape} state-${state}`;
    cursor.textContent = ch === '\t' ? ' ' : ch;
    cursor.style.width = `${Math.max(w, 2)}px`;
    cursor.style.height = `${lh}px`;
    const cx = gutterPx + x;
    cursor.style.transform = `translate(${cx}px, ${pos.line * lh}px)`;
    cursor.dataset.x = cx;
    cursor.dataset.y = pos.line * lh;

    // Horizontal scrolling to keep the cursor visible.
    if (pointMoved) {
      const viewW = body.clientWidth;
      if (cx - gutterPx < body.scrollLeft) setScroll(win, undefined, Math.max(0, cx - gutterPx - 4 * cw));
      else if (cx + w > body.scrollLeft + viewW) setScroll(win, undefined, cx + w - viewW + 4 * cw);
    }
  }

  win.lastPoint = newPoint;
  win.lastTextVersion = buf.textVersion;
  win.renderedBuffer = buf;
  return newPoint;
}

/** Screen rectangle of the cursor in `win`, for positioning the input element. */
export function cursorClientRect(win) {
  return win.cursorEl?.getBoundingClientRect() ?? null;
}

/** Number of fully visible lines in a window. */
export function visibleLineCount(win) {
  const { lh } = viewMetrics();
  return Math.max(1, Math.floor((win.bodyEl?.clientHeight ?? lh) / lh));
}
