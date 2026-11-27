// Window view: renders a buffer into a window body.
//
// Only visible lines are in the DOM. Layout assumes a monospace grid (char width cw,
// line height lh); lines that aren't plain ASCII are measured with DOM ranges, so
// wide characters and fallback fonts still put the cursor in the right place.
//
// Each rendered line:  <div class="line"><span class="gutter">12</span><span class="lt">…</span></div>
// The gutter is position: sticky, so it stays put when scrolling horizontally.

import { defvar, getVarOr } from './registry.js';
import { scheduleRedisplay } from './redisplay.js';
import { overlaysIn } from './marker.js';
import { isPlainLine, visualColumn, columnForVisual, cellWidthAt } from './width.js';

defvar('display-line-numbers', 'relative', { doc: 'Show line numbers: "relative" (default; the cursor line shows its absolute number), true for absolute, or false.' });
defvar('scroll-margin', 3, { doc: 'Lines of context kept above and below the cursor when scrolling.' });
defvar('global-hl-line-mode', true, { doc: 'Highlight the cursor line in the selected window.' });
defvar('tab-width', 4, { doc: 'Display width of a tab character, in columns.' });
defvar('auto-hscroll-mode', true, { doc: 'When true, windows scroll sideways to keep the cursor visible. Terminals turn it off: they always fit the window.' });
defvar('cursor-in-non-selected-windows', true, { doc: 'Show a hollow cursor in windows that are not selected.' });
defvar('truncate-lines', true, { doc: 'When false, long lines wrap at the window edge. When true (default), lines extend horizontally and require scrolling.' });

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
  // Wrapped text reflows with the window width: redisplay (cursor, overlays, hooks) on any width change.
  if (typeof ResizeObserver !== 'undefined') {
    let lastW = 0;
    new ResizeObserver(() => {
      const w = body.clientWidth;
      if (w && w !== lastW) { lastW = w; scheduleRedisplay(); }
    }).observe(body);
  }
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
  const images = [];    // { src, alt }: pictures shown below the line
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
      for (const x of d(buf, line, start, text) ?? []) {
        // { lineFace } styles the whole line (full width), like an overlay's lineFace.
        if (x.lineFace) lineFaces.push(x.lineFace);
        else if (x.image) images.push(x.image);
        // { before: 'text', at, face }: display-only text before column `at` (default 0).
        else if (x.before !== undefined) virtual.push({ at: x.at ?? 0, text: x.before, face: x.face ?? '', before: true, priority: x.priority ?? 0 });
        else decos.push({ priority: 0, ...x });
      }
    } catch (e) {
      console.error('decorator failed:', e);
    }
  }
  return { decos, virtual, lineFaces, images };
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
      span.className = faces.map((f) => f.face ?? '').join(' ').trim();
      // Decorations may also carry inline CSS (e.g. terminal 256-color/truecolor output).
      const style = faces.map((f) => f.style).filter(Boolean).join(';');
      if (style) span.style.cssText = style;
      span.textContent = seg;
      lt.appendChild(span);
    }
  }
  emitVirtual(text.length);
  return lt;
}

/** Everything a rendered line shows (text, decorations, gutter), without building it. */
function lineData(buf, line, { gutterChars, gutterPx, numbers, pointLine, hl }) {
  const text = buf.lineText(line);
  const { decos, virtual, lineFaces, images } = lineDecorations(buf, line, buf.lineStart(line), text);
  let gutter = '';
  if (gutterChars) {
    let n = line + 1;
    if (numbers === 'relative' && line !== pointLine) n = Math.abs(line - pointLine);
    gutter = String(n).padStart(gutterChars - 1);
  }
  const current = line === pointLine;
  return { line, text, decos, virtual, lineFaces, images, gutter, gutterPx, current, hlLine: !!(hl && current) };
}

/** Lines with equal signatures render identically, so an existing element can be kept. */
const lineSignature = (d) => JSON.stringify([
  d.text, d.decos, d.virtual, d.lineFaces, d.images.map((im) => im.src), d.line, d.gutter, d.gutterPx, d.current, d.hlLine,
]);

