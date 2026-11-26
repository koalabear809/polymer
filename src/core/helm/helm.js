// Helm: the completion interface.
//
//   const choice = await helm({
//     prompt: 'Buffer: ',
//     sources: [
//       { name: 'Buffers', candidates: () => names, actions: { Switch: (v) => ..., Kill: (v) => ... } },
//       { name: 'Create', dummy: true, actions: { 'New buffer': (q) => ... } },
//     ],
//   })
//
// Source options:
//   name         header text
//   candidates   array | (ctx) => array | promise | async iterable (yielding items or arrays)
//                ctx = { query, signal }. Candidates are strings, [label, value] pairs or
//                objects { label, value, annotation }.
//   volatile     re-run `candidates` on every query change (debounced), e.g. grep
//   dummy        a single candidate equal to the current query (for "create new ...")
//   match        false to show candidates unfiltered (default for volatile sources)
//   display      (value, cand) => string | { label, annotation }
//   actions      fn | { name: fn } | [[name, fn]]; the first is the default (RET).
//                Called as fn(value, cand).
//   preview      (value, cand) => void, the persistent action (C-z / follow mode)
//   limit        maximum candidates shown
//   delay        ms to wait after typing before re-running a volatile source
//
// Candidate objects keep their original object as `cand.data`; a source with
// `match: false` may supply `positions` (highlighted columns) on its candidates.
//
// Session options: prompt, sources, initial, allowInput (RET with no candidate returns the
// query), history (history list name), follow, keymap (extra keymap consulted before
// helm-map, e.g. helm-find-files-map), onInput (called with the query on every change).
//
// The returned promise resolves with the action's result, or rejects with Quit.

import { pushContext, popContext, reportError } from '../command-loop.js';
import { defcommand, defvar, getVarOr } from '../registry.js';
import { defineKey } from '../keymap.js';
import { Quit, PolymerError } from '../errors.js';
import { compileQuery, filterCandidates, canNarrow } from './match.js';

defvar('helm-candidate-number-limit', 5000, { doc: 'Maximum candidates shown per source.' });
defvar('helm-input-idle-delay', 120, { doc: 'Milliseconds to wait after typing before re-running volatile sources.' });
defvar('helm-follow-delay', 60, { doc: 'Milliseconds to wait after moving before follow mode previews.' });
defvar('helm-history-max', 200, { doc: 'Maximum entries kept per helm history list.' });

let view = null;
let session = null;
const histories = new Map();

/** All helm history lists, as { name: [entries] } (for saving between sessions). */
export function helmHistories() { return Object.fromEntries(histories); }

/** Restore history lists saved by helmHistories(). Existing entries are kept first. */
export function restoreHelmHistories(obj) {
  for (const [name, list] of Object.entries(obj ?? {})) {
    if (!Array.isArray(list)) continue;
    const cur = histories.get(name) ?? [];
    histories.set(name, [...cur, ...list.filter((x) => typeof x === 'string' && !cur.includes(x))]);
  }
}

export const helmActive = () => session !== null;
export const helmSession = () => session;

// ---------------------------------------------------------------------------
// Normalization

function normalizeActions(actions) {
  if (!actions) return [];
  if (typeof actions === 'function') return [{ name: 'Default', fn: actions }];
  if (Array.isArray(actions)) return actions.map((a) => (Array.isArray(a) ? { name: a[0], fn: a[1] } : a));
  return Object.entries(actions).map(([name, fn]) => ({ name, fn }));
}

function normalizeCandidate(c, src) {
  let cand;
  if (typeof c === 'string') cand = { label: c, value: c };
  else if (Array.isArray(c)) cand = { label: String(c[0]), value: c[1] };
  else if (c && typeof c === 'object') {
    const value = 'value' in c ? c.value : c;
    cand = { label: String(c.label ?? c.name ?? value), value, annotation: c.annotation, positions: c.positions, data: c };
  } else cand = { label: String(c), value: c };
  if (src.display) {
    const d = src.display(cand.value, cand);
    if (typeof d === 'string') cand.label = d;
    else if (d) Object.assign(cand, d);
  }
  return cand;
}

