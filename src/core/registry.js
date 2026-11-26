// The registry: Polymer's symbol tables.
//
// Everything is resolved *by name at call time*, like Emacs symbols. Keymaps, hooks,
// advice and other code refer to functions by name, so redefining a function (or
// re-evaluating a file) takes effect everywhere immediately.

import { PolymerError } from './errors.js';

const functions = new Map(); // name -> { name, fn, doc, command, interactive, mcp, definedAt }
const variables = new Map(); // name -> { name, value, doc, local, watchers }
const hooks = new Map();     // name -> [{ id, fn }]
const advices = new Map();   // name -> [{ id, how, fn }]
const features = new Set();

// The current buffer is owned by the buffer module; it registers a provider here so
// buffer-local variables resolve without an import cycle.
let currentBufferProvider = () => null;
export function setCurrentBufferProvider(fn) { currentBufferProvider = fn; }

const isThenable = (v) => v != null && typeof v.then === 'function';

// ---------------------------------------------------------------------------
// Functions and commands

/** Define (or redefine) a named function. */
export function defun(name, fn, opts = {}) {
  if (typeof name !== 'string' || !name) throw new TypeError('defun: name must be a non-empty string');
  if (typeof fn !== 'function') throw new TypeError(`defun ${name}: expected a function`);
  const prev = functions.get(name);
  functions.set(name, {
    name,
    fn,
    doc: opts.doc ?? '',
    command: !!opts.command,
    interactive: opts.interactive ?? null,
    mcp: !!opts.mcp,
    definedAt: Date.now(),
  });
  if (prev) runHooks('function-redefined-hook', name);
  return name;
}

/**
 * Define an interactive command (shows up in M-x, can be bound to keys).
 *   defcommand(name, fn)
 *   defcommand(name, { doc, interactive, mcp }, fn)
 * `interactive` is an optional (async) function returning the argument list when the
 * command is invoked from a key or M-x, e.g. `async () => [await readString('Name: ')]`.
 */
export function defcommand(name, opts, fn) {
  if (typeof opts === 'function') [opts, fn] = [{}, opts];
  return defun(name, fn, { ...opts, command: true });
}

export function fboundp(name) { return functions.has(name); }
export function commandp(name) { return !!functions.get(name)?.command; }
export function functionInfo(name) { return functions.get(name) ?? null; }
export function fmakunbound(name) { functions.delete(name); advices.delete(name); }

/** All function entries, optionally filtered. */
export function allFunctions(pred = () => true) {
  return [...functions.values()].filter(pred);
}

/** Call a function by name. Advice is applied at call time. */
export function call(name, ...args) {
  if (typeof name === 'function') return name(...args);
  const entry = functions.get(name);
  if (!entry) throw new PolymerError('void-function', `Symbol's function definition is void: ${name}`, name);
  const ads = advices.get(name);
  if (!ads || ads.length === 0) return entry.fn(...args);
  return compose(entry.fn, ads)(...args);
}

// ---------------------------------------------------------------------------
// Advice
//
// how: 'before' | 'after' | 'around' | 'override' | 'filter-args' | 'filter-return'
// Advice functions may be functions or function names (resolved at call time).
// Adding advice with the same id twice replaces it, so re-evaluating a file is safe.

function compose(orig, ads) {
  let f = orig;
  for (const a of ads) {
    const inner = f;
    const ad = (...xs) => call(a.fn, ...xs);
    switch (a.how) {
      case 'override':
        f = (...args) => ad(...args);
        break;
      case 'around':
        f = (...args) => ad(inner, ...args);
        break;
      case 'before':
        f = (...args) => {
          const r = ad(...args);
          return isThenable(r) ? r.then(() => inner(...args)) : inner(...args);
        };
        break;
      case 'after':
        f = (...args) => {
          const r = inner(...args);
          if (isThenable(r)) return r.then(async (v) => { await ad(...args); return v; });
          ad(...args);
          return r;
        };
        break;
      case 'filter-args':
        f = (...args) => inner(...ad(args));
        break;
      case 'filter-return':
        f = (...args) => {
          const r = inner(...args);
          return isThenable(r) ? r.then(ad) : ad(r);
        };
        break;
      default:
        throw new PolymerError('error', `Unknown advice type: ${a.how}`);
    }
  }
  return f;
}

function idOf(fn, explicit) {
  if (explicit) return explicit;
  if (typeof fn === 'string') return fn;
  return fn.name || fn;
}

export function advice(name, how, fn, opts = {}) {
  const id = idOf(fn, opts.id);
  const list = (advices.get(name) ?? []).filter((a) => a.id !== id);
  list.push({ id, how, fn });
  advices.set(name, list);
  return id;
}

export function removeAdvice(name, fnOrId) {
  const id = idOf(fnOrId);
  const list = (advices.get(name) ?? []).filter((a) => a.id !== id && a.fn !== fnOrId);
  advices.set(name, list);
}

export function adviceList(name) { return [...(advices.get(name) ?? [])]; }

// ---------------------------------------------------------------------------
// Variables
//
// defvar never clobbers an existing value (Emacs semantics), so re-evaluating a
// package keeps the user's settings. Use setq to change values.

