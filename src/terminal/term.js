// Terminal buffers.
//
// Live (insert state): the buffer shows the terminal screen, keys go to the program, and
// the mouse wheel scrolls the terminal's history. Copy mode (normal state, C-\ C-n): the
// buffer holds the whole scrollback as text, so vim motions, search and yank work; i or a
// returns to the live terminal.
//
// Sessions run in Rust and survive webview reloads; startup re-attaches to them.

import { defcommand, defvar, getVarOr, setLocal, addHook, runHooks } from '../core/registry.js';
import { defineKey } from '../core/keymap.js';
import { defineMajorMode, setMajorMode, bufferKeymaps } from '../core/modes.js';
import { getBufferCreate, generateNewBufferName, currentBuffer, bufferList } from '../core/buffer.js';
import { selectedWindow, setWindowBuffer, displayBuffer, windowList } from '../core/window.js';
import { viewMetrics, visibleLineCount } from '../core/view.js';
import { invoke, createChannel, isTauri } from '../core/host.js';
import { message } from '../core/echo.js';
import { PolymerError } from '../core/errors.js';
import { encodeKey, encodePaste, xtermColor } from './encode.js';

defvar('term-shell', null, { doc: 'Program for new terminals (default: $SHELL as a login shell, or COMSPEC on Windows).' });
defvar('term-shell-args', null, { doc: 'Arguments for term-shell (default: none for a custom shell).' });
defvar('term-buffer-name', '*terminal*', { doc: 'Base name for terminal buffers.' });

defineMajorMode('term-mode', {
  parent: 'special-mode',
  doc: 'Terminal emulator. Insert state sends keys to the program; C-\\ C-n enters copy mode (normal state) over the scrollback; i returns.',
  lighter: 'Term',
});

const sessions = new Map(); // id -> buffer

// ---------------------------------------------------------------------------
// Rendering frames into the buffer

const FLAG_CLASSES = [[1, 'term-bold'], [2, 'term-italic'], [4, 'term-underline'], [8, 'term-dim'], [16, 'term-strike']];

function colorStyle(token, prop) {
  if (!token) return { cls: '', css: '' };
  if (token === 'fg' || token === 'bg') return { cls: `t${prop}-${token}`, css: '' };
  if (token.startsWith('#')) return { cls: '', css: `${prop === 'fg' ? 'color' : 'background'}:${token}` };
  const i = Number(token);
  if (i < 16) return { cls: `t${prop}-${i}`, css: '' };
  return { cls: '', css: `${prop === 'fg' ? 'color' : 'background'}:${xtermColor(i)}` };
}

/** Convert Rust's style runs into decorations. */
function runsToDecos(runs) {
  return runs.map((r) => {
    const fg = colorStyle(r.fg, 'fg');
    const bg = colorStyle(r.bg, 'bg');
    const classes = [fg.cls, bg.cls, ...FLAG_CLASSES.filter(([bit]) => r.f & bit).map(([, c]) => c)].filter(Boolean).join(' ');
    return { from: r.s, to: r.e, face: classes, style: [fg.css, bg.css].filter(Boolean).join(';'), priority: 2 };
  });
}

function renderLive(b) {
  const t = b.term;
  const lines = t.lines.slice(0, t.rows);
  while (lines.length < t.rows) lines.push('');
  // Pad the cursor's line so the cursor can sit past the last character.
  if (t.cursorRow !== null && t.cursorRow < lines.length && lines[t.cursorRow].length < t.cursorCol) {
    lines[t.cursorRow] = lines[t.cursorRow].padEnd(t.cursorCol, ' ');
  }
  b.setText(lines.join('\n'));
  if (t.cursorRow !== null) b.point.set(b.offsetAt(t.cursorRow, t.cursorCol));
  else b.point.set(b.length);
  b.cursorHidden = !t.cursorVisible || t.cursorRow === null || t.exited;
}