function normalizeSource(raw) {
  return {
    raw,
    name: raw.name ?? 'Candidates',
    volatile: !!raw.volatile,
    dummy: !!raw.dummy,
    match: raw.match ?? !raw.volatile,
    display: raw.display ?? null,
    actions: normalizeActions(raw.actions),
    preview: raw.preview ?? null,
    limit: raw.limit ?? null,
    delay: raw.delay ?? null,
    all: [],
    results: [],
    loading: false,
    abort: null,
    prevQuery: null,
    prevMatches: null,
    reloadTimer: null,
  };
}

// ---------------------------------------------------------------------------
// Session

class Session {
  constructor(opts, resolve, reject) {
    this.opts = opts;
    this.prompt = opts.prompt ?? 'Pattern: ';
    this.allowInput = !!opts.allowInput;
    this.sources = (opts.sources ?? []).map(normalizeSource);
    this.query = opts.initial ?? '';
    this.state = 'insert';
    this.rows = [];        // { type: 'header', src } | { type: 'cand', src, cand, positions }
    this.candRows = [];    // indices into rows of candidate rows
    this.sel = 0;          // index into candRows
    this.marked = new Set();
    this.follow = !!opts.follow;
    this.actionMode = null;
    this.historyName = opts.history ?? null;
    this.historyPos = -1;
    this.resolve = resolve;
    this.reject = reject;
    this.done = false;
    this.updateScheduled = false;
    this.followTimer = null;
    this.prevFocus = document.activeElement;
    const self = this;
    this.ctx = {
      get state() { return self.state; },
      keymaps: [...(opts.keymap ? [opts.keymap] : []), 'helm-map', { map: 'global', states: ['*'] }],
      unbound(key, e) {
        // In normal state the input is read-only; swallow typing.
        if (self.state === 'normal' && !key.includes('s-')) e.preventDefault();
      },
    };
  }

  start() {
    pushContext(this.ctx);
    view.input.value = this.query;
    view.promptText.textContent = this.prompt;
    view.root.hidden = false;
    document.body.classList.add('helm-active');
    view.results.scrollTop = 0;
    this.setState('insert');
    for (const src of this.sources) if (!src.dummy) this.load(src);
    this.update();
  }

  // ----- candidates

  load(src) {
    src.abort?.abort();
    const ac = new AbortController();
    src.abort = ac;
    src.all = [];
    src.prevQuery = null;
    src.prevMatches = null;
    let res = src.raw.candidates;
    try {
      if (typeof res === 'function') res = res({ query: this.query, signal: ac.signal, session: this });
    } catch (e) {
      reportError(e);
      res = [];
    }
    if (Array.isArray(res) || res == null) {
      src.all = (res ?? []).map((c) => normalizeCandidate(c, src));
      src.loading = false;
      return;
    }
    src.loading = true;
    const finish = () => {
      if (src.abort === ac) src.loading = false;
      this.scheduleUpdate();
    };
    if (typeof res[Symbol.asyncIterator] === 'function') {
      (async () => {
        try {
          for await (const chunk of res) {
            if (ac.signal.aborted || this.done) return;
            const items = Array.isArray(chunk) ? chunk : [chunk];
            for (const c of items) src.all.push(normalizeCandidate(c, src));
            src.prevQuery = null;
            this.scheduleUpdate();
          }
        } catch (e) {
          if (!ac.signal.aborted) reportError(e);
        } finally {
          finish();
        }
      })();
    } else {
      Promise.resolve(res).then(
        (items) => {
          if (ac.signal.aborted || this.done) return;
          src.all = (items ?? []).map((c) => normalizeCandidate(c, src));
        },
        (e) => { if (!ac.signal.aborted) reportError(e); },
      ).finally(finish);
    }
  }

