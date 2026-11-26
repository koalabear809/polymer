// The command loop: turns key events into commands.
//
// Each key press is looked up in the active context's keymaps (helm, or the current
// buffer's keymaps). A complete binding runs its command; a prefix waits for more keys
// and shows which-key after a delay.

import { keyFromEvent, keysToString, normalizeKey, isPrintableKey } from './keys.js';
import { lookupKey, prefixEntries } from './keymap.js';
import { call, functionInfo, setq, getVarOr, defvar, runHooks } from './registry.js';
import { PolymerError, Quit, isQuit } from './errors.js';
import { currentBuffer } from './buffer.js';
import { bufferKeymaps } from './modes.js';
import { message, errorMessage, echo, clearEcho } from './echo.js';
import { showWhichKey, hideWhichKey, whichKeyVisible } from './which-key.js';
import { scheduleRedisplay } from './redisplay.js';

defvar('this-command', null, { doc: 'The command now being executed.' });
defvar('last-command', null, { doc: 'The previous command executed.' });
defvar('which-key-idle-delay', 400, { doc: 'Milliseconds to wait after a prefix key before showing which-key.' });
defvar('debug-on-error', false, { doc: 'When true, log full stack traces of command errors to the devtools console.' });

let pending = [];
let whichKeyTimer = null;
let capture = null; // active readKeySequence: { resolve, reject, prompt }
let charCapture = null; // active readChar: { resolve, reject }
let replayQueue = null; // keys being replayed by executeKeys (readChar takes from here)
let thisCommandKeys = [];
const contextStack = [];

/**
 * Contexts decide which keymaps are active. The top of the stack wins; with an empty
 * stack the current buffer's keymaps are used. A context is:
 *   { state, keymaps, unbound?(key, event) }
 */
export function pushContext(ctx) { contextStack.push(ctx); }
export function popContext(ctx) {
  const i = contextStack.lastIndexOf(ctx);
  if (i >= 0) contextStack.splice(i, 1);
}

function bufferContext() {
  const b = currentBuffer();
  return {
    state: b?.state ?? 'normal',
    // A buffer may choose its keymaps per state (a terminal passes almost everything to
    // the program in insert state).
    keymaps: b ? (b.keymapsFor?.(b.state) ?? bufferKeymaps(b)) : ['global'],
    // In insert state, unbound printable keys go through to the input element and are
    // inserted. Everything else is swallowed so the webview doesn't act on it (SPC
    // scrolling, Tab focus, ...). Super (Cmd) chords are left for the OS menu/clipboard.
    unbound(key, e) {
      if (b?.onUnboundKey) {
        if (b.onUnboundKey(key, e)) { e.preventDefault(); return; }
      }
      if (key.includes('s-')) return;
      if ((b?.state === 'insert' || b?.state === 'replace') && isPrintableKey(key)) return;
      e.preventDefault();
      runHooks('unbound-key-hook', key, b);
    },
    insertsText: (key) => !b?.onUnboundKey && (b?.state === 'insert' || b?.state === 'replace') && isPrintableKey(key),
    onUnbound: (key) => (b?.onUnboundKey ? b.onUnboundKey(key, null) : runHooks('unbound-key-hook', key, b)),
  };
}

export const activeContext = () => contextStack.at(-1) ?? bufferContext();
export const thisCommandKeysString = () => keysToString(thisCommandKeys);

function consume(e) {
  e.preventDefault();
  e.stopPropagation();
}

function resetPending() {
  pending = [];
  clearTimeout(whichKeyTimer);
  whichKeyTimer = null;
  hideWhichKey();
}

function scheduleWhichKey(nodes, keys) {
  clearTimeout(whichKeyTimer);
  const show = () => showWhichKey(keysToString(keys), prefixEntries(nodes));
  if (whichKeyVisible()) show();
  else whichKeyTimer = setTimeout(show, getVarOr('which-key-idle-delay', 400));
}

export function handleKeyEvent(e) {
  const key = keyFromEvent(e);
  if (!key) return;
  processKey(key, e);
}

const keyText = (key) => (key === 'SPC' ? ' ' : key === 'RET' ? '\n' : key === 'TAB' ? '\t' : key);

/**
 * Process one key. `e` is the DOM event, or null when keys are replayed
 * (dot-repeat, :normal, executeKeys). Returns a promise that settles when the command
 * the key completed has finished.
 */
export function processKey(key, e = null) {
  const consume = (ev) => { if (ev) { ev.preventDefault(); ev.stopPropagation(); } };

  if (charCapture) {
    consume(e);
    const c = charCapture;
    charCapture = null;
    if (key === 'C-g' || key === 'ESC') c.reject(new Quit());
    else c.resolve(key);
    return Promise.resolve();
  }

  const ctx = activeContext();
  const keys = [...pending, key];
  const res = lookupKey(ctx.keymaps, ctx.state, keys);

  // C-g or ESC after a prefix cancels it, unless the sequence is bound (e.g. C-\ ESC).
  if (pending.length && (key === 'C-g' || key === 'ESC') && !res) {
    consume(e);
    resetPending();
    if (capture) { const c = capture; capture = null; c.reject(new Quit()); }
    clearEcho();
    return Promise.resolve();
  }

  if (capture) {
    consume(e);
    if (key === 'C-g' && !pending.length) { const c = capture; capture = null; resetPending(); c.reject(new Quit()); return Promise.resolve(); }
    if (res?.type === 'prefix') {
      pending = keys;
      echo(`${capture.prompt}${keysToString(keys)}-`);
      return Promise.resolve();
    }
    const c = capture;
    capture = null;
    resetPending();
    c.resolve({ keys, cmd: res?.cmd ?? null });
    return Promise.resolve();
  }

  if (res?.type === 'command') {
    consume(e);
    resetPending();
    if (e) clearEcho();
    return runCommand(res.cmd, keys);
  }
  if (res?.type === 'prefix') {
    consume(e);
    pending = keys;
    if (e) {
      echo(`${keysToString(keys)}-`);
      scheduleWhichKey(res.nodes, keys);
    }
    return Promise.resolve();
  }
  if (pending.length) {
    consume(e);
    resetPending();
    message('%s is undefined', keysToString(keys));
    return Promise.resolve();
  }
  if (e) {
    ctx.unbound?.(key, e);
    return Promise.resolve();
  }
  // Replayed key with no binding: printable keys type text where the context allows it.
  if (ctx.insertsText?.(key)) return runCommand('self-insert-command', keys, [keyText(key)]);
  return ctx.onUnbound ? Promise.resolve(ctx.onUnbound(key)) : Promise.resolve();
}

