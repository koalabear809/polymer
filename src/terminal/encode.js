// Encoding keys for a terminal (xterm conventions).
//
// Keys arrive in Polymer's notation ("a", "C-c", "M-f", "RET", "<up>", "S-<f5>").

const SIMPLE = {
  RET: '\r',
  TAB: '\t',
  DEL: '\x7f',
  ESC: '\x1b',
  SPC: ' ',
};

// Keys that take the "CSI 1 ; mod X" form when modified.
const CURSOR = { '<up>': 'A', '<down>': 'B', '<right>': 'C', '<left>': 'D', '<home>': 'H', '<end>': 'F' };
// Keys that take the "CSI n ; mod ~" form.
const TILDE = { '<insert>': 2, '<delete>': 3, '<prior>': 5, '<next>': 6, '<f5>': 15, '<f6>': 17, '<f7>': 18, '<f8>': 19, '<f9>': 20, '<f10>': 21, '<f11>': 23, '<f12>': 24 };
const SS3 = { '<f1>': 'P', '<f2>': 'Q', '<f3>': 'R', '<f4>': 'S' };

function parse(key) {
  const mods = { C: false, M: false, s: false, S: false };
  let rest = key;
  while (/^[CMsS]-./.test(rest)) {
    mods[rest[0]] = true;
    rest = rest.slice(2);
  }
  return { mods, base: rest };
}

function ctrlChar(ch) {
  const c = ch.toLowerCase();
  if (c >= 'a' && c <= 'z') return String.fromCharCode(c.charCodeAt(0) - 96);
  const table = { '@': '\x00', ' ': '\x00', '2': '\x00', '[': '\x1b', '3': '\x1b', '\\': '\x1c', '4': '\x1c', ']': '\x1d', '5': '\x1d', '^': '\x1e', '6': '\x1e', '_': '\x1f', '-': '\x1f', '7': '\x1f', '/': '\x1f', '?': '\x7f', '8': '\x7f' };
  return table[ch] ?? null;
}

/**
 * Bytes (as a string) to send for a key, or null if the terminal shouldn't get it
 * (Cmd/super chords are left to the app and OS).
 * appCursor: the program enabled application cursor keys (DECCKM).
 */
export function encodeKey(key, { appCursor = false } = {}) {
  const { mods, base } = parse(key);
  if (mods.s) return null;
  const modCode = 1 + (mods.S ? 1 : 0) + (mods.M ? 2 : 0) + (mods.C ? 4 : 0);

  if (CURSOR[base]) {
    const c = CURSOR[base];
    if (modCode > 1) return `\x1b[1;${modCode}${c}`;
    return appCursor && 'ABCD'.includes(c) ? `\x1bO${c}` : `\x1b[${c}`;
  }
  if (TILDE[base] !== undefined) return modCode > 1 ? `\x1b[${TILDE[base]};${modCode}~` : `\x1b[${TILDE[base]}~`;
  if (SS3[base]) return modCode > 1 ? `\x1b[1;${modCode}${SS3[base]}` : `\x1bO${SS3[base]}`;
  if (base === 'TAB' && mods.S) return '\x1b[Z';

  let out;
  if (SIMPLE[base] !== undefined) {
    out = SIMPLE[base];
    if (mods.C && base === 'SPC') out = '\x00';
  } else if ([...base].length === 1) {
    out = base;
    if (mods.S && /^[a-z]$/.test(out)) out = out.toUpperCase();
    if (mods.C) {
      const c = ctrlChar(out);
      if (c === null) return null;
      out = c;
    }
  } else {
    return null; // unknown named key
  }
  return mods.M ? `\x1b${out}` : out;
}

/** Wrap pasted text for programs that asked for bracketed paste. */
export function encodePaste(text, bracketed) {
  const t = text.replace(/\r?\n/g, '\r');
  return bracketed ? `\x1b[200~${t}\x1b[201~` : t;
}

// xterm's 256-color palette for indices 16-255.
export function xtermColor(i) {
  if (i < 16) return null;
  if (i < 232) {
    const n = i - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    const r = steps[Math.floor(n / 36)];
    const g = steps[Math.floor(n / 6) % 6];
    const b = steps[n % 6];
    return `rgb(${r},${g},${b})`;
  }
  const v = 8 + (i - 232) * 10;
  return `rgb(${v},${v},${v})`;
}