function onFrame(b, f) {
  const t = b.term;
  t.rows = f.rows;
  t.cols = f.cols;
  if (t.lines.length !== f.rows) {
    t.lines.length = f.rows;
    t.decos.length = f.rows;
    for (let i = 0; i < f.rows; i++) { t.lines[i] ??= ''; t.decos[i] ??= []; }
  }
  for (const row of f.lines) {
    t.lines[row.i] = row.text;
    t.decos[row.i] = runsToDecos(row.runs);
  }
  t.cursorRow = f.cursorRow;
  t.cursorCol = f.cursorCol;
  t.cursorVisible = f.cursorVisible;
  t.appCursor = f.appCursor;
  t.bracketedPaste = f.bracketedPaste;
  t.altScreen = f.altScreen;
  t.displayOffset = f.displayOffset;
  if (f.title !== null && f.title !== undefined) t.title = f.title;
  if (!t.copyMode) renderLive(b);
  if (f.bell) runHooks('term-bell-hook', b);
}

function onExit(b, code) {
  const t = b.term;
  t.exited = true;
  t.exitCode = code;
  if (!t.copyMode) renderLive(b);
  const note = `[Process exited${code !== null && code !== undefined ? ` with code ${code}` : ''}]`;
  b.append(`${b.length ? '\n' : ''}${note}`);
  b.cursorHidden = true;
  message('%s: %s', b.name, note);
  runHooks('term-exit-hook', b, code);
}

function handleEvent(b, ev) {
  if (!b.live) return;
  if (ev.type === 'frame') onFrame(b, ev);
  else if (ev.type === 'exit') onExit(b, ev.code);
}

// ---------------------------------------------------------------------------
// Input

async function write(b, data) {
  const t = b.term;
  if (!t || t.exited || !data) return;
  if (t.displayOffset) {
    // Typing returns to the bottom, like most terminals.
    t.displayOffset = 0;
    invoke('term_scroll', { id: t.id, delta: 0 }).catch(() => {});
  }
  await invoke('term_write', { id: t.id, data });
}

function setupBuffer(b, id) {
  setMajorMode(b, 'term-mode');
  setLocal('display-line-numbers', false, b);
  setLocal('global-hl-line-mode', false, b);
  setLocal('scroll-margin', 0, b);
  b.undoEnabled = false;
  b.term = { id, rows: 0, cols: 0, lines: [], decos: [], cursorRow: 0, cursorCol: 0, cursorVisible: true, appCursor: false, bracketedPaste: false, altScreen: false, displayOffset: 0, title: '', exited: false, copyMode: null, wheel: 0 };
  b.cursorShape = 'block';
  b.state = 'insert';
  b.decorators.push((buf, line) => (buf.term?.copyMode ? buf.term.copyMode.decos[line] : buf.term?.decos[line]) ?? []);
  // In insert state only term-raw-map is active; every other key goes to the program.
  b.keymapsFor = (state) => (state === 'insert' ? ['term-raw-map'] : bufferKeymaps(b));
  b.onUnboundKey = (key) => {
    if (b.state !== 'insert') return false;
    const data = encodeKey(key, { appCursor: b.term.appCursor });
    if (data === null) return false;
    write(b, data).catch(() => {});
    return true;
  };
  b.onTextInput = (text, { paste } = {}) => {
    if (b.state !== 'insert') return;
    return write(b, paste ? encodePaste(text, b.term.bracketedPaste) : text);
  };
  b.onWheel = (e) => {
    if (b.state !== 'insert' || b.term.exited) return false;
    const { lh } = viewMetrics();
    b.term.wheel += e.deltaY / lh;
    const lines = Math.trunc(b.term.wheel);
    if (!lines) return true;
    b.term.wheel -= lines;
    if (b.term.altScreen) {
      // Full-screen programs (less, vim) get arrow keys instead.
      const key = encodeKey(lines < 0 ? '<up>' : '<down>', { appCursor: b.term.appCursor });
      write(b, key.repeat(Math.min(Math.abs(lines), 10))).catch(() => {});
    } else {
      invoke('term_scroll', { id: b.term.id, delta: -lines }).catch(() => {});
    }
    return true;
  };
  sessions.set(id, b);
}

