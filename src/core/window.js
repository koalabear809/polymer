// Windows: a tree of splits whose leaves show buffers.
//
// Splits are n-ary: splitting a window in the same direction as its parent adds a
// sibling instead of nesting. Each leaf renders its buffer plus a mode line.

import { onRedisplay, scheduleRedisplay } from './redisplay.js';
import { setBuffer, bumpBuffer, getBuffer, bufferList, currentBuffer } from './buffer.js';
import { majorModeInfo, minorModeInfo } from './modes.js';
import { runHooks, getVarOr, defvar } from './registry.js';
import { PolymerError } from './errors.js';
import { Marker } from './marker.js';
import { createView, renderView, offsetFromEvent, viewMetrics, visibleLineCount } from './view.js';
import { focusInput } from './focus.js';

defvar('mode-line-format', null, {
  doc: 'Function (window, buffer) => string for the mode line, or null for the default.',
});
defvar('mode-line-segments', [], {
  doc: 'Functions (window, buffer) => string shown at the start of the default mode line (empty strings are skipped).',
});

let nextId = 1;
let root = null;     // { type: 'leaf', window } | { type: 'split', dir: 'row'|'column', children, weights }
let selected = null; // Window
let container = null;
let layoutDirty = true;

export class Window {
  constructor(buffer) {
    this.id = nextId++;
    this.buffer = buffer;
    // Each window has its own point; the selected window's point is the buffer's point.
    this.point = new Marker(buffer, buffer.point.pos, buffer.point.insertionType);
    this.prevBuffers = [];   // for quit-window / previous-buffer
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.renderedBuffer = null;
    this.el = null;
    this.bodyEl = null;
    this.modeLineEl = null;
  }
  get live() { return !!findLeaf(root, this); }
  toString() { return `#<window ${this.id} on ${this.buffer?.name}>`; }
}

function leaf(win) { return { type: 'leaf', window: win }; }

function findLeaf(node, win, parent = null) {
  if (!node) return null;
  if (node.type === 'leaf') return node.window === win ? { node, parent } : null;
  for (const c of node.children) {
    const r = findLeaf(c, win, node);
    if (r) return r;
  }
  return null;
}

/** All windows in tree order (left-to-right, top-to-bottom). */
export function windowList() {
  const out = [];
  const visit = (n) => (n.type === 'leaf' ? out.push(n.window) : n.children.forEach(visit));
  if (root) visit(root);
  return out;
}

export const selectedWindow = () => selected;

export function selectWindow(win) {
  if (!findLeaf(root, win)) throw new PolymerError('error', 'Window is not live');
  if (selected !== win) {
    if (selected?.buffer?.live) selected.point.set(selected.buffer.point.pos, selected.buffer);
    selected = win;
    win.buffer.point.set(win.point.pos);
    setBuffer(win.buffer);
    bumpBuffer(win.buffer);
    runHooks('window-selection-change-hook', win);
  }
  scheduleRedisplay();
  return win;
}

export function initWindows(el, buffer) {
  container = el;
  const w = new Window(buffer);
  root = leaf(w);
  selected = w;
  setBuffer(buffer);
  layoutDirty = true;
  scheduleRedisplay();
  window.addEventListener('resize', () => scheduleRedisplay());
}

/** Show `buffer` in `win` (default: selected window). */
export function setWindowBuffer(win, buffer) {
  const b = getBuffer(buffer);
  if (!b) throw new PolymerError('error', `No such buffer: ${buffer}`);
  if (win.buffer === b) return;
  if (win.buffer) {
    win.prevBuffers = [win.buffer, ...win.prevBuffers.filter((x) => x !== win.buffer && x !== b)].slice(0, 50);
  }
  win.buffer = b;
  win.point.insertionType = b.point.insertionType;
  win.point.set(b.point.pos, b);
  win.scrollTop = 0;
  win.scrollLeft = 0;
  if (win === selected) {
    setBuffer(b);
    bumpBuffer(b);
  }
  runHooks('window-buffer-change-hook', win);
  scheduleRedisplay();
}