  filterSource(src, compiled) {
    const limit = src.limit ?? getVarOr('helm-candidate-number-limit', 5000);
    if (src.dummy) {
      src.results = this.query ? [{ cand: { label: this.query, value: this.query }, positions: [] }] : [];
      return;
    }
    if (src.match === false) {
      src.results = src.all.slice(0, limit).map((cand) => ({ cand, positions: cand.positions ?? [] }));
      return;
    }
    let base = src.all;
    if (!src.loading && src.prevMatches && canNarrow(src.prevQuery, this.query)) {
      base = src.prevMatches.map((m) => m.cand);
    }
    const matches = filterCandidates(compiled, base);
    if (!src.loading) {
      src.prevQuery = this.query;
      src.prevMatches = matches;
    }
    src.results = matches.slice(0, limit);
  }

  scheduleUpdate() {
    if (this.updateScheduled || this.done) return;
    this.updateScheduled = true;
    requestAnimationFrame(() => {
      this.updateScheduled = false;
      if (!this.done) this.update({ keepSelection: true });
    });
  }

  update({ keepSelection = false } = {}) {
    if (this.done) return;
    const prevCand = keepSelection ? this.selected()?.cand : null;
    this.rows = [];
    this.candRows = [];
    if (this.actionMode) {
      const am = this.actionMode;
      const compiled = compileQuery(this.query);
      const matches = filterCandidates(compiled, am.actions.map((a) => ({ label: a.name, value: a })));
      this.rows.push({ type: 'header', title: `Actions (${am.cands.length > 1 ? `${am.cands.length} marked` : am.cands[0].label})` });
      for (const m of matches) {
        this.candRows.push(this.rows.length);
        this.rows.push({ type: 'cand', src: null, cand: m.cand, positions: m.positions });
      }
    } else {
      const compiled = compileQuery(this.query);
      for (const src of this.sources) {
        this.filterSource(src, compiled);
        if (!src.results.length && !src.loading) continue;
        this.rows.push({ type: 'header', src });
        for (const r of src.results) {
          this.candRows.push(this.rows.length);
          this.rows.push({ type: 'cand', src, cand: r.cand, positions: r.positions });
        }
      }
    }
    if (prevCand) {
      const i = this.candRows.findIndex((ri) => this.rows[ri].cand === prevCand);
      this.sel = i >= 0 ? i : Math.min(this.sel, Math.max(0, this.candRows.length - 1));
    } else {
      this.sel = Math.min(this.sel, Math.max(0, this.candRows.length - 1));
    }
    this.render(true);
  }

  onInput() {
    this.query = view.input.value;
    this.sel = 0;
    view.results.scrollTop = 0;
    if (!this.actionMode) {
      for (const src of this.sources) {
        if (!src.volatile) continue;
        const delay = src.delay ?? getVarOr('helm-input-idle-delay', 120);
        clearTimeout(src.reloadTimer);
        src.reloadTimer = setTimeout(() => { if (!this.done) { this.load(src); this.scheduleUpdate(); } }, delay);
      }
    }
    this.update();
    this.maybeFollow();
    if (this.opts.onInput) {
      try { this.opts.onInput(this.query, this); } catch (e) { reportError(e); }
    }
  }

  /** Replace the input text (cursor at the end) as if typed. */
  setInput(text) {
    view.input.value = text;
    view.input.setSelectionRange(text.length, text.length);
    this.onInput();
  }

  get input() { return view.input.value; }

  // ----- selection

  selected() {
    const ri = this.candRows[this.sel];
    return ri === undefined ? null : this.rows[ri];
  }

  move(n) {
    if (!this.candRows.length) return;
    this.sel = Math.max(0, Math.min(this.candRows.length - 1, this.sel + n));
    this.render(false, true);
    this.maybeFollow();
  }

