// Key descriptions in Emacs notation: "C-x", "M-x", "s-s" (super/Cmd), "SPC", "RET",
// "TAB", "ESC", "DEL", "<up>", "<f1>", "C-S-a". Modifier order is always C- M- s- S-.

const SPECIAL = {
  ' ': 'SPC',
  Enter: 'RET',
  Tab: 'TAB',
  Escape: 'ESC',
  Backspace: 'DEL',
  Delete: '<delete>',
  ArrowUp: '<up>',
  ArrowDown: '<down>',
  ArrowLeft: '<left>',
  ArrowRight: '<right>',
  Home: '<home>',
  End: '<end>',
  PageUp: '<prior>',
  PageDown: '<next>',
  Insert: '<insert>',
};

// Physical key -> unshifted character, used when Option/Alt rewrites e.key (macOS).
const CODE_CHARS = {
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`', Space: ' ',
};

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'OS', 'Hyper', 'Super', 'CapsLock', 'AltGraph', 'Fn']);

// Shifted characters for the US layout, used only when Option has composed the key.
const SHIFTED = {
  '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
  '-': '_', '=': '+', '[': '{', ']': '}', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?', '\\': '|', '`': '~',
};

function baseFromCode(code, shift) {
  if (code.startsWith('Key')) {
    const c = code.slice(3).toLowerCase();
    return shift ? c.toUpperCase() : c;
  }
  let c = null;
  if (code.startsWith('Digit')) c = code.slice(5);
  else c = CODE_CHARS[code] ?? null;
  if (c !== null && shift) c = SHIFTED[c] ?? c;
  return c;
}

// A plain printable ASCII character, i.e. not composed by Option/AltGr.
const isPlainAscii = (k) => k.length === 1 && k >= ' ' && k <= '~';

/** Convert a KeyboardEvent to a key description, or null for modifier-only/IME events. */
export function keyFromEvent(e) {
  if (e.isComposing || e.keyCode === 229) return null;
  if (MODIFIER_KEYS.has(e.key)) return null;

  let key = e.key;
  // Option on macOS produces composed characters (å, ∂, dead keys); recover the base key.
  // On other platforms Alt leaves e.key alone, so it is used as-is.
  if (e.altKey && e.code && !isPlainAscii(key) && !SPECIAL[key]) {
    const base = baseFromCode(e.code, e.shiftKey);
    if (base !== null) key = base;
  }

  let name;
  let shiftIsImplicit = false;
  if (SPECIAL[key]) {
    name = SPECIAL[key];
  } else if (/^F\d{1,2}$/.test(key)) {
    name = `<${key.toLowerCase()}>`;
  } else if (key.length === 1) {
    name = key;
    // For printable characters, shift is already reflected in the character itself.
    shiftIsImplicit = true;
  } else {
    name = `<${key.toLowerCase()}>`;
  }

  const mods = [];
  if (e.ctrlKey) mods.push('C-');
  if (e.altKey) mods.push('M-');
  if (e.metaKey) mods.push('s-');

  if (shiftIsImplicit) {
    // "C-A" reads poorly; write C-S-a like Emacs when combined with other modifiers.
    if (mods.length && /^[A-Z]$/.test(name)) {
      name = name.toLowerCase();
      mods.push('S-');
    }
  } else if (e.shiftKey) {
    mods.push('S-');
  }
  return mods.join('') + name;
}

const ALIASES = {
  space: 'SPC', spc: 'SPC', '<space>': 'SPC',
  return: 'RET', enter: 'RET', '<return>': 'RET', ret: 'RET',
  tab: 'TAB', '<tab>': 'TAB',
  escape: 'ESC', esc: 'ESC', '<escape>': 'ESC',
  backspace: 'DEL', '<backspace>': 'DEL', del: 'DEL',
};

/** Normalize one key written by a user ("M-C-x" -> "C-M-x", "<escape>" -> "ESC"). */
export function normalizeKey(k) {
  const m = /^((?:[CMsSAH]-)*)(.+)$/.exec(k);
  if (!m) return k;
  const mods = new Set(m[1].match(/[CMsSAH]-/g) ?? []);
  let base = m[2];
  base = ALIASES[base.toLowerCase()] ?? ALIASES[base] ?? base;
  if (mods.has('A-')) { mods.delete('A-'); mods.add('M-'); } // A- (alt) is an alias for meta
  const order = ['C-', 'M-', 's-', 'S-'];
  return order.filter((o) => mods.has(o)).join('') + base;
}

/** Parse "SPC f f" or "C-x C-f" into ['SPC', 'f', 'f']. */
export function parseKeys(seq) {
  if (Array.isArray(seq)) return seq.map(normalizeKey);
  return seq.trim().split(/\s+/).filter(Boolean).map(normalizeKey);
}

export const keysToString = (keys) => keys.join(' ');

/**
 * True for keys that would insert a character (no C-/M-/s- modifier). Shift+Space types a
 * space too: Shift is often still held from a capital letter when typing fast ("I am").
 */
export function isPrintableKey(key) {
  return key.length === 1 || key === 'SPC' || key === 'S-SPC';
}