/** Display a buffer: reuse a window already showing it, else the selected window. */
export function displayBuffer(buffer, { select = true, otherWindow = false } = {}) {
  const b = getBuffer(buffer);
  let win = windowList().find((w) => w.buffer === b);
  if (!win) {
    if (otherWindow) {
      const others = windowList().filter((w) => w !== selected);
      win = others[0];
      if (!win) {
        win = splitWindow(selected, 'below');
        win.quitRestore = 'delete'; // quit-window deletes a window made just for this
      }
    } else {
      win = selected;
    }
    setWindowBuffer(win, b);
  }
  if (select) selectWindow(win);
  return win;
}

/**
 * Split `win`. side: 'below' | 'right'. Returns the new window, which shows the same buffer.
 */
export function splitWindow(win = selected, side = 'below') {
  const dir = side === 'right' ? 'row' : 'column';
  const found = findLeaf(root, win);
  if (!found) throw new PolymerError('error', 'Window is not live');
  const nw = new Window(win.buffer);
  nw.point.set(win === selected ? win.buffer.point.pos : win.point.pos);
  nw.scrollTop = win.scrollTop;
  nw.prevBuffers = [...win.prevBuffers];
  const { node, parent } = found;
  if (parent && parent.dir === dir) {
    const i = parent.children.indexOf(node);
    const w = parent.weights[i] / 2;
    parent.children.splice(i + 1, 0, leaf(nw));
    parent.weights.splice(i, 1, w, w);
  } else {
    const split = { type: 'split', dir, children: [leaf(win), leaf(nw)], weights: [1, 1] };
    if (!parent) root = split;
    else parent.children[parent.children.indexOf(node)] = split;
  }
  layoutDirty = true;
  scheduleRedisplay();
  runHooks('window-configuration-change-hook');
  return nw;
}

export function deleteWindow(win = selected) {
  const found = findLeaf(root, win);
  if (!found) throw new PolymerError('error', 'Window is not live');
  const { node, parent } = found;
  if (!parent) throw new PolymerError('error', 'Attempt to delete minibuffer or sole ordinary window');
  const i = parent.children.indexOf(node);
  const order = windowList();
  parent.children.splice(i, 1);
  const [freed] = parent.weights.splice(i, 1);
  parent.weights[Math.max(0, i - 1)] += freed;
  if (parent.children.length === 1) {
    // Collapse the split into its remaining child.
    const only = parent.children[0];
    const gp = findParent(root, parent);
    if (!gp) root = only;
    else {
      const j = gp.children.indexOf(parent);
      if (only.type === 'split' && only.dir === gp.dir) {
        gp.children.splice(j, 1, ...only.children);
        const total = only.weights.reduce((a, b) => a + b, 0);
        gp.weights.splice(j, 1, ...only.weights.map((w) => (w / total) * gp.weights[j]));
      } else {
        gp.children[j] = only;
      }
    }
  }
  if (selected === win) {
    const idx = order.indexOf(win);
    const remaining = windowList();
    selectWindow(remaining[Math.max(0, Math.min(idx - 1, remaining.length - 1))] ?? remaining[0]);
  }
  layoutDirty = true;
  scheduleRedisplay();
  runHooks('window-configuration-change-hook');
}

function findParent(node, target) {
  if (node.type !== 'split') return null;
  for (const c of node.children) {
    if (c === target) return node;
    const r = findParent(c, target);
    if (r) return r;
  }
  return null;
}

/**
 * A snapshot of the window layout: splits with their sizes, and for each window its
 * buffer, point, scroll position and whether it is selected. Buffers are live objects;
 * use this in memory (perspectives serialize it themselves).
 */