  moveTo(i) {
    if (!this.candRows.length) return;
    this.sel = i < 0 ? this.candRows.length - 1 : Math.min(i, this.candRows.length - 1);
    this.render(false, true);
    this.maybeFollow();
  }

  /** Jump to the first candidate of the next (dir=1) or previous (dir=-1) source. */
  moveSource(dir) {
    const cur = this.selected();
    if (!cur) return;
    const firsts = [];
    let lastSrc = null;
    this.candRows.forEach((ri, i) => {
      if (this.rows[ri].src !== lastSrc) { firsts.push(i); lastSrc = this.rows[ri].src; }
    });
    const curFirst = firsts.filter((i) => i <= this.sel).at(-1) ?? 0;
    const idx = firsts.indexOf(curFirst);
    const target = firsts[(idx + dir + firsts.length) % firsts.length];
    this.moveTo(target);
  }

  pageSize() {
    return Math.max(1, Math.floor(view.results.clientHeight / rowHeight()) - 1);
  }

  toggleMark() {
    const s = this.selected();
    if (!s || this.actionMode) return;
    if (this.marked.has(s.cand)) this.marked.delete(s.cand);
    else this.marked.add(s.cand);
    this.move(1);
    this.render();
  }

  markAll() {
    if (this.actionMode) return;
    const allMarked = this.candRows.every((ri) => this.marked.has(this.rows[ri].cand));
    for (const ri of this.candRows) {
      const c = this.rows[ri].cand;
      if (allMarked) this.marked.delete(c);
      else this.marked.add(c);
    }
    this.render();
  }

  /** Candidates an action applies to: marked ones in the selected source, else the selection. */
  targets() {
    const s = this.selected();
    if (!s) return [];
    const marked = this.candRows.map((ri) => this.rows[ri]).filter((r) => this.marked.has(r.cand) && r.src === s.src);
    return marked.length ? marked : [s];
  }

  // ----- actions

  async runPreview() {
    const s = this.selected();
    if (!s || !s.src?.preview) return;
    try { await s.src.preview(s.cand.value, s.cand); } catch (e) { reportError(e); }
  }

  maybeFollow() {
    if (!this.follow || this.actionMode) return;
    clearTimeout(this.followTimer);
    this.followTimer = setTimeout(() => this.runPreview(), getVarOr('helm-follow-delay', 60));
  }

  enterActionMode() {
    if (this.actionMode) { this.leaveActionMode(); return; }
    const targets = this.targets();
    if (!targets.length) return;
    const src = targets[0].src;
    if (!src.actions.length) return;
    this.actionMode = {
      src,
      cands: targets.map((t) => t.cand),
      actions: src.actions,
      savedQuery: this.query,
      savedSel: this.sel,
    };
    this.query = '';
    view.input.value = '';
    this.sel = 0;
    this.update();
  }

  leaveActionMode() {
    const am = this.actionMode;
    if (!am) return;
    this.actionMode = null;
    this.query = am.savedQuery;
    view.input.value = am.savedQuery;
    this.sel = am.savedSel;
    this.update();
  }

  exit() {
    if (this.actionMode) {
      const s = this.selected();
      if (!s) return;
      return this.finishWith(s.cand.value, this.actionMode.cands);
    }
    const s = this.selected();
    if (!s) {
      if (this.allowInput) {
        this.pushHistory(this.query);
        this.finish();
        this.resolve(this.query);
      } else {
        flashStatus('No candidate');
      }
      return;
    }
    const targets = this.targets();
    const action = s.src.actions[0];
    if (!action) {
      // No actions: return the selected value(s).
      this.pushHistory(s.cand.label);
      this.finish();
      this.resolve(targets.length > 1 ? targets.map((t) => t.cand.value) : s.cand.value);
      return;
    }
    return this.finishWith(action, targets.map((t) => t.cand));
  }