function buildLine(d, win, wrapped) {
  const el = document.createElement('div');
  el.className = 'line';
  if (wrapped) el.classList.add('wrapped');
  if (d.hlLine) el.classList.add('hl-line');
  for (const f of d.lineFaces) el.classList.add(...f.split(/\s+/).filter(Boolean));
  const g = document.createElement('span');
  g.className = d.current ? 'gutter current' : 'gutter';
  g.style.width = `${d.gutterPx}px`;
  if (d.gutter) g.textContent = d.gutter;
  el.appendChild(g);
  el.appendChild(renderLineText(d.text, d.decos, d.virtual));
  if (wrapped && d.images.length) {
    el.classList.add('has-images');
    el.appendChild(imageBlock(win, d.images, d.gutterPx, d.line));
  }
  return el;
}

function renderLine(buf, line, opts) {
  return buildLine(lineData(buf, line, opts), opts.win, opts.wrapped);
}

/**
 * Soft-wrapped buffers have every line in the DOM (the browser lays them out, so their
 * heights are unknown). Rebuilding them all on each keystroke costs ~100ms in a long agent
 * conversation, so only the changed run of lines is replaced: lines that match the last
 * render at the start and at the end keep their elements.
 */
function renderWrappedLines(win, buf, opts) {
  const n = buf.lineCount;
  const data = new Array(n);
  const sigs = new Array(n);
  for (let i = 0; i < n; i++) {
    data[i] = lineData(buf, i, opts);
    sigs[i] = lineSignature(data[i]);
  }
  const prev = win.wrappedRender;
  const reusable = prev && prev.buf === buf && prev.epoch === epoch
    && prev.els.length === win.linesEl.children.length && (!prev.els.length || prev.els[0].parentNode === win.linesEl);
  let els;
  if (!reusable) {
    els = data.map((d) => buildLine(d, win, true));
    win.linesEl.replaceChildren(...els);
  } else {
    const old = prev.sigs;
    const max = Math.min(n, old.length);
    let head = 0;
    while (head < max && old[head] === sigs[head]) head++;
    let tail = 0;
    while (tail < max - head && old[old.length - 1 - tail] === sigs[n - 1 - tail]) tail++;
    const fresh = [];
    for (let i = head; i < n - tail; i++) fresh.push(buildLine(data[i], win, true));
    const anchor = prev.els[prev.els.length - tail] ?? null; // first kept element after the change
    for (const el of prev.els.slice(head, prev.els.length - tail)) el.remove();
    if (fresh.length) {
      const frag = document.createDocumentFragment();
      frag.append(...fresh);
      win.linesEl.insertBefore(frag, anchor);
    }
    els = [...prev.els.slice(0, head), ...fresh, ...prev.els.slice(prev.els.length - tail)];
  }
  win.wrappedRender = { buf, epoch, sigs, els };
  win.lineEls = new Map(els.map((el, i) => [i, el]));
}

// ---------------------------------------------------------------------------
// Images under lines
//
// A decorator can return { image: { src, alt } } to show a picture below that line (only
// in soft-wrapped buffers, whose lines are laid out by the browser and can be any height).
// Each window keeps its <img> elements per src, so re-rendering a line moves the same
// (already loaded) element instead of reloading it, which would flicker and jump.

const imageCaches = new WeakMap(); // window -> Map(src -> HTMLImageElement)
const IMAGE_CACHE_MAX = 64;