// ---------------------------------------------------------------------------
// Size

function windowGrid(win) {
  const { cw } = viewMetrics();
  const rows = Math.max(2, visibleLineCount(win));
  const cols = Math.max(10, Math.floor((win.bodyEl.clientWidth - 8) / cw) - 1);
  return { rows, cols };
}

const resizeTimers = new Map();
addHook('post-redisplay-hook', function termSyncSizes() {
  for (const [id, b] of sessions) {
    if (!b.live || b.term.exited) continue;
    const win = windowList().find((w) => w.buffer === b && w.bodyEl);
    if (!win) continue;
    const { rows, cols } = windowGrid(win);
    if (rows === b.term.rows && cols === b.term.cols) continue;
    if (b.term.pendingSize?.rows === rows && b.term.pendingSize?.cols === cols) continue;
    b.term.pendingSize = { rows, cols };
    clearTimeout(resizeTimers.get(id));
    resizeTimers.set(id, setTimeout(() => {
      invoke('term_resize', { id, rows, cols }).catch(() => {}).finally(() => { if (b.term) b.term.pendingSize = null; });
    }, 40));
  }
});

// ---------------------------------------------------------------------------
// Copy mode

async function enterCopyMode(b) {
  const t = b.term;
  const snap = await invoke('term_snapshot', { id: t.id });
  if (b.state === 'insert') return; // went back already
  t.copyMode = { decos: snap.lines.map((l) => runsToDecos(l.runs)) };
  b.cursorHidden = false;
  b.setText(snap.lines.map((l) => l.text).join('\n') + (t.exited ? `\n[Process exited${t.exitCode != null ? ` with code ${t.exitCode}` : ''}]` : ''));
  const line = Math.min(snap.cursorLine, b.lineCount - 1);
  b.point.set(b.offsetAt(line, snap.cursorCol));
  message('Copy mode: vim keys over the scrollback; i returns to the terminal');
}

function leaveCopyMode(b) {
  const t = b.term;
  t.copyMode = null;
  if (t.displayOffset) invoke('term_scroll', { id: t.id, delta: 0 }).catch(() => {});
  if (t.exited) {
    b.state = 'normal';
    return;
  }
  renderLive(b);
}

addHook('vim-state-change-hook', function termCopyMode(b, from, to) {
  if (!b.term) return;
  if (from === 'insert' && to === 'normal') enterCopyMode(b).catch((e) => message('%s', e.message ?? e));
  else if (to === 'insert' && from !== 'insert') leaveCopyMode(b);
});