  async finishWith(action, cands) {
    this.pushHistory(cands[0]?.label ?? this.query);
    this.finish();
    try {
      const results = [];
      for (const c of cands) results.push(await action.fn(c.value, c));
      this.resolve(results.length > 1 ? results : results[0]);
    } catch (e) {
      this.reject(e);
    }
  }

  cancel() {
    this.finish();
    this.reject(new Quit());
  }

  finish() {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.followTimer);
    for (const src of this.sources) {
      src.abort?.abort();
      clearTimeout(src.reloadTimer);
    }
    popContext(this.ctx);
    view.root.hidden = true;
    document.body.classList.remove('helm-active');
    view.rows.replaceChildren();
    session = null;
    if (this.prevFocus && document.contains(this.prevFocus)) this.prevFocus.focus();
    else view.input.blur();
  }

  // ----- history

  pushHistory(entry) {
    if (!this.historyName || !entry) return;
    const list = (histories.get(this.historyName) ?? []).filter((h) => h !== entry);
    list.unshift(entry);
    histories.set(this.historyName, list.slice(0, getVarOr('helm-history-max', 200)));
  }

  historyStep(dir) {
    const list = this.historyName ? histories.get(this.historyName) ?? [] : [];
    if (!list.length) return;
    this.historyPos = Math.max(-1, Math.min(list.length - 1, this.historyPos + dir));
    view.input.value = this.historyPos < 0 ? '' : list[this.historyPos];
    this.onInput();
  }

  // ----- state

  setState(state) {
    this.state = state;
    view.input.readOnly = state === 'normal';
    view.root.dataset.state = state;
    if (state === 'insert') view.input.focus();
    this.renderStatus();
  }

  // ----- rendering

  render(full = false, scrollToSelection = true) {
    if (this.done) return;
    if (scrollToSelection) this.ensureVisible();
    renderRows(this);
    this.renderStatus();
  }

  ensureVisible() {
    const ri = this.candRows[this.sel];
    if (ri === undefined) return;
    const h = rowHeight();
    const r = view.results;
    // Keep the source header visible when selecting a source's first candidate.
    const top = (this.rows[ri - 1]?.type === 'header' ? ri - 1 : ri) * h;
    const bottom = (ri + 1) * h;
    if (top < r.scrollTop) r.scrollTop = top;
    else if (bottom > r.scrollTop + r.clientHeight) r.scrollTop = bottom - r.clientHeight;
  }

  renderStatus() {
    const total = this.candRows.length;
    const loading = this.sources.some((s) => s.loading);
    const parts = [];
    parts.push(this.actionMode ? 'Action' : (this.prompt.replace(/[:\s]+$/, '') || 'helm'));
    parts.push(total ? `${this.sel + 1}/${total}` : '0');
    if (this.marked.size) parts.push(`${this.marked.size} marked`);
    if (this.follow) parts.push('follow');
    if (loading) parts.push('loading…');
    view.statusText.textContent = parts.join('  ');
    view.stateTag.textContent = this.state === 'insert' ? ' I ' : ' N ';
    view.stateTag.className = `state-tag state-${this.state}`;
  }
}

// ---------------------------------------------------------------------------
// View

let cachedRowHeight = 0;
function rowHeight() {
  if (!cachedRowHeight) {
    const probe = document.createElement('div');
    probe.className = 'helm-row helm-cand';
    probe.textContent = 'M';
    view.rows.appendChild(probe);
    cachedRowHeight = probe.getBoundingClientRect().height || 20;
    probe.remove();
  }
  return cachedRowHeight;
}

function highlighted(label, positions) {
  const frag = document.createDocumentFragment();
  if (!positions.length) {
    frag.append(label);
    return frag;
  }
  const set = new Set(positions);
  let i = 0;
  while (i < label.length) {
    const m = set.has(i);
    let j = i;
    while (j < label.length && set.has(j) === m) j++;
    const text = label.slice(i, j);
    if (m) {
      const span = document.createElement('span');
      span.className = 'helm-match';
      span.textContent = text;
      frag.appendChild(span);
    } else {
      frag.append(text);
    }
    i = j;
  }
  return frag;
}