export function windowConfiguration() {
  const snap = (node) => {
    if (node.type === 'leaf') {
      const w = node.window;
      return {
        type: 'leaf',
        buffer: w.buffer,
        point: w === selected ? w.buffer.point.pos : w.point.pos,
        scrollTop: w.scrollTop ?? 0,
        selected: w === selected,
        prevBuffers: [...w.prevBuffers],
      };
    }
    return { type: 'split', dir: node.dir, weights: [...node.weights], children: node.children.map(snap) };
  };
  return root ? snap(root) : null;
}

/**
 * Replace the window layout with a configuration from windowConfiguration(). Windows
 * whose buffer is gone show `fallback` instead.
 */
export function setWindowConfiguration(config, fallback) {
  if (!config) return;
  for (const w of windowList()) w.point.detach();
  let sel = null;
  const build = (n) => {
    if (n.type === 'leaf') {
      const live = n.buffer?.live;
      const buf = live ? n.buffer : fallback;
      const w = new Window(buf);
      w.point.set(live ? n.point : buf.point.pos);
      w.scrollTop = live ? n.scrollTop ?? 0 : 0;
      w.prevBuffers = (n.prevBuffers ?? []).filter((b) => b.live && b !== buf);
      if (n.selected) sel = w;
      return leaf(w);
    }
    const children = n.children.map(build);
    return { type: 'split', dir: n.dir, weights: [...(n.weights ?? children.map(() => 1))], children };
  };
  root = build(config);
  const target = sel ?? windowList()[0];
  selected = target;
  target.buffer.point.set(target.point.pos);
  setBuffer(target.buffer);
  bumpBuffer(target.buffer);
  layoutDirty = true;
  scheduleRedisplay();
  runHooks('window-configuration-change-hook');
}

export function deleteOtherWindows(win = selected) {
  root = leaf(win);
  selectWindow(win);
  layoutDirty = true;
  scheduleRedisplay();
  runHooks('window-configuration-change-hook');
}

export function balanceWindows() {
  const visit = (n) => {
    if (n.type !== 'split') return;
    n.weights = n.children.map(() => 1);
    n.children.forEach(visit);
  };
  if (root) visit(root);
  layoutDirty = true;
  scheduleRedisplay();
}

/** Select the window `n` steps away in tree order. */
export function otherWindow(n = 1) {
  const ws = windowList();
  const i = ws.indexOf(selected);
  return selectWindow(ws[(((i + n) % ws.length) + ws.length) % ws.length]);
}

/** The window adjacent to `win` in direction 'left' | 'right' | 'up' | 'down', or null. */
export function windowInDirection(dir, win = selected) {
  const r = win.el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  let best = null;
  let bestDist = Infinity;
  for (const w of windowList()) {
    if (w === win) continue;
    const o = w.el.getBoundingClientRect();
    const eps = 2;
    let ok = false;
    if (dir === 'left') ok = o.right <= r.left + eps && o.bottom > r.top && o.top < r.bottom;
    if (dir === 'right') ok = o.left >= r.right - eps && o.bottom > r.top && o.top < r.bottom;
    if (dir === 'up') ok = o.bottom <= r.top + eps && o.right > r.left && o.left < r.right;
    if (dir === 'down') ok = o.top >= r.bottom - eps && o.right > r.left && o.left < r.right;
    if (!ok) continue;
    const d = Math.hypot(o.left + o.width / 2 - cx, o.top + o.height / 2 - cy);
    if (d < bestDist) { bestDist = d; best = w; }
  }
  return best;
}

/** Return to the previous buffer shown in `win`. */
export function switchToPrevBuffer(win = selected, { bury = false } = {}) {
  const cur = win.buffer;
  const prev = win.prevBuffers.find((b) => b.live && b !== cur)
    ?? bufferList().find((b) => b !== cur && !windowList().some((w) => w.buffer === b));
  if (!prev) return null;
  setWindowBuffer(win, prev);
  if (bury) win.prevBuffers = win.prevBuffers.filter((b) => b !== cur);
  return prev;
}