addHook('kill-buffer-hook', function termKillSession(b) {
  if (!b.term) return;
  sessions.delete(b.term.id);
  invoke('term_kill', { id: b.term.id }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Commands

/** Start a terminal. Options: { command, args, cwd, name, otherWindow }. Returns the buffer. */
export async function openTerminal(opts = {}) {
  if (!isTauri) throw new PolymerError('user-error', 'Terminals need the app (not a plain browser)');
  const win = selectedWindow();
  const { rows, cols } = win?.bodyEl ? windowGrid(win) : { rows: 24, cols: 80 };
  const command = opts.command ?? getVarOr('term-shell', null) ?? undefined;
  const args = opts.args ?? (command ? getVarOr('term-shell-args', null) ?? [] : undefined);
  const cwd = opts.cwd ?? getVarOr('default-directory', null) ?? undefined;
  const b = getBufferCreate(generateNewBufferName(opts.name ?? getVarOr('term-buffer-name', '*terminal*')));
  let id;
  const channel = createChannel((ev) => handleEvent(b, ev));
  try {
    id = await invoke('term_spawn', { options: { command, args, cwd: cwd?.replace(/\/$/, '') || undefined, rows, cols }, channel });
  } catch (e) {
    const { killBuffer } = await import('../commands/builtins.js');
    killBuffer(b);
    throw new PolymerError('term-error', `Could not start terminal: ${e}`);
  }
  setupBuffer(b, id);
  b.term.rows = rows;
  b.term.cols = cols;
  if (cwd) setLocal('default-directory', cwd, b);
  if (opts.otherWindow) displayBuffer(b, { otherWindow: true });
  else setWindowBuffer(selectedWindow(), b);
  runHooks('term-mode-hook', b);
  return b;
}

/** Re-attach to sessions still running in the backend (after a webview reload). */
export async function reattachTerminals() {
  if (!isTauri) return 0;
  const list = await invoke('term_list');
  for (const info of list) {
    if (sessions.has(info.id)) continue;
    const b = getBufferCreate(generateNewBufferName(getVarOr('term-buffer-name', '*terminal*')));
    setupBuffer(b, info.id);
    if (info.cwd) setLocal('default-directory', info.cwd, b);
    await invoke('term_attach', { id: info.id, channel: createChannel((ev) => handleEvent(b, ev)) });
  }
  return list.length;
}

defcommand('term', { doc: 'Open a terminal in the selected window (in this buffer\'s directory).' }, () => openTerminal());
defcommand('term-other-window', { doc: 'Open a terminal in another window.' }, () => openTerminal({ otherWindow: true }));

defcommand('term-send-raw', {
  doc: 'Send text to the current terminal as typed.',
}, (text) => {
  const b = currentBuffer();
  if (!b.term) throw new PolymerError('user-error', 'Not a terminal buffer');
  return write(b, text);
});

defcommand('term-paste', { doc: 'In copy mode: paste a register into the terminal and return to it.' }, async () => {
  const b = currentBuffer();
  if (!b.term) return;
  const { getRegister } = await import('../vim/registers.js');
  const { prefix } = await import('../vim/core.js');
  const r = await getRegister(prefix.register ?? '"');
  const { callInteractively } = await import('../core/command-loop.js');
  await callInteractively('vim-insert');
  if (r?.text) await write(b, encodePaste(r.text, b.term.bracketedPaste));
});

defcommand('term-interrupt', { doc: 'Send C-c to the terminal (works from copy mode too).' }, () => {
  const b = currentBuffer();
  if (b.term) return write(b, '\x03');
});

defcommand('term-list', { doc: 'Switch to a terminal buffer.' }, async () => {
  const terms = bufferList().filter((b) => b.term);
  if (!terms.length) return openTerminal();
  const { helm } = await import('../core/helm/helm.js');
  return helm({
    prompt: 'Terminal: ',
    sources: [
      { name: 'Terminals', candidates: terms.map((b) => ({ label: b.name, value: b, annotation: [b.term.title, b.term.exited ? 'exited' : ''].filter(Boolean).join('  ') })), actions: { Switch: (b) => setWindowBuffer(selectedWindow(), b) } },
      { name: 'New', candidates: [{ label: 'New terminal', value: null }], actions: { Open: () => openTerminal() } },
    ],
  });
});

// ---------------------------------------------------------------------------
// Keys

// Insert state: everything goes to the program except these.
defineKey({ keymaps: 'term-raw-map', states: 'insert' }, {
  'C-\\': { label: 'term' },
  'C-\\ C-n': 'vim-normal-state',
});

// Copy mode (normal state).
defineKey({ keymaps: 'term-mode-map', states: 'normal' }, {
  'i': 'vim-insert',
  'a': 'vim-insert',
  'I': 'vim-insert',
  'A': 'vim-insert',
  'o': 'vim-insert',
  'O': 'vim-insert',
  'p': 'term-paste',
  'P': 'term-paste',
  'C-c': 'term-interrupt',
  'q': 'vim-insert',
});

defineKey({ keymaps: 'global', states: ['normal', 'visual'], prefix: 'SPC' }, {
  'o': { label: 'open' },
  'o t': 'term',
  'o T': 'term-other-window',
  'b t': 'term-list',
});