function renderRows(s) {
  const h = rowHeight();
  const r = view.results;
  view.spacer.style.height = `${s.rows.length * h}px`;
  const start = Math.max(0, Math.floor(r.scrollTop / h) - 4);
  const end = Math.min(s.rows.length, Math.ceil((r.scrollTop + r.clientHeight) / h) + 4);
  view.rows.style.transform = `translateY(${start * h}px)`;
  const selRow = s.candRows[s.sel];
  const out = [];
  for (let i = start; i < end; i++) {
    const row = s.rows[i];
    const el = document.createElement('div');
    if (row.type === 'header') {
      el.className = 'helm-row helm-header';
      el.textContent = row.title ?? (row.src.loading ? `${row.src.name} (loading…)` : row.src.name);
    } else {
      el.className = 'helm-row helm-cand';
      if (i === selRow) el.classList.add('selected');
      const marked = s.marked.has(row.cand);
      if (marked) el.classList.add('marked');
      const gutter = document.createElement('span');
      gutter.className = 'helm-gutter';
      gutter.textContent = marked ? '●' : ' ';
      const label = document.createElement('span');
      label.className = 'helm-label';
      label.appendChild(highlighted(row.cand.label, row.positions));
      el.append(gutter, label);
      if (row.cand.annotation) {
        const ann = document.createElement('span');
        ann.className = 'helm-annotation';
        ann.textContent = row.cand.annotation;
        el.appendChild(ann);
      }
      const idx = s.candRows.indexOf(i);
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        s.sel = idx;
        s.render(false, false);
      });
      el.addEventListener('dblclick', (e) => { e.preventDefault(); s.exit(); });
    }
    out.push(el);
  }
  view.rows.replaceChildren(...out);
}

let flashTimer = null;
function flashStatus(text) {
  view.flash.textContent = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { view.flash.textContent = ''; }, 1200);
}

export function attachHelm(root) {
  root.innerHTML = '';
  const results = document.createElement('div');
  results.className = 'helm-results';
  const spacer = document.createElement('div');
  spacer.className = 'helm-spacer';
  const rows = document.createElement('div');
  rows.className = 'helm-rows';
  results.append(spacer, rows);

  const status = document.createElement('div');
  status.className = 'helm-status mode-line active';
  const stateTag = document.createElement('span');
  const statusText = document.createElement('span');
  statusText.className = 'ml-left';
  const flash = document.createElement('span');
  flash.className = 'ml-right helm-flash';
  status.append(stateTag, statusText, flash);

  const prompt = document.createElement('div');
  prompt.className = 'helm-prompt';
  const promptText = document.createElement('span');
  promptText.className = 'helm-prompt-text';
  const input = document.createElement('input');
  input.className = 'helm-input';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('autocorrect', 'off');
  prompt.append(promptText, input);

  root.append(results, status, prompt);
  root.hidden = true;
  view = { root, results, spacer, rows, status, stateTag, statusText, flash, prompt, promptText, input };

  input.addEventListener('input', () => session?.onInput());
  input.addEventListener('blur', () => {
    // Keep keyboard focus in the prompt while a session is active.
    setTimeout(() => { if (session && session.state === 'insert' && document.activeElement !== input) input.focus(); }, 0);
  });
  results.addEventListener('scroll', () => { if (session) renderRows(session); });
  window.addEventListener('resize', () => { cachedRowHeight = 0; if (session) session.render(); });
}

// ---------------------------------------------------------------------------
// Public API