export function defvar(name, initial, opts = {}) {
  const existing = variables.get(name);
  if (existing) {
    if (opts.doc) existing.doc = opts.doc;
    if (opts.local) existing.local = true;
    return name;
  }
  variables.set(name, { name, value: initial, doc: opts.doc ?? '', local: !!opts.local, watchers: [] });
  return name;
}

export function boundp(name) { return variables.has(name); }
export function variableInfo(name) { return variables.get(name) ?? null; }
export function allVariables() { return [...variables.values()]; }

function resolveBuffer(buf) { return buf === undefined ? currentBufferProvider() : buf; }

/** Value of a variable, honouring buffer-local bindings in `buf` (default: current buffer). */
export function getVar(name, buf) {
  const b = resolveBuffer(buf);
  if (b?.locals?.has(name)) return b.locals.get(name);
  const v = variables.get(name);
  if (!v) throw new PolymerError('void-variable', `Symbol's value as variable is void: ${name}`, name);
  return v.value;
}

/** Like getVar but returns `fallback` instead of throwing for unbound variables. */
export function getVarOr(name, fallback, buf) {
  const b = resolveBuffer(buf);
  if (b?.locals?.has(name)) return b.locals.get(name);
  return variables.has(name) ? variables.get(name).value : fallback;
}

function notify(name, value, op, buf) {
  for (const w of variables.get(name)?.watchers ?? []) {
    try { call(w, name, value, op, buf); } catch (e) { console.error(`watcher for ${name}:`, e); }
  }
}

/**
 * Set a variable. Sets the buffer-local value if the variable already has one in the
 * current buffer, or if it was declared with `{ local: true }`; otherwise the global value.
 */
export function setq(name, value, buf) {
  const b = resolveBuffer(buf);
  let v = variables.get(name);
  if (!v) { defvar(name, undefined); v = variables.get(name); }
  if (b && (b.locals?.has(name) || v.local)) {
    b.locals.set(name, value);
    notify(name, value, 'set-local', b);
  } else {
    v.value = value;
    notify(name, value, 'set', null);
  }
  return value;
}

/** Set the global (default) value, ignoring buffer-local bindings. */
export function setDefault(name, value) {
  if (!variables.has(name)) defvar(name, undefined);
  variables.get(name).value = value;
  notify(name, value, 'set', null);
  return value;
}

/** Give `name` a buffer-local value in `buf` (default: current buffer). */
export function setLocal(name, value, buf) {
  const b = resolveBuffer(buf);
  if (!b) throw new PolymerError('error', 'setLocal: no buffer');
  if (!variables.has(name)) defvar(name, undefined);
  b.locals.set(name, value);
  notify(name, value, 'set-local', b);
  return value;
}

export function killLocal(name, buf) {
  const b = resolveBuffer(buf);
  b?.locals?.delete(name);
}

export function addVariableWatcher(name, fn) {
  if (!variables.has(name)) defvar(name, undefined);
  const w = variables.get(name).watchers;
  if (!w.includes(fn)) w.push(fn);
}

export function removeVariableWatcher(name, fn) {
  const v = variables.get(name);
  if (v) v.watchers = v.watchers.filter((w) => w !== fn);
}

// ---------------------------------------------------------------------------
// Hooks
//
// Hook entries are functions or function names. Adding the same name/id again is a
// no-op (re-evaluation safe). A failing hook function is reported but doesn't stop
// the others.

export function addHook(hook, fn, opts = {}) {
  const id = idOf(fn, opts.id);
  const list = (hooks.get(hook) ?? []).filter((h) => h.id !== id);
  if (opts.append) list.push({ id, fn });
  else list.unshift({ id, fn });
  hooks.set(hook, list);
  return id;
}

export function removeHook(hook, fnOrId) {
  const id = idOf(fnOrId);
  hooks.set(hook, (hooks.get(hook) ?? []).filter((h) => h.id !== id && h.fn !== fnOrId));
}

export function hookList(hook) { return [...(hooks.get(hook) ?? [])]; }

let hookErrorReporter = (hook, e) => console.error(`Error in ${hook}:`, e);
export function setHookErrorReporter(fn) { hookErrorReporter = fn; }

/** Run hook functions synchronously. Promises they return are not awaited. */
export function runHooks(hook, ...args) {
  for (const { fn } of hooks.get(hook) ?? []) {
    try {
      const r = call(fn, ...args);
      if (isThenable(r)) r.catch((e) => hookErrorReporter(hook, e));
    } catch (e) {
      hookErrorReporter(hook, e);
    }
  }
}

/** Run hook functions in order, awaiting each. */
export async function runHooksAsync(hook, ...args) {
  for (const { fn } of hooks.get(hook) ?? []) {
    try { await call(fn, ...args); } catch (e) { hookErrorReporter(hook, e); }
  }
}

// ---------------------------------------------------------------------------
// Features (require/provide comes with the package loader in phase 1c)

export function provide(feature) { features.add(feature); runHooks('after-provide-hook', feature); return feature; }
export function featurep(feature) { return features.has(feature); }
export function allFeatures() { return [...features]; }
