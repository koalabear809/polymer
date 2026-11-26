// Printing values for humans (like Emacs prin1 / princ).

/** Readable representation: strings quoted, objects shallowly expanded. */
export function prin1(value, depth = 2, seen = new WeakSet()) {
  switch (typeof value) {
    case 'string': return JSON.stringify(value);
    case 'undefined': return 'undefined';
    case 'bigint': return `${value}n`;
    case 'symbol': return value.toString();
    case 'function': return `#<function ${value.name || 'anonymous'}>`;
    case 'number':
    case 'boolean': return String(value);
  }
  if (value === null) return 'null';
  if (value instanceof Error) return `#<${value.name}: ${value.message}>`;
  if (value instanceof RegExp) return value.toString();
  if (typeof value.toString === 'function' && value.toString !== Object.prototype.toString
      && !Array.isArray(value) && !(value instanceof Map) && !(value instanceof Set)) {
    const s = value.toString();
    if (s.startsWith('#<')) return s;
  }
  if (seen.has(value)) return '#<circular>';
  seen.add(value);
  if (depth < 0) return Array.isArray(value) ? '[…]' : '{…}';
  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map((v) => prin1(v, depth - 1, seen));
    if (value.length > 50) items.push(`… ${value.length - 50} more`);
    return `[${items.join(', ')}]`;
  }
  if (value instanceof Map) {
    const items = [...value].slice(0, 50).map(([k, v]) => `${prin1(k, depth - 1, seen)} => ${prin1(v, depth - 1, seen)}`);
    return `Map(${value.size}) {${items.join(', ')}}`;
  }
  if (value instanceof Set) {
    return `Set(${value.size}) {${[...value].slice(0, 50).map((v) => prin1(v, depth - 1, seen)).join(', ')}}`;
  }
  if (typeof Element !== 'undefined' && value instanceof Element) return `#<element ${value.tagName.toLowerCase()}>`;
  const ctor = value.constructor && value.constructor !== Object ? `${value.constructor.name} ` : '';
  const keys = Object.keys(value);
  const items = keys.slice(0, 30).map((k) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${prin1(value[k], depth - 1, seen)}`);
  if (keys.length > 30) items.push(`… ${keys.length - 30} more`);
  return `${ctor}{${items.join(', ')}}`;
}

/** Display representation: strings as-is, everything else via prin1. */
export const princ = (value) => (typeof value === 'string' ? value : prin1(value));

/**
 * Emacs-style format: %s (princ), %S (prin1), %d (integer), %% (literal %).
 * Extra arguments without specifiers are appended, separated by spaces.
 */
export function format(fmt, ...args) {
  if (typeof fmt !== 'string') return [fmt, ...args].map(princ).join(' ');
  let i = 0;
  const out = fmt.replace(/%([sSd%])/g, (m, c) => {
    if (c === '%') return '%';
    if (i >= args.length) return m;
    const a = args[i++];
    if (c === 's') return princ(a);
    if (c === 'S') return prin1(a);
    return String(Math.trunc(Number(a)));
  });
  const rest = args.slice(i).map(princ);
  return rest.length ? `${out} ${rest.join(' ')}` : out;
}