export function helm(opts = {}) {
  if (!view) return Promise.reject(new PolymerError('error', 'helm is not attached to the DOM'));
  if (session) return Promise.reject(new PolymerError('error', 'Command attempted to use minibuffer while in minibuffer'));
  return new Promise((resolve, reject) => {
    session = new Session(opts, resolve, reject);
    session.start();
  });
}

/**
 * Choose one item from `collection` (array, function, promise or async iterable).
 * Resolves with the chosen value; with `requireMatch: false`, typed text is accepted too.
 */
export function completingRead(prompt, collection, opts = {}) {
  const sources = [{
    name: opts.sourceName ?? prompt.replace(/[:\s]+$/, ''),
    candidates: collection,
    display: opts.display,
    preview: opts.preview,
  }];
  return helm({
    prompt,
    sources,
    initial: opts.initial,
    allowInput: opts.requireMatch === false,
    history: opts.history,
    follow: opts.follow,
  });
}

/** Read a line of text. */
export function readString(prompt, opts = {}) {
  return helm({ prompt, sources: [], initial: opts.initial, allowInput: true, history: opts.history, onInput: opts.onInput });
}

/** Ask a yes/no question. */
export async function yesOrNo(prompt) {
  const answer = await completingRead(`${prompt} `, ['yes', 'no']);
  return answer === 'yes';
}

// ---------------------------------------------------------------------------
// Commands and keys (all redefinable)

function withSession(fn) {
  return (...args) => {
    if (!session) throw new PolymerError('error', 'No active helm session');
    return fn(session, ...args);
  };
}

defcommand('helm-next-line', { doc: 'Select the next candidate.' }, withSession((s) => s.move(1)));
defcommand('helm-previous-line', { doc: 'Select the previous candidate.' }, withSession((s) => s.move(-1)));
defcommand('helm-next-page', { doc: 'Move down one page.' }, withSession((s) => s.move(s.pageSize())));
defcommand('helm-previous-page', { doc: 'Move up one page.' }, withSession((s) => s.move(-s.pageSize())));
defcommand('helm-next-half-page', { doc: 'Move down half a page.' }, withSession((s) => s.move(Math.ceil(s.pageSize() / 2))));
defcommand('helm-previous-half-page', { doc: 'Move up half a page.' }, withSession((s) => s.move(-Math.ceil(s.pageSize() / 2))));
defcommand('helm-beginning-of-buffer', { doc: 'Select the first candidate.' }, withSession((s) => s.moveTo(0)));
defcommand('helm-end-of-buffer', { doc: 'Select the last candidate.' }, withSession((s) => s.moveTo(-1)));
defcommand('helm-next-source', { doc: 'Jump to the next source.' }, withSession((s) => s.moveSource(1)));
defcommand('helm-previous-source', { doc: 'Jump to the previous source.' }, withSession((s) => s.moveSource(-1)));
defcommand('helm-maybe-exit', { doc: 'Run the default action on the selection (or marked candidates).' }, withSession((s) => s.exit()));
defcommand('helm-select-action', { doc: 'Show the actions for the selection; again to go back.' }, withSession((s) => s.enterActionMode()));
defcommand('helm-execute-persistent-action', { doc: 'Preview the selection without leaving helm.' }, withSession((s) => s.runPreview()));
defcommand('helm-toggle-visible-mark', { doc: 'Mark or unmark the selection.' }, withSession((s) => s.toggleMark()));
defcommand('helm-toggle-all-marks', { doc: 'Mark or unmark all visible candidates.' }, withSession((s) => s.markAll()));
defcommand('helm-follow-mode', { doc: 'Toggle previewing the selection as it moves.' }, withSession((s) => {
  s.follow = !s.follow;
  s.renderStatus();
  if (s.follow) s.runPreview();
}));
defcommand('helm-keyboard-quit', { doc: 'Quit helm (or leave the action menu).' }, withSession((s) => {
  if (s.actionMode) s.leaveActionMode();
  else s.cancel();
}));
defcommand('helm-normal-state', { doc: 'Switch helm to normal state.' }, withSession((s) => s.setState('normal')));
defcommand('helm-insert-state', { doc: 'Switch helm to insert state.' }, withSession((s) => s.setState('insert')));
defcommand('helm-append', { doc: 'Insert state with the cursor at the end of the input.' }, withSession((s) => {
  s.setState('insert');
  const n = view.input.value.length;
  view.input.setSelectionRange(n, n);
}));
defcommand('helm-insert-beginning', { doc: 'Insert state with the cursor at the start of the input.' }, withSession((s) => {
  s.setState('insert');
  view.input.setSelectionRange(0, 0);
}));
defcommand('helm-previous-history', { doc: 'Previous history entry.' }, withSession((s) => s.historyStep(1)));
defcommand('helm-next-history', { doc: 'Next history entry.' }, withSession((s) => s.historyStep(-1)));
defcommand('helm-delete-word-backward', { doc: 'Delete the word before the cursor.' }, withSession(() => {
  const inp = view.input;
  const pos = inp.selectionStart;
  const before = inp.value.slice(0, pos).replace(/\S+\s*$|\s+$/, '');
  inp.value = before + inp.value.slice(pos);
  inp.setSelectionRange(before.length, before.length);
  session.onInput();
}));
defcommand('helm-kill-to-beginning', { doc: 'Delete from the cursor to the start of the input.' }, withSession(() => {
  const inp = view.input;
  inp.value = inp.value.slice(inp.selectionStart);
  inp.setSelectionRange(0, 0);
  session.onInput();
}));
defcommand('helm-clear-input', { doc: 'Clear the input.' }, withSession(() => {
  view.input.value = '';
  session.onInput();
}));