function imageElement(win, { src, alt }, key) {
  let imageCache = imageCaches.get(win);
  if (!imageCache) imageCaches.set(win, (imageCache = new Map()));
  let img = imageCache.get(key);
  if (!img || img.dataset.src !== src) {
    img = document.createElement('img');
    img.decoding = 'async';
    img.alt = alt ?? '';
    // Its height is unknown until it loads; redisplay then so the cursor lands right.
    img.addEventListener('load', () => scheduleRedisplay(), { once: true });
    img.addEventListener('error', () => img.classList.add('broken'), { once: true });
    img.dataset.src = src;
    img.src = src;
    imageCache.set(key, img);
    if (imageCache.size > IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
  } else {
    imageCache.delete(key); // most recently used goes last
    imageCache.set(key, img);
  }
  return img;
}

function imageBlock(win, images, gutterPx, line) {
  const box = document.createElement('div');
  box.className = 'line-images';
  box.style.paddingLeft = `${gutterPx}px`;
  box.dataset.virtual = '1';
  images.forEach((im, k) => box.appendChild(imageElement(win, im, `${line}:${k}:${im.src}`)));
  return box;
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
  const wrapped = !getVarOr('truncate-lines', true, buf);
  const tabWidth = getVarOr('tab-width', 4, buf);
  
  // For wrapped lines, use caretRangeFromPoint directly since Y position doesn't map to line number
  if (wrapped && document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(e.clientX, e.clientY);
    if (r) {
      // Find which line element contains this range
      for (const [lineNum, lineEl] of win.lineEls) {
        const lt = lineEl.querySelector('.lt');
        if (lt && lt.contains(r.startContainer)) {
          const text = buf.lineText(lineNum);
          let col = 0;
          const walker = document.createTreeWalker(lt, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const virtual = n.parentElement?.closest('[data-virtual]');
            if (n === r.startContainer) { if (!virtual) col += r.startOffset; break; } // a click on display text lands next to it
            if (!virtual) col += n.length;
          }
          return buf.lineStart(lineNum) + Math.min(col, text.length);
        }
      }
    }
  }
  
  // Non-wrapped mode: calculate line from Y coordinate
  const y = e.clientY - rect.top + win.bodyEl.scrollTop;
  const line = Math.max(0, Math.min(buf.lineCount - 1, Math.floor(y / lh)));
  const text = buf.lineText(line);
  const x = e.clientX - rect.left + win.bodyEl.scrollLeft - gutterPixels(buf);
  if (x <= 0) return buf.lineStart(line);
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
/**
 * Buffers that aren't text (images, ...) set `buf.customRenderer(win, el, selected)`:
 * the window hides its text layer and gives the renderer its own element to fill.
 */
function renderCustom(win, selected) {
  const buf = win.buffer;
  const body = win.bodyEl;
  if (!win.customEl || win.customFor !== buf) {
    win.customEl?.remove();
    win.customEl = document.createElement('div');
    win.customEl.className = 'custom-view';
    body.appendChild(win.customEl);
    win.customFor = buf;
    win.customState = null;
  }
  for (const el of [win.spacerEl, win.linesEl, win.cursorEl]) el.style.display = 'none';
  body.style.overflow = 'hidden';
  buf.customRenderer(win, win.customEl, selected);
  win.renderedBuffer = buf;
}

function leaveCustom(win) {
  win.customEl.remove();
  win.customEl = null;
  win.customFor = null;
  for (const el of [win.spacerEl, win.linesEl, win.cursorEl]) el.style.display = '';
  win.bodyEl.style.overflow = '';
  win.renderKey = null;
}

export function renderView(win, selected, point) {
  const buf = win.buffer;
  const body = win.bodyEl;
  if (buf.customRenderer) {
    renderCustom(win, selected);
    return point;
  }
  if (win.customEl) leaveCustom(win);
  const { cw, lh } = viewMetrics();
  const lineCount = buf.lineCount;
  const tabWidth = getVarOr('tab-width', 4, buf);
  const numbers = getVarOr('display-line-numbers', 'relative', buf);
  const gutterChars = gutterWidthChars(buf);
  const gutterPx = gutterPixels(buf);
  const wrapped = !getVarOr('truncate-lines', true, buf);
  body.style.setProperty('--tab-width', tabWidth);

  // Content size (recomputed only when the text changes).
  const sizeKey = `${buf.textVersion}|${tabWidth}`;
  if (win.maxColsKey !== sizeKey || win.maxColsBuffer !== buf) {
    win.maxCols = maxColumns(buf, tabWidth);
    win.maxColsKey = sizeKey;
    win.maxColsBuffer = buf;
  }
  const hscroll = !wrapped && getVarOr('auto-hscroll-mode', true, buf);
  const contentW = hscroll ? gutterPx + (win.maxCols + 2) * cw : 0;
  body.style.overflowX = (hscroll && !wrapped) ? '' : 'hidden';
  
  // Spacer height (will be hidden when wrapping)
  win.spacerEl.style.height = `${lineCount * lh}px`;
  win.spacerEl.style.width = `${contentW}px`;
  win.linesEl.style.minWidth = hscroll ? `max(${contentW}px, 100%)` : '100%';
  if ((!hscroll || wrapped) && body.scrollLeft) setScroll(win, undefined, 0);

  const viewH = body.clientHeight;
  const visibleLines = Math.max(1, Math.floor(viewH / lh));
  const margin = Math.max(0, Math.min(getVarOr('scroll-margin', 3), Math.floor((visibleLines - 1) / 2)));

  let pos = buf.posAt(point);
  const pointMoved = win.lastPoint !== point || win.lastTextVersion !== buf.textVersion || win.renderedBuffer !== buf;

  if (win.renderedBuffer !== buf) setScroll(win, win.scrollTop ?? 0, 0);

  // Keep the cursor visible, or (after a user scroll) keep the cursor inside the view.
  let newPoint = point;
  if (pointMoved && !wrapped) {
    // For non-wrapped lines, use line-based scrolling
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
  let first, last;
  if (wrapped) {
    // When wrapping, render all lines to avoid positioning issues
    // For large buffers, this may need optimization, but it's simpler and correct
    first = 0;
    last = lineCount - 1;
  } else {
    first = Math.max(0, Math.floor(body.scrollTop / lh) - 2);
    last = Math.min(lineCount - 1, Math.ceil((body.scrollTop + viewH) / lh) + 2);
  }
  
  const hl = selected && getVarOr('global-hl-line-mode', true, buf);
  
  // Apply wrapping mode unconditionally (not inside render-key guard)
  if (wrapped) {
    win.linesEl.classList.add('wrapped-mode');
    win.spacerEl.style.display = 'none';
  } else {
    win.linesEl.classList.remove('wrapped-mode');
    win.spacerEl.style.display = '';
  }
  
  const key = `${epoch}|${buf.version}|${first}|${last}|${hl ? pos.line : -1}|${numbers === 'relative' ? pos.line : ''}|${gutterChars}|${tabWidth}|${wrapped}`;
  if (key !== win.renderKey || win.renderedBuffer !== buf) {
    const opts = { win, gutterChars, gutterPx, numbers, pointLine: pos.line, hl, wrapped };
    if (wrapped) {
      renderWrappedLines(win, buf, opts);
    } else {
      win.wrappedRender = null;
      const els = [];
      win.lineEls = new Map();
      for (let i = first; i <= last; i++) {
        const el = renderLine(buf, i, opts);
        win.lineEls.set(i, el);
        els.push(el);
      }
      win.linesEl.replaceChildren(...els);
    }
    
    // Position based on whether we're wrapping
    if (wrapped) {
      // For wrapped lines, don't use transform - render all and let browser handle positioning
      win.linesEl.style.transform = '';
    } else {
      win.linesEl.style.transform = `translateY(${first * lh}px)`;
    }
    win.renderKey = key;
  }

  // Cursor.
  const cursor = win.cursorEl;
  const showCursor = (selected || getVarOr('cursor-in-non-selected-windows', true, buf)) && !buf.cursorHidden;
  cursor.hidden = !showCursor;
  if (showCursor) {
    const lineText = buf.lineText(pos.line);
    const state = selected ? buf.state : 'inactive';
    // A buffer can override the shape (terminals keep a block cursor in insert state).
    const shape = (state !== 'inactive' && buf.cursorShape) || ({ insert: 'bar', replace: 'underline', operator: 'underline', inactive: 'hollow' }[state] ?? 'block');
    cursor.className = `cursor cursor-${shape} state-${state}`;
    
    let cx, cy, w;
    
    if (wrapped) {
      // For wrapped lines, use Range API to get actual cursor position
      const lineEl = win.lineEls.get(pos.line);
      if (lineEl && lineEl.isConnected) {
        const lt = lineEl.querySelector('.lt');
        if (lt) {
          // Get DOM position for the cursor column
          const domPos = domPosition(lt, pos.col);
          if (domPos) {
            const range = document.createRange();
            const bodyRect = body.getBoundingClientRect();
            
            if (pos.col < lineText.length) {
              // Position cursor at the character position
              // First, get the insertion point at pos.col
              range.setStart(domPos.node, domPos.offset);
              range.setEnd(domPos.node, domPos.offset);
              const insertRect = range.getBoundingClientRect();
              
              // Then measure the character to get its width
              const nextDomPos = domPosition(lt, pos.col + 1);
              if (nextDomPos) {
                range.setStart(domPos.node, domPos.offset);
                range.setEnd(nextDomPos.node, nextDomPos.offset);
                
                // Get all rects for the character
                const rects = range.getClientRects();
                
                if (rects.length > 0) {
                  // When a character wraps, getClientRects() can return multiple rects
                  // Find the rect with non-zero width (that's where the character actually appears)
                  let charRect = null;
                  for (let i = 0; i < rects.length; i++) {
                    if (rects[i].width > 0) {
                      charRect = rects[i];
                      break;
                    }
                  }
                  
                  // If all rects have zero width (shouldn't happen), use the last one
                  if (!charRect) charRect = rects[rects.length - 1];
                  
                  // The cursor should be where the character actually appears
                  cx = charRect.left - bodyRect.left + body.scrollLeft;
                  cy = charRect.top - bodyRect.top + body.scrollTop;
                  w = charRect.width || cw;
                } else {
                  // Fallback
                  cx = insertRect.left - bodyRect.left + body.scrollLeft;
                  cy = insertRect.top - bodyRect.top + body.scrollTop;
                  w = cw;
                }
              } else {
                // Fallback: use insertion point
                cx = insertRect.left - bodyRect.left + body.scrollLeft;
                cy = insertRect.top - bodyRect.top + body.scrollTop;
                w = cw;
              }
            } else {
              // At end of line - use insertion point
              range.setStart(domPos.node, domPos.offset);
              range.setEnd(domPos.node, domPos.offset);
              const rect = range.getBoundingClientRect();
              cx = rect.left - bodyRect.left + body.scrollLeft;
              cy = rect.top - bodyRect.top + body.scrollTop;
              w = cw;
            }
          } else if (lt.lastElementChild?.dataset.virtual) {
            // No real text, only display text (e.g. an agent's empty "❯ " input line): after it.
            const r = lt.lastElementChild.getBoundingClientRect();
            const bodyRect = body.getBoundingClientRect();
            cx = r.right - bodyRect.left + body.scrollLeft;
            cy = r.top - bodyRect.top + body.scrollTop;
            w = cw;
          } else {
            // Fallback to old method
            const geom = columnGeometry(win, buf, pos.line, pos.col, tabWidth);
            cx = gutterPx + geom.x;
            cy = lineEl.offsetTop;
            w = geom.w;
          }
        } else {
          // Fallback
          const geom = columnGeometry(win, buf, pos.line, pos.col, tabWidth);
          cx = gutterPx + geom.x;
          cy = lineEl ? lineEl.offsetTop : pos.line * lh;
          w = geom.w;
        }
      } else {
        // No line element, fallback
        const geom = columnGeometry(win, buf, pos.line, pos.col, tabWidth);
        cx = gutterPx + geom.x;
        cy = pos.line * lh;
        w = geom.w;
      }
    } else {
      // Normal (non-wrapped) mode
      const geom = columnGeometry(win, buf, pos.line, pos.col, tabWidth);
      cx = gutterPx + geom.x;
      cy = pos.line * lh;
      w = geom.w;
    }
    
    // Set cursor character - show space for special chars
    const ch = pos.col < lineText.length ? lineText[pos.col] : ' ';
    cursor.textContent = (ch === '\t' || ch === '\n' || ch === '\r') ? ' ' : ch;
    
    cursor.style.width = `${Math.max(w, 2)}px`;
    cursor.style.height = `${lh}px`;
    cursor.style.transform = `translate(${cx}px, ${cy}px)`;
    cursor.dataset.x = cx;
    cursor.dataset.y = cy;

    // Horizontal scrolling to keep the cursor visible.
    if (pointMoved && hscroll) {
      const viewW = body.clientWidth;
      if (cx - gutterPx < body.scrollLeft) setScroll(win, undefined, Math.max(0, cx - gutterPx - 4 * cw));
      else if (cx + w > body.scrollLeft + viewW) setScroll(win, undefined, cx + w - viewW + 4 * cw);
    }
    
    // Vertical scrolling for wrapped lines (use actual cursor Y position)
    if (pointMoved && wrapped) {
      const cursorTop = cy;
      const cursorBottom = cy + lh;
      const marginPx = margin * lh;
      if (cursorTop - marginPx < body.scrollTop) {
        setScroll(win, Math.max(0, cursorTop - marginPx), undefined);
      } else if (cursorBottom + marginPx > body.scrollTop + viewH) {
        setScroll(win, cursorBottom + marginPx - viewH, undefined);
      }
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
