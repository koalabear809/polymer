// The echo area (bottom line) and the *Messages* buffer.

import { format } from './printer.js';
import { getBufferCreate } from './buffer.js';
import { defvar, getVarOr } from './registry.js';

defvar('message-log-max', 1000, { doc: 'Maximum number of lines kept in *Messages*.' });

let el = null;
let lastText = '';
let repeat = 1;

export function attachEcho(element) { el = element; }

function logMessage(text) {
  const buf = getBufferCreate('*Messages*');
  buf.undoEnabled = false;
  const opts = { inhibitReadOnly: true, undo: false };
  const t = buf.text;
  if (text === lastText && t.length) {
    // Collapse repeats like Emacs: "foo [2 times]". The text ends with "\n", so the
    // last message is on the second-to-last line.
    repeat++;
    const line = t.lineCount - 2;
    buf.replaceText(t.lineStart(line), t.lineEnd(line), `${text} [${repeat} times]`, opts);
    return;
  }
  lastText = text;
  repeat = 1;
  buf.append(`${text}\n`);
  const excess = buf.text.lineCount - 1 - getVarOr('message-log-max', 1000);
  if (excess > 0) buf.deleteText(0, buf.text.lineStart(excess), opts);
}

function show(text, cls) {
  if (!el) return;
  el.textContent = text;
  el.className = cls ?? '';
}

/** Show a message in the echo area and log it to *Messages*. Returns the formatted text. */
export function message(fmt, ...args) {
  if (fmt === null || fmt === undefined) { clearEcho(); return null; }
  const text = format(fmt, ...args);
  show(text);
  logMessage(text);
  return text;
}

/** Show an error in the echo area and log it. */
export function errorMessage(err) {
  const text = err instanceof Error ? (err.symbol && err.symbol !== 'error' ? `${err.message}` : err.message) : String(err);
  show(text, 'error');
  logMessage(text);
  if (err instanceof Error && !err.symbol) console.error(err);
  return text;
}

/** Show text in the echo area without logging (e.g. pending key prefixes). */
export function echo(text) { show(text, 'dim'); }

export function clearEcho() { show(''); }
