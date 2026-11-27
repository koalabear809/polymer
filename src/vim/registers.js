// Vim registers.
//
//   "        unnamed: the last yank or delete
//   0        last yank
//   1-9      deletes of a line or more, shifted on each delete
//   -        small (within-line) deletes
//   a-z      named; A-Z appends to the lowercase register
//   + *      system clipboard
//   _        black hole
//   .        last inserted text (read-only)
//   :        last ex command (read-only)
//   /        last search pattern (read-only)
//   %        current file name (read-only)
//
// A register value is { text, type } with type 'char' | 'line' | 'block'. Line text
// ends with "\n"; block text is lines joined with "\n".

import { defvar, getVarOr } from '../core/registry.js';
import { currentBuffer } from '../core/buffer.js';
import { readClipboardText, writeClipboardText } from '../core/clipboard.js';

defvar('vim-clipboard', true, {
  doc: 'When true, yanks and deletes without an explicit register are also copied to the system clipboard.',
});

const registers = new Map();
const readOnly = new Map(); // '.', ':', '/'

export function setReadOnlyRegister(name, text) {
  readOnly.set(name, { text, type: 'char' });
}

function copyToClipboard(text) {
  // If the system clipboard fails, the internal register still holds the text.
  Promise.resolve().then(() => writeClipboardText(text)).catch((e) => console.warn('clipboard write failed:', e));
}

/**
 * Store text from a yank or delete.
 * kind: 'yank' | 'delete'. `name` is the register the user chose, or null.
 */
export function storeRegister(name, text, type, kind) {
  if (name === '_') return;
  const value = { text, type };
  if (name && /^[a-z]$/.test(name)) {
    registers.set(name, value);
  } else if (name && /^[A-Z]$/.test(name)) {
    const lower = name.toLowerCase();
    const prev = registers.get(lower);
    if (prev) {
      const joined = prev.type === 'line' || type === 'line'
        ? { text: (prev.text.endsWith('\n') ? prev.text : `${prev.text}\n`) + text, type: 'line' }
        : { text: prev.text + text, type: prev.type };
      registers.set(lower, joined);
    } else {
      registers.set(lower, value);
    }
    registers.set('"', registers.get(lower));
    return;
  } else if (name === '+' || name === '*') {
    copyToClipboard(text);
  } else if (!name) {
    if (kind === 'yank') {
      registers.set('0', value);
    } else if (type === 'line' || text.includes('\n')) {
      for (let i = 9; i > 1; i--) {
        const prev = registers.get(String(i - 1));
        if (prev) registers.set(String(i), prev);
      }
      registers.set('1', value);
    } else {
      registers.set('-', value);
    }
    if (getVarOr('vim-clipboard', true)) copyToClipboard(text);
  }
  registers.set('"', value);
}

/** Read a register. Resolves to { text, type } or null. */
export async function getRegister(name = '"') {
  if (name === '+' || name === '*') {
    try {
      const text = await readClipboardText();
      return { text, type: text.endsWith('\n') ? 'line' : 'char' };
    } catch {
      return registers.get(name) ?? null;
    }
  }
  if (name === '%') {
    const f = currentBuffer()?.file;
    return f ? { text: f, type: 'char' } : null;
  }
  if (readOnly.has(name)) return readOnly.get(name);
  if (/^[A-Z]$/.test(name)) name = name.toLowerCase();
  return registers.get(name) ?? null;
}

/** All registers with contents, for :registers. */
export function registerList() {
  const out = [];
  for (const [k, v] of registers) out.push([k, v]);
  for (const [k, v] of readOnly) out.push([k, v]);
  const order = '"0123456789-abcdefghijklmnopqrstuvwxyz+*.:/';
  return out.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
}

export const validRegister = (c) => /^["0-9a-zA-Z\-_+*.:/%]$/.test(c);