defineKey({ keymaps: 'helm-map' }, {
  'C-j': 'helm-next-line',
  'C-k': 'helm-previous-line',
  'C-n': 'helm-next-line',
  'C-p': 'helm-previous-line',
  '<down>': 'helm-next-line',
  '<up>': 'helm-previous-line',
  '<next>': 'helm-next-page',
  '<prior>': 'helm-previous-page',
  'C-o': 'helm-next-source',
  'RET': 'helm-maybe-exit',
  'TAB': 'helm-select-action',
  'C-z': 'helm-execute-persistent-action',
  'C-SPC': 'helm-toggle-visible-mark',
  'M-m': 'helm-toggle-visible-mark',
  'M-a': 'helm-toggle-all-marks',
  'C-c': { label: 'helm' },
  'C-c C-f': 'helm-follow-mode',
  'M-p': 'helm-previous-history',
  'M-n': 'helm-next-history',
  'C-g': 'helm-keyboard-quit',
});

defineKey({ keymaps: 'helm-map', states: 'insert' }, {
  'ESC': 'helm-normal-state',
  'C-w': 'helm-delete-word-backward',
  'C-u': 'helm-kill-to-beginning',
});

defineKey({ keymaps: 'helm-map', states: 'normal' }, {
  'ESC': 'helm-keyboard-quit',
  'q': 'helm-keyboard-quit',
  'j': 'helm-next-line',
  'k': 'helm-previous-line',
  'J': 'helm-next-source',
  'K': 'helm-previous-source',
  'g': { label: 'goto' },
  'g g': 'helm-beginning-of-buffer',
  'G': 'helm-end-of-buffer',
  'C-d': 'helm-next-half-page',
  'C-u': 'helm-previous-half-page',
  'C-f': 'helm-next-page',
  'C-b': 'helm-previous-page',
  'i': 'helm-insert-state',
  'a': 'helm-append',
  'A': 'helm-append',
  'I': 'helm-insert-beginning',
  '/': 'helm-insert-state',
  'm': 'helm-toggle-visible-mark',
  'S': 'helm-clear-input',
  'p': 'helm-execute-persistent-action',
});