/**
 * Run keys as if typed. Items are key strings ("d", "w", "C-w", "RET") or { text }
 * for inserted text. Commands that read a character (f, t, r, m, ...) take it from the
 * remaining keys.
 */
export async function executeKeys(items) {
  const outer = replayQueue;
  replayQueue = [...items];
  try {
    while (replayQueue.length) {
      const item = replayQueue.shift();
      if (typeof item === 'string') await processKey(item, null);
      else if (item?.text !== undefined) await callInteractively('self-insert-command', { args: [item.text] });
    }
  } finally {
    replayQueue = outer;
  }
}

/** Parse "dw", "ciwfoo<esc>", "<C-w>" into keys for executeKeys. */
export function parseKeyString(str) {
  const out = [];
  const re = /<([^<>\s]+)>|([\s\S])/g;
  const special = { esc: 'ESC', cr: 'RET', enter: 'RET', ret: 'RET', return: 'RET', tab: 'TAB', bs: 'DEL', space: 'SPC', lt: '<', del: '<delete>', up: '<up>', down: '<down>', left: '<left>', right: '<right>' };
  for (let m = re.exec(str); m; m = re.exec(str)) {
    if (m[1]) {
      const inner = m[1];
      const lower = inner.toLowerCase();
      if (special[lower]) out.push(special[lower]);
      else if (/^[CMSs]-/.test(inner)) out.push(normalizeKey(inner.replace(/^([CMSs])-(.+)$/, (x, mod, rest) => `${mod}-${special[rest.toLowerCase()] ?? rest}`)));
      else out.push(`<${lower}>`);
    } else {
      const ch = m[2];
      out.push(ch === ' ' ? 'SPC' : ch === '\n' ? 'RET' : ch === '\t' ? 'TAB' : ch);
    }
  }
  return out;
}

/**
 * Read a single key (for f/t/r/m/"/...). Resolves to the key string ("a", "SPC", "RET").
 * C-g or ESC rejects with Quit. During replay the key comes from the replayed keys.
 */
export function readChar(prompt) {
  if (replayQueue?.length) {
    const k = replayQueue.shift();
    const key = typeof k === 'string' ? k : k.text;
    runHooks('read-char-hook', key);
    return Promise.resolve(key);
  }
  if (prompt) echo(prompt);
  return new Promise((resolve, reject) => {
    charCapture = {
      resolve: (k) => { runHooks('read-char-hook', k); resolve(k); },
      reject,
    };
  });
}

/** The character a key types: "a" -> "a", "SPC" -> " ", "RET" -> "\n". */
export { keyText };

/** Report an error from a command the way the command loop does. */
export function reportError(err) {
  if (isQuit(err)) { message('Quit'); return; }
  if (getVarOr('debug-on-error', false)) console.error(err);
  errorMessage(err);
}

async function runCommand(cmd, keys, args) {
  try {
    if (typeof cmd === 'function') {
      thisCommandKeys = keys;
      await cmd();
    } else {
      await callInteractively(cmd, { keys, args });
    }
  } catch (err) {
    reportError(err);
  } finally {
    // Like Emacs, redisplay after every command: a command may only have moved point,
    // which doesn't mark the buffer as changed.
    scheduleRedisplay();
  }
}

/**
 * Call a command as if invoked by the user: computes its arguments with its
 * `interactive` spec, maintains this-command/last-command, and runs the command hooks.
 */
export async function callInteractively(name, { keys = [], args: givenArgs } = {}) {
  const info = functionInfo(name);
  if (!info) throw new PolymerError('void-function', `Symbol's function definition is void: ${name}`, name);
  if (!info.command) throw new PolymerError('error', `${name} is not an interactive command`);
  thisCommandKeys = keys;
  const args = givenArgs ?? (typeof info.interactive === 'function' ? await info.interactive() : []);
  setq('last-command', getVarOr('this-command', null), null);
  setq('this-command', name, null);
  runHooks('pre-command-hook', name, args ?? [], keys);
  try {
    return await call(name, ...(args ?? []));
  } finally {
    runHooks('post-command-hook', name);
    scheduleRedisplay();
  }
}

/**
 * Read a complete key sequence from the user (used by describe-key).
 * Resolves to { keys, cmd } where cmd is the binding in the active context, or null.
 */
export function readKeySequence(prompt = 'Describe key: ') {
  if (capture) return Promise.reject(new PolymerError('error', 'Already reading a key sequence'));
  echo(prompt);
  return new Promise((resolve, reject) => { capture = { resolve, reject, prompt }; });
}

export function installKeyHandler(target = window) {
  target.addEventListener('keydown', handleKeyEvent, true);
}

export { normalizeKey };