/** Replace a killed buffer in every window showing it. */
export function replaceBufferInWindows(buf) {
  for (const w of windowList()) {
    if (w.buffer !== buf) continue;
    w.prevBuffers = w.prevBuffers.filter((b) => b !== buf && b.live);
    const next = w.prevBuffers[0] ?? bufferList().find((b) => b !== buf);
    if (next) setWindowBuffer(w, next);
  }
}

// ---------------------------------------------------------------------------
// Rendering

function onWindowMouseDown(w, e) {
  if (e.button !== 0) return;
  const body = w.bodyEl;
  const inBody = body.contains(e.target);
  // Ignore clicks on the scrollbars.
  const r = body.getBoundingClientRect();
  const onScrollbar = e.clientX - r.left > body.clientWidth || e.clientY - r.top > body.clientHeight;
  if (selected !== w) selectWindow(w);
  if (inBody && !onScrollbar) {
    e.preventDefault();
    const off = offsetFromEvent(w, e);
    w.buffer.point.set(off);
    w.point.set(off);
    runHooks('mouse-set-point-hook', w, off);
    scheduleRedisplay();
    // Dragging selects (the vim layer turns this into visual state).
    let last = off;
    const move = (ev) => {
      const p = offsetFromEvent(w, ev);
      if (p === last) return;
      last = p;
      runHooks('mouse-drag-hook', w, off, p);
      w.point.set(w.buffer.point.pos);
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }
  focusInput();
}

function buildLayout(node) {
  if (node.type === 'leaf') {
    const w = node.window;
    if (!w.el) {
      w.el = document.createElement('div');
      w.el.className = 'window';
      const body = createView(w, () => scheduleRedisplay());
      w.modeLineEl = document.createElement('div');
      w.modeLineEl.className = 'mode-line';
      w.el.append(body, w.modeLineEl);
      w.el.addEventListener('mousedown', (e) => onWindowMouseDown(w, e));
      // Buffers can take over the wheel (a terminal scrolls its own history).
      body.addEventListener('wheel', (e) => {
        if (w.buffer?.onWheel && w.buffer.onWheel(e, w)) e.preventDefault();
      }, { passive: false });
    }
    return w.el;
  }
  const el = document.createElement('div');
  el.className = `split split-${node.dir}`;
  node.el = el;
  node.children.forEach((c, i) => {
    if (i > 0) el.appendChild(makeDivider(node, i - 1));
    const child = buildLayout(c);
    child.style.flex = `${node.weights[i]} 1 0`;
    el.appendChild(child);
  });
  return el;
}

const elementOf = (node) => (node.type === 'leaf' ? node.window.el : node.el);

/** Smallest size (px) a child of a split may shrink to. */
function minSize(horizontal) {
  const { cw, lh } = viewMetrics();
  return horizontal ? 10 * cw : 3 * lh;
}

/**
 * Give a split's children new pixel sizes (in order). Sizes become weights, so they
 * scale with the frame afterwards.
 */
function applySizes(node, sizes) {
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  const weightSum = node.weights.reduce((a, b) => a + b, 0) || node.children.length;
  node.weights = sizes.map((s) => (s / total) * weightSum);
  node.children.forEach((c, i) => {
    const el = elementOf(c);
    if (el) el.style.flex = `${node.weights[i]} 1 0`;
  });
  scheduleRedisplay();
  runHooks('window-size-change-hook');
}

function childSizes(node) {
  const horizontal = node.dir === 'row';
  return node.children.map((c) => {
    const r = elementOf(c)?.getBoundingClientRect();
    return r ? (horizontal ? r.width : r.height) : 0;
  });
}

/** Move `delta` px from child j to child i of a split (negative shrinks i). */
function transfer(node, i, j, delta) {
  const horizontal = node.dir === 'row';
  const sizes = childSizes(node);
  const min = minSize(horizontal);
  const d = Math.max(min - sizes[i], Math.min(sizes[j] - min, delta));
  sizes[i] += d;
  sizes[j] -= d;
  applySizes(node, sizes);
  return d;
}

function makeDivider(node, i) {
  const div = document.createElement('div');
  div.className = 'divider';
  div.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const horizontal = node.dir === 'row';
    const start = horizontal ? e.clientX : e.clientY;
    const startSizes = childSizes(node);
    const min = minSize(horizontal);
    const pair = startSizes[i] + startSizes[i + 1];
    document.body.classList.add(horizontal ? 'resizing-col' : 'resizing-row');
    const move = (ev) => {
      const delta = (horizontal ? ev.clientX : ev.clientY) - start;
      const a = Math.max(min, Math.min(pair - min, startSizes[i] + delta));
      const sizes = [...startSizes];
      sizes[i] = a;
      sizes[i + 1] = pair - a;
      applySizes(node, sizes);
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing-col', 'resizing-row');
      focusInput();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  // Double-click a divider to even out its two windows.
  div.addEventListener('dblclick', () => {
    const sizes = childSizes(node);
    const half = (sizes[i] + sizes[i + 1]) / 2;
    sizes[i] = half;
    sizes[i + 1] = half;
    applySizes(node, sizes);
  });
  return div;
}

/** The split (and the child of it containing `win`) that sizes `win` in a direction. */
function sizingSplit(win, horizontal) {
  const found = findLeaf(root, win);
  if (!found) throw new PolymerError('error', 'Window is not live');
  let node = found.node;
  let parent = found.parent;
  while (parent && parent.dir !== (horizontal ? 'row' : 'column')) {
    node = parent;
    parent = findParent(root, parent);
  }
  return parent ? { parent, index: parent.children.indexOf(node) } : null;
}

/**
 * Grow `win` by `lines` lines (or columns, if horizontal); negative shrinks. Space comes
 * from the neighbouring window. Returns the change actually made, in lines/columns.
 */
export function resizeWindow(win = selected, lines = 1, horizontal = false) {
  const s = sizingSplit(win, horizontal);
  if (!s) throw new PolymerError('user-error', `No window ${horizontal ? 'beside' : 'above or below'} this one to take space from`);
  const { parent, index } = s;
  const j = index < parent.children.length - 1 ? index + 1 : index - 1;
  const { cw, lh } = viewMetrics();
  const unit = horizontal ? cw : lh;
  return Math.round(transfer(parent, index, j, lines * unit) / unit);
}

/** Make `win` as large as possible in one direction (the others keep their minimum). */
export function maximizeWindow(win = selected, horizontal = false) {
  const s = sizingSplit(win, horizontal);
  if (!s) return;
  const { parent, index } = s;
  const sizes = childSizes(parent);
  const total = sizes.reduce((a, b) => a + b, 0);
  const min = minSize(horizontal);
  const out = sizes.map((_, i) => (i === index ? total - min * (sizes.length - 1) : min));
  applySizes(parent, out);
}

const STATE_TAGS = { normal: 'N', insert: 'I', visual: 'V', 'visual-line': 'VL', 'visual-block': 'VB', motion: 'M', emacs: 'E', replace: 'R', operator: 'O' };

function defaultModeLine(win, buf) {
  const mode = majorModeInfo(buf.mode);
  const minors = [...buf.minorModes].map((m) => minorModeInfo(m)?.lighter).filter(Boolean);
  const point = win === selected ? buf.point.pos : win.point.pos;
  const { line, col } = buf.posAt(point);
  const flag = buf.readOnly ? (buf.modified && buf.file ? '%*' : '%%') : (buf.modified ? '**' : '--');
  const body = win.bodyEl;
  let where = 'All';
  if (body && body.scrollHeight > body.clientHeight + 1) {
    if (body.scrollTop <= 0) where = 'Top';
    else if (body.scrollTop + body.clientHeight >= body.scrollHeight - 1) where = 'Bot';
    else where = `${Math.round((body.scrollTop / (body.scrollHeight - body.clientHeight)) * 100)}%`;
  }
  let state = buf.state;
  if (state === 'visual') state = { line: 'visual-line', block: 'visual-block' }[buf.vim?.visual?.type] ?? 'visual';
  const segments = getVarOr('mode-line-segments', [], buf)
    .map((f) => { try { return f(win, buf); } catch { return ''; } })
    .filter(Boolean);
  // Buffers that aren't text describe themselves instead of line:column.
  const position = buf.modeLineInfo ? buf.modeLineInfo(win) : `${line + 1}:${col}  ${where}`;
  return {
    state,
    left: `${segments.length ? `${segments.join(' ')} ` : ''}${flag} ${buf.name}`,
    right: `${position}  (${[mode?.lighter ?? buf.mode, ...minors].join(' ')})`,
  };
}

function renderModeLine(win) {
  const buf = win.buffer;
  const fmt = getVarOr('mode-line-format', null, buf);
  const el = win.modeLineEl;
  el.classList.toggle('active', win === selected);
  el.replaceChildren();
  if (typeof fmt === 'function') {
    el.textContent = String(fmt(win, buf));
    return;
  }
  const m = defaultModeLine(win, buf);
  const tag = document.createElement('span');
  tag.className = `state-tag state-${m.state.replace(/^visual-.*/, 'visual')}`;
  tag.textContent = ` ${STATE_TAGS[m.state] ?? '?'} `;
  const left = document.createElement('span');
  left.className = 'ml-left';
  left.textContent = m.left;
  const right = document.createElement('span');
  right.className = 'ml-right';
  right.textContent = m.right;
  el.append(tag, left, right);
}

function renderWindow(win) {
  const buf = win.buffer;
  const isSel = win === selected;
  // The selected window shows (and owns) the buffer's point.
  const point = isSel ? buf.point.pos : win.point.pos;
  const newPoint = renderView(win, isSel, point);
  if (isSel) {
    if (newPoint !== point) buf.point.set(newPoint);
    win.point.set(buf.point.pos);
  } else if (newPoint !== point) {
    win.point.set(newPoint);
  }
  win.el.classList.toggle('selected', isSel);
  renderModeLine(win);
}

function redisplayWindows() {
  if (!container || !root) return;
  if (layoutDirty) {
    container.replaceChildren(buildLayout(root));
    for (const w of windowList()) {
      // Re-attaching resets scroll positions; restore them without it counting as a user scroll.
      if (w.bodyEl.scrollTop !== w.scrollTop || w.bodyEl.scrollLeft !== (w.scrollLeft ?? 0)) {
        w.programmaticScroll = true;
        w.bodyEl.scrollTop = w.scrollTop;
        w.bodyEl.scrollLeft = w.scrollLeft ?? 0;
      }
      w.renderKey = null;
    }
    layoutDirty = false;
  }
  // Render the selected window last so it can position the input element.
  for (const w of windowList()) if (w !== selected) renderWindow(w);
  if (selected) renderWindow(selected);
  runHooks('post-redisplay-hook', selected);
}

onRedisplay(redisplayWindows);

/** Scroll a window by `lines` (negative scrolls up). The cursor follows if it leaves the view. */
export function scrollWindow(lines, win = selected) {
  win.bodyEl.scrollTop += lines * viewMetrics().lh;
  win.scrollTop = win.bodyEl.scrollTop;
  win.userScrolled = true;
  scheduleRedisplay();
}

export function windowBodyLines(win = selected) {
  return visibleLineCount(win);
}

export function scrollToEdge(edge, win = selected) {
  win.bodyEl.scrollTop = edge === 'top' ? 0 : win.bodyEl.scrollHeight;
  win.scrollTop = win.bodyEl.scrollTop;
  win.userScrolled = true;
  scheduleRedisplay();
}

export { currentBuffer };
