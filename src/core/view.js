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
let epoch = 0;                 // bumped to make all windows recompute their lines (unchanged ones are kept)
const globalDecorators = [];   // like buffer.decorators, but applied to every buffer

/** Add a decorator for every buffer: (buf, line, lineStart, lineText) => [{ from, to, face, priority }]. */
export function addGlobalDecorator(fn) { if (!globalDecorators.includes(fn)) globalDecorators.push(fn); }
export function removeGlobalDecorator(fn) { const i = globalDecorators.indexOf(fn); if (i >= 0) globalDecorators.splice(i, 1); }

/**
 * Recompute every window's lines on the next redisplay (after a global decoration change).
 * Only lines whose content changed are rebuilt.
 */
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
  // Only scrolls the user makes (wheel, scrollbar) count as user scrolls, which let the
  // cursor follow the view. The browser also scrolls by itself, e.g. to keep the text in
  // view still when lines above it are laid out (content-visibility) or the text shrinks.
  let pointerDown = false;
  let userInputAt = -Infinity;
  body.addEventListener('wheel', () => { userInputAt = performance.now(); }, { passive: true });
  body.addEventListener('pointerdown', () => {
    pointerDown = true;
    const up = () => {
      pointerDown = false;
      userInputAt = performance.now();
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
    };
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  });
  body.addEventListener('scroll', () => {
    win.scrollTop = body.scrollTop;
    win.scrollLeft = body.scrollLeft;
    const byUser = pointerDown || performance.now() - userInputAt < 500; // smooth scrolling runs on
    if (!win.programmaticScroll && byUser) win.userScrolled = true;
    win.programmaticScroll = false;
    onScroll();
  });
  if (typeof ResizeObserver !== 'undefined') {
    // Redisplay on any size change: wrapped text reflows with the width, and redisplay
    // measures windows once at the start of a frame, so a scrollbar appearing (which
    // changes the height) needs another pass, which also brings the cursor back into view.
    let lastW = 0;
    let lastH = 0;
    new ResizeObserver(() => {
      const w = body.clientWidth;
      const h = body.clientHeight;
      if (w && (w !== lastW || h !== lastH)) {
        lastW = w;
        lastH = h;
        win.sizeChanged = true;
        scheduleRedisplay();
      }
    }).observe(body);
    // Wrapped lines off screen are laid out lazily (content-visibility), so the text's
    // height changes as they come into view; redisplay then to keep the cursor placed.
    new ResizeObserver(() => {
      if (lines.classList.contains('wrapped-mode') && lines.offsetHeight !== win.lastContentH) scheduleRedisplay();
    }).observe(lines);
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

/** Widest line in cells, accounting for tabs (the text keeps this up to date across edits). */
function maxColumns(buf, tabWidth) {
  return buf.text.maxWidth((l) => (l.includes('\t') ? visualColumn(l, l.length, tabWidth) : l.length), tabWidth);
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
function lineData(buf, line, opts) {
  const text = buf.lineText(line);
  const { decos, virtual, lineFaces, images } = lineDecorations(buf, line, buf.lineStart(line), text);
  return { line, text, decos, virtual, lineFaces, images, ...lineChrome(line, opts) };
}

/** The parts of a line that depend on where the cursor is (see patchLine). */
function lineChrome(line, { gutterChars, gutterPx, numbers, pointLine, hl }) {
  let gutter = '';
  if (gutterChars) {
    let n = line + 1;
    if (numbers === 'relative' && line !== pointLine) n = Math.abs(line - pointLine);
    gutter = String(n).padStart(gutterChars - 1);
  }
  const current = line === pointLine;
  return { gutter, gutterPx, current, hlLine: !!(hl && current) };
}

/**
 * Lines with equal signatures have the same content, so an existing element can be kept
 * (and moved to another line number). The line number and cursor-line highlight aren't
 * part of it: patchLine updates those in place, so moving the cursor rebuilds nothing.
 */
const lineSignature = (d) => JSON.stringify([
  d.text, d.decos, d.virtual, d.lineFaces, d.images.map((im) => im.src),
  d.images.length ? [d.line, d.gutterPx] : null, // the image block's indent and cache keys use them
]);

/** Update the parts of a line element that follow the cursor: line number and highlight. */
function patchLine(el, d) {
  const g = el.firstChild;
  if (el.pmGutter !== d.gutter) { g.textContent = d.gutter; el.pmGutter = d.gutter; }
  if (el.pmGutterPx !== d.gutterPx) { g.style.width = `${d.gutterPx}px`; el.pmGutterPx = d.gutterPx; }
  if (el.pmCurrent !== d.current) { g.classList.toggle('current', d.current); el.pmCurrent = d.current; }
  if (el.pmHl !== d.hlLine) { el.classList.toggle('hl-line', d.hlLine); el.pmHl = d.hlLine; }
}

function buildLine(d, win, wrapped) {
  const el = document.createElement('div');
  el.className = 'line';
  if (wrapped) el.classList.add('wrapped');
  for (const f of d.lineFaces) el.classList.add(...f.split(/\s+/).filter(Boolean));
  const g = document.createElement('span');
  g.className = 'gutter';
  el.appendChild(g);
  el.appendChild(renderLineText(d.text, d.decos, d.virtual));
  if (wrapped && d.images.length) {
    el.classList.add('has-images');
    el.appendChild(imageBlock(win, d.images, d.gutterPx, d.line));
  }
  patchLine(el, d);
  return el;
}

/**
 * Lines [first, last] of a buffer that doesn't wrap. Elements from the last render are
 * reused wherever a line's content is unchanged, even if it moved (lines inserted above,
 * scrolling), so an edit or a scroll only builds the lines that are new.
 */
function renderTruncatedLines(win, buf, opts, first, last) {
  const prev = win.truncRender;
  const pool = new Map(); // signature -> unused elements with that content, in order
  if (prev?.buf === buf) {
    prev.sigs.forEach((sig, i) => {
      const list = pool.get(sig);
      if (list) list.push(prev.els[i]);
      else pool.set(sig, [prev.els[i]]);
    });
  }
  const els = [];
  const sigs = [];
  win.lineEls = new Map();
  for (let i = first; i <= last; i++) {
    const d = lineData(buf, i, opts);
    const sig = lineSignature(d);
    let el = pool.get(sig)?.shift();
    if (el) patchLine(el, d);
    else el = buildLine(d, win, false);
    els.push(el);
    sigs.push(sig);
    win.lineEls.set(i, el);
  }
  for (const list of pool.values()) for (const el of list) el.remove();
  // Put the elements in order, moving as few as possible (anything else left goes).
  const parent = win.linesEl;
  let cur = parent.firstChild;
  for (const el of els) {
    if (el === cur) cur = cur.nextSibling;
    else parent.insertBefore(el, cur);
  }
  while (cur) {
    const next = cur.nextSibling;
    cur.remove();
    cur = next;
  }
  win.truncRender = { buf, sigs, els };
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
  const reusable = prev && prev.buf === buf
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
    for (let i = 0; i < head; i++) patchLine(els[i], data[i]);
    for (let i = n - tail; i < n; i++) patchLine(els[i], data[i]);
  }
  win.wrappedRender = { buf, sigs, els };
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

/**
 * Read a window's size and scroll position. Redisplay calls this for every window before
 * it changes anything, so the browser lays the page out once per frame instead of once
 * for every read that follows a change. Rendering then works from these numbers.
 */
export function measureView(win) {
  const b = win.bodyEl;
  if (!b) return;
  win.geom = {
    viewH: b.clientHeight,
    viewW: b.clientWidth,
    scrollTop: b.scrollTop,
    scrollLeft: b.scrollLeft,
    rect: b.getBoundingClientRect(),
    maxTop: Infinity,
    maxLeft: Infinity,
  };
}

/** Set an inline style only if it changed (writes invalidate the browser's layout). */
function setStyle(el, prop, value) {
  const cache = (el.pmStyle ??= {});
  if (cache[prop] !== value) {
    cache[prop] = value;
    el.style.setProperty(prop, value);
  }
}

/** Forget what setStyle wrote (after styles were changed some other way). */
function forgetStyles(...els) {
  for (const el of els) el.pmStyle = null;
}

/** Scroll without the resulting scroll event counting as a user scroll. */
function setScroll(win, top, left) {
  const body = win.bodyEl;
  const g = win.geom;
  if (top !== undefined) {
    top = Math.max(0, Math.min(top, g.maxTop));
    if (Math.abs(g.scrollTop - top) >= 1) {
      win.programmaticScroll = true;
      body.scrollTop = top;
      g.scrollTop = top;
    }
  }
  if (left !== undefined) {
    left = Math.max(0, Math.min(left, g.maxLeft));
    if (Math.abs(g.scrollLeft - left) >= 1) {
      win.programmaticScroll = true;
      body.scrollLeft = left;
      g.scrollLeft = left;
    }
  }
}

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
  forgetStyles(body, win.spacerEl, win.linesEl);
  win.cursorBox = null;
  win.scrollInfo = null;
  buf.customRenderer(win, win.customEl, selected);
  win.renderedBuffer = buf;
}

function leaveCustom(win) {
  win.customEl.remove();
  win.customEl = null;
  win.customFor = null;
  for (const el of [win.spacerEl, win.linesEl, win.cursorEl]) el.style.display = '';
  win.bodyEl.style.overflow = '';
  forgetStyles(win.bodyEl, win.spacerEl, win.linesEl);
  win.renderKey = null;
}

/**
 * Render `win`. `selected`: whether it's the selected window. `point` is the offset to
 * display the cursor at; returns a (possibly adjusted) point if the user scrolled the
 * cursor out of view.
 */
export function renderView(win, selected, point) {
  const buf = win.buffer;
  const body = win.bodyEl;
  if (buf.customRenderer) {
    renderCustom(win, selected);
    return point;
  }
  if (win.customEl) leaveCustom(win);
  if (!win.geom) measureView(win);
  const g = win.geom;
  const { cw, lh } = viewMetrics();
  const lineCount = buf.lineCount;
  const tabWidth = getVarOr('tab-width', 4, buf);
  const numbers = getVarOr('display-line-numbers', 'relative', buf);
  const gutterChars = gutterWidthChars(buf);
  const gutterPx = gutterPixels(buf);
  const wrapped = !getVarOr('truncate-lines', true, buf);
  const userScrolled = win.userScrolled;
  setStyle(body, '--tab-width', String(tabWidth));

  const hscroll = !wrapped && getVarOr('auto-hscroll-mode', true, buf);
  const contentW = hscroll ? gutterPx + (maxColumns(buf, tabWidth) + 2) * cw : 0;
  setStyle(body, 'overflow-x', hscroll ? '' : 'hidden');
  // Spacer height (hidden when wrapping)
  setStyle(win.spacerEl, 'height', `${lineCount * lh}px`);
  setStyle(win.spacerEl, 'width', `${contentW}px`);
  setStyle(win.linesEl, 'min-width', hscroll ? `max(${contentW}px, 100%)` : '100%');
  g.maxTop = wrapped ? Infinity : Math.max(0, lineCount * lh - g.viewH);
  g.maxLeft = hscroll ? Infinity : 0; // wide characters can make lines wider than contentW
  if (g.scrollTop > g.maxTop) g.scrollTop = g.maxTop; // the text got shorter: the browser clamps too
  if (!hscroll && g.scrollLeft) setScroll(win, undefined, 0);

  const viewH = g.viewH;
  const visibleLines = Math.max(1, Math.floor(viewH / lh));
  const margin = Math.max(0, Math.min(getVarOr('scroll-margin', 3), Math.floor((visibleLines - 1) / 2)));

  let pos = buf.posAt(point);
  // (A size change, e.g. a horizontal scrollbar appearing, can also hide the cursor.)
  const pointMoved = win.lastPoint !== point || win.lastTextVersion !== buf.textVersion || win.renderedBuffer !== buf || !!win.sizeChanged;
  win.sizeChanged = false;

  if (win.renderedBuffer !== buf) setScroll(win, win.scrollTop ?? 0, 0);

  // Keep the cursor visible, or (after a user scroll) keep the cursor inside the view.
  let newPoint = point;
  if (pointMoved && !wrapped) {
    // For non-wrapped lines, use line-based scrolling
    const top = (pos.line - margin) * lh;
    const bottom = (pos.line + 1 + margin) * lh;
    if (top < g.scrollTop) setScroll(win, Math.max(0, top));
    else if (bottom > g.scrollTop + viewH) setScroll(win, bottom - viewH);
  } else if (userScrolled) {
    const st = g.scrollTop;
    const first = Math.ceil(st / lh) + (st > 0 ? margin : 0);
    const last = Math.floor((st + viewH) / lh) - 1 - (st + viewH < lineCount * lh ? margin : 0);
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

  // Lines in the DOM.
  let first, last;
  if (wrapped) {
    // Wrapped lines have unknown heights, so all of them are in the DOM (lines off screen
    // skip layout and paint: content-visibility in style.css).
    first = 0;
    last = lineCount - 1;
  } else {
    // A screen of lines above and below the visible ones, so scrolling within them is
    // just the browser moving the page; past them, the range moves (keeping elements).
    // After a jump nothing can be kept, so only the visible lines are built at once and
    // the rest when the browser is idle.
    const vFirst = Math.max(0, Math.floor(g.scrollTop / lh));
    const vLast = Math.min(lineCount - 1, Math.ceil((g.scrollTop + viewH) / lh));
    const over = visibleLines;
    const had = win.renderedBuffer === buf && (win.rangeFirst ?? -1) >= 0;
    first = had ? win.rangeFirst : -1;
    last = had ? Math.min(win.rangeLast, lineCount - 1) : -1;
    if (!had || vFirst < first || vLast > last) {
      const near = had && vFirst <= last + over && vLast >= first - over;
      const m = near ? over : 2;
      first = Math.max(0, vFirst - m);
      last = Math.min(lineCount - 1, vLast + m);
      if (near) win.growRange = null;
      else scheduleGrowRange(win);
    } else if (win.growRange === 'now') {
      win.growRange = null;
      first = Math.max(0, vFirst - over);
      last = Math.min(lineCount - 1, vLast + over);
    }
    win.rangeFirst = first;
    win.rangeLast = last;
  }

  const hl = selected && getVarOr('global-hl-line-mode', true, buf);

  win.linesEl.classList.toggle('wrapped-mode', wrapped);
  setStyle(win.spacerEl, 'display', wrapped ? 'none' : '');

  // What the lines show, and (separately) what depends on the cursor line: when only the
  // cursor moved to another line, the existing lines are patched and nothing is recomputed.
  const key = `${epoch}|${buf.version}|${first}|${last}|${gutterChars}|${tabWidth}|${wrapped}`;
  const chromeKey = `${hl ? pos.line : -1}|${numbers === 'relative' ? pos.line : ''}|${gutterPx}`;
  const opts = { win, gutterChars, gutterPx, numbers, pointLine: pos.line, hl, wrapped };
  let patch = null; // run after the cursor is measured, which then needs no new layout
  if (key === win.renderKey && win.renderedBuffer === buf) {
    if (chromeKey !== win.chromeKey) {
      patch = () => {
        for (const [line, el] of win.lineEls) patchLine(el, lineChrome(line, opts));
        win.chromeKey = chromeKey;
      };
    }
  } else {
    win.chromeKey = chromeKey;
    if (wrapped) {
      win.truncRender = null;
      renderWrappedLines(win, buf, opts);
      setStyle(win.linesEl, 'transform', '');
    } else {
      win.wrappedRender = null;
      renderTruncatedLines(win, buf, opts, first, last);
      setStyle(win.linesEl, 'transform', `translateY(${first * lh}px)`);
    }
    win.renderKey = key;
  }

  // Wrapped text: the browser has to lay it out before anything can be measured.
  let contentH = lineCount * lh;
  if (wrapped) {
    contentH = win.linesEl.offsetHeight; // not scrollHeight: that includes the cursor where it was
    g.scrollTop = body.scrollTop;
    g.scrollLeft = body.scrollLeft;
    g.maxTop = Math.max(0, contentH - viewH);
  }

  // Cursor: measure first, then scroll, then write, so nothing is laid out twice.
  const cursor = win.cursorEl;
  const showCursor = (selected || getVarOr('cursor-in-non-selected-windows', true, buf)) && !buf.cursorHidden;
  let cursorVisible = false;
  win.cursorBox = null;
  if (cursor.hidden !== !showCursor) cursor.hidden = !showCursor;
  if (showCursor) {
    const lineText = buf.lineText(pos.line);
    const state = selected ? buf.state : 'inactive';
    // A buffer can override the shape (terminals keep a block cursor in insert state).
    const shape = (state !== 'inactive' && buf.cursorShape) || ({ insert: 'bar', replace: 'underline', operator: 'underline', inactive: 'hollow' }[state] ?? 'block');

    const { cx, cy, w } = wrapped
      ? wrappedCursorGeometry(win, buf, pos, lineText, tabWidth, gutterPx)
      : (() => { const geom = columnGeometry(win, buf, pos.line, pos.col, tabWidth); return { cx: gutterPx + geom.x, cy: pos.line * lh, w: geom.w }; })();
    patch?.();
    patch = null;

    // Horizontal scrolling to keep the cursor visible.
    if (pointMoved && hscroll) {
      if (cx - gutterPx < g.scrollLeft) setScroll(win, undefined, Math.max(0, cx - gutterPx - 4 * cw));
      else if (cx + w > g.scrollLeft + g.viewW) setScroll(win, undefined, cx + w - g.viewW + 4 * cw);
    }

    // Vertical scrolling for wrapped lines (use actual cursor Y position). Also when the
    // text reflowed (lines above were laid out) under a cursor that was settled in view.
    if (wrapped) {
      const marginPx = margin * lh;
      const want = () => {
        let t = g.scrollTop;
        if (cy - marginPx < t) t = cy - marginPx;
        else if (cy + lh + marginPx > t + viewH) t = cy + lh + marginPx - viewH;
        return Math.max(0, Math.min(t, g.maxTop));
      };
      const reflowed = !userScrolled && win.cursorWasVisible && contentH !== win.lastContentH;
      if (pointMoved || reflowed) setScroll(win, want(), undefined);
      cursorVisible = Math.abs(want() - g.scrollTop) < 1;
    }

    // Set cursor character - show space for special chars
    const ch = pos.col < lineText.length ? lineText[pos.col] : ' ';
    const text = (ch === '\t' || ch === '\n' || ch === '\r') ? ' ' : ch;
    const className = `cursor cursor-${shape} state-${state}`;
    if (cursor.className !== className) cursor.className = className;
    if (cursor.textContent !== text) cursor.textContent = text;
    setStyle(cursor, 'width', `${Math.max(w, 2)}px`);
    setStyle(cursor, 'height', `${lh}px`);
    setStyle(cursor, 'transform', `translate(${cx}px, ${cy}px)`);
    win.cursorBox = { x: cx, y: cy, w: Math.max(w, 2), h: lh };
  }
  patch?.();

  win.cursorWasVisible = cursorVisible;
  win.lastContentH = contentH;
  win.scrollInfo = { top: g.scrollTop, height: contentH, viewH };
  win.lastPoint = newPoint;
  win.lastTextVersion = buf.textVersion;
  win.renderedBuffer = buf;
  return newPoint;
}

/** Build the rest of a window's lines (around the visible ones) once the browser is idle. */
function scheduleGrowRange(win) {
  if (win.growRange) return;
  win.growRange = 'pending';
  const grow = () => {
    if (win.growRange !== 'pending') return;
    win.growRange = 'now';
    scheduleRedisplay();
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(grow, { timeout: 300 });
  else setTimeout(grow, 50);
}

/** Cursor position in a wrapped buffer, measured from the laid-out line: { cx, cy, w }. */
function wrappedCursorGeometry(win, buf, pos, lineText, tabWidth, gutterPx) {
  const { cw, lh } = viewMetrics();
  const body = win.bodyEl;
  const lineEl = win.lineEls.get(pos.line);
  const fallback = () => {
    const geom = columnGeometry(win, buf, pos.line, pos.col, tabWidth);
    return { cx: gutterPx + geom.x, cy: lineEl?.isConnected ? lineEl.offsetTop : pos.line * lh, w: geom.w };
  };
  if (!lineEl?.isConnected) return fallback();
  const lt = lineEl.querySelector('.lt');
  if (!lt) return fallback();
  const bodyRect = body.getBoundingClientRect();
  const at = (rect, w) => ({ cx: rect.left - bodyRect.left + body.scrollLeft, cy: rect.top - bodyRect.top + body.scrollTop, w });
  const domPos = domPosition(lt, pos.col);
  if (!domPos) {
    // No real text, only display text (e.g. an agent's empty "❯ " input line): after it.
    if (lt.lastElementChild?.dataset.virtual) {
      const r = lt.lastElementChild.getBoundingClientRect();
      return at({ left: r.right, top: r.top }, cw);
    }
    return fallback();
  }
  const range = document.createRange();
  range.setStart(domPos.node, domPos.offset);
  range.setEnd(domPos.node, domPos.offset);
  const insertRect = range.getBoundingClientRect();
  if (pos.col >= lineText.length) return at(insertRect, cw); // end of line: the insertion point
  const next = domPosition(lt, pos.col + 1);
  if (!next) return at(insertRect, cw);
  range.setEnd(next.node, next.offset);
  // When a character wraps, getClientRects() can return several rects; the one with a
  // width is where the character actually appears.
  const rects = range.getClientRects();
  if (!rects.length) return at(insertRect, cw);
  let charRect = null;
  for (const r of rects) if (r.width > 0) { charRect = r; break; }
  charRect ??= rects[rects.length - 1];
  return at(charRect, charRect.width || cw);
}

/**
 * Screen rectangle of the cursor in `win`, for positioning the input element. Computed
 * from this frame's measurements, so it doesn't make the browser lay out the page again.
 */
export function cursorClientRect(win) {
  const box = win.cursorBox;
  const g = win.geom;
  if (!box || !g) return win.cursorEl?.getBoundingClientRect() ?? null;
  const left = g.rect.left + box.x - g.scrollLeft;
  const top = g.rect.top + box.y - g.scrollTop;
  return { left, top, width: box.w, height: box.h, right: left + box.w, bottom: top + box.h };
}

/** Where a window is scrolled: { top, height, viewH } (px), from its last redisplay. */
export function viewScrollInfo(win) {
  return win.scrollInfo ?? null;
}

/** Number of fully visible lines in a window. */
export function visibleLineCount(win) {
  const { lh } = viewMetrics();
  // The last redisplay's measurement, if any (reading the DOM could force a layout).
  return Math.max(1, Math.floor((win.geom?.viewH ?? win.bodyEl?.clientHeight ?? lh) / lh));
}
