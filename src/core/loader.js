// Loading code: init.js, packages, and files.
//
// Each file runs as an async function with these in scope (besides all Polymer globals):
//   module, exports      module.exports is what require() returns
//   require(name)        async: a package name ('my-package') or a relative path ('./util.js')
//   load(path)           async: evaluate a file (always re-runs it)
//   __filename, __dirname
//
// Packages live in a directory on load-path (by default <config>/packages):
//   packages/my-package/package.json   { "description": "...", "main": "index.js", "dependencies": ["other"] }
//   packages/my-package/index.js
// package.json is optional. A single file packages/my-package.js also works.

import { defvar, getVarOr, setq, provide, featurep, runHooks } from './registry.js';
import { PolymerError } from './errors.js';
import {
  readTextFile, pathInfo, listDirectory, makeDirectory, expandFileName, dirname,
  asDirectory, abbreviateFileName,
} from './files.js';
import { appInfo } from './host.js';
import { message } from './echo.js';

defvar('user-config-directory', null, { doc: 'Polymer\'s configuration directory (ends with "/"), e.g. ~/.config/polymer/.' });
defvar('user-init-file', null, { doc: 'The init file loaded at startup.' });
defvar('load-path', [], { doc: 'Directories searched by require() for packages.' });
defvar('init-file-loaded', false, { doc: 'True once init.js has been loaded successfully.' });

const AsyncFunction = (async () => {}).constructor;

const modules = new Map();   // absolute path -> { exports, path, dir }
const packages = new Map();  // name -> { name, dir, entry, manifest, exports }
const inFlight = new Map();  // name/path -> Promise (concurrent requires share one load)

// ---------------------------------------------------------------------------
// Setup

export async function initLoader() {
  const info = await appInfo();
  const dir = info.configDir ? asDirectory(info.configDir.replace(/\\/g, '/')) : null;
  setq('user-config-directory', dir, null);
  setq('user-init-file', dir ? `${dir}init.js` : null, null);
  if (dir && !getVarOr('load-path', [], null).length) setq('load-path', [`${dir}packages/`], null);
  return { noInit: !!info.noInit };
}

export const configDirectory = () => getVarOr('user-config-directory', null, null);

/** A package's private data directory (created on first use). */
export async function packageDataDir(name) {
  const dir = `${configDirectory()}packages/${name}/data/`;
  await makeDirectory(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Evaluating modules

// Engines number lines of `new Function` bodies differently; measure the offset once so
// error messages point at the right line of the file.
let lineOffset = null;
function measureLineOffset() {
  if (lineOffset !== null) return lineOffset;
  try {
    new Function('throw new Error("probe")\n//# sourceURL=polymer-line-probe')();
  } catch (e) {
    const m = /polymer-line-probe:(\d+)/.exec(e.stack ?? '');
    lineOffset = m ? Number(m[1]) - 1 : 0;
  }
  return lineOffset;
}

/** "init.js:12:5: message" for an error thrown while loading `path`, when the stack says. */
export function describeLoadError(e, path) {
  const name = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${name}:(\\d+):(\\d+)`).exec(e?.stack ?? '');
  const where = m ? `${abbreviateFileName(path)}:${Number(m[1]) - measureLineOffset()}` : abbreviateFileName(path);
  return `${where}: ${e?.message ?? e}`;
}

/** Evaluate `code` as the module at `path`. Resolves with module.exports. */
export async function evalModule(code, path) {
  measureLineOffset();
  const dir = dirname(path);
  const module = { exports: {}, path, dir };
  modules.set(path, module);
  const req = (name) => requireFrom(name, dir);
  const ld = (p) => loadFile(expandFileName(p, dir));
  let fn;
  try {
    fn = new AsyncFunction('module', 'exports', 'require', 'load', '__filename', '__dirname', `${code}\n//# sourceURL=${path}`);
  } catch (e) {
    // Syntax errors: say which file.
    throw new PolymerError('load-error', `Syntax error in ${abbreviateFileName(path)}: ${e.message}`, e);
  }
  await fn(module, module.exports, req, ld, path, dir);
  runHooks('after-load-functions', path);
  return module.exports;
}

/** Read and evaluate a file. */
export async function loadFile(path, { noerror = false } = {}) {
  path = expandFileName(path);
  const info = await pathInfo(path);
  if (!info.exists) {
    if (noerror) return null;
    throw new PolymerError('file-missing', `Cannot open load file: ${abbreviateFileName(path)}`);
  }
  const { text } = await readTextFile(path);
  return evalModule(text, path);
}

// ---------------------------------------------------------------------------
// require

const isRelative = (name) => name.startsWith('./') || name.startsWith('../') || name.startsWith('/') || name.startsWith('~') || /^[A-Za-z]:\//.test(name);

async function resolveRelative(name, baseDir) {
  const path = expandFileName(name, baseDir);
  if ((await pathInfo(path)).isFile) return path;
  if (!/\.m?js$/.test(path) && (await pathInfo(`${path}.js`)).isFile) return `${path}.js`;
  if ((await pathInfo(`${asDirectory(path)}index.js`)).isFile) return `${asDirectory(path)}index.js`;
  throw new PolymerError('file-missing', `Cannot find module ${name} from ${abbreviateFileName(baseDir)}`);
}

async function readManifest(dir) {
  const p = `${dir}package.json`;
  if (!(await pathInfo(p)).isFile) return {};
  try {
    return JSON.parse((await readTextFile(p)).text);
  } catch (e) {
    throw new PolymerError('load-error', `Invalid ${abbreviateFileName(p)}: ${e.message}`);
  }
}

/** Find a package on load-path: { name, dir, entry, manifest } or null. */
export async function locatePackage(name) {
  for (const base of getVarOr('load-path', [], null)) {
    const dir = asDirectory(expandFileName(name, asDirectory(base)));
    const info = await pathInfo(dir);
    if (info.isDir) {
      const manifest = await readManifest(dir);
      const entry = expandFileName(manifest.main ?? 'index.js', dir);
      return { name, dir, entry, manifest };
    }
    const file = expandFileName(`${name}.js`, asDirectory(base));
    if ((await pathInfo(file)).isFile) return { name, dir: asDirectory(base), entry: file, manifest: {} };
  }
  return null;
}

function dependencies(manifest) {
  const d = manifest.dependencies;
  if (!d) return [];
  return Array.isArray(d) ? d : Object.keys(d);
}

async function loadPackage(name) {
  const pkg = await locatePackage(name);
  if (!pkg) throw new PolymerError('file-missing', `Cannot open load file: no package named ${name} on load-path`);
  for (const dep of dependencies(pkg.manifest)) await requireFrom(dep, pkg.dir);
  const exports = await loadFile(pkg.entry);
  if (!featurep(name)) provide(name); // be lenient if the package forgot to provide
  packages.set(name, { ...pkg, exports });
  runHooks('after-package-load-hook', name);
  return exports;
}

async function requireFrom(name, baseDir) {
  if (typeof name !== 'string' || !name) throw new TypeError('require: expected a package name or path');
  if (isRelative(name)) {
    const path = await resolveRelative(name, baseDir);
    if (modules.has(path)) return modules.get(path).exports;
    if (!inFlight.has(path)) inFlight.set(path, loadFile(path).finally(() => inFlight.delete(path)));
    return inFlight.get(path);
  }
  if (packages.has(name)) return packages.get(name).exports;
  if (featurep(name)) return true; // provided by built-in code or another file
  if (!inFlight.has(name)) inFlight.set(name, loadPackage(name).finally(() => inFlight.delete(name)));
  return inFlight.get(name);
}

/** require() for code outside a module (init.js gets its own; this resolves against the config directory). */
export function require(name) {
  return requireFrom(name, configDirectory() ?? '/');
}

/** Force a package to load again (after editing it). */
export async function reloadPackage(name) {
  packages.delete(name);
  return loadPackage(name);
}

/**
 * use-package style loading:
 *   await usePackage('name', { init() {}, config(exports) {}, disabled: false })
 * init runs before loading, config after. Errors are reported, not thrown, so one broken
 * package doesn't stop the rest of init.js.
 */
export async function usePackage(name, { init, config, disabled = false } = {}) {
  if (disabled) return null;
  try {
    if (init) await init();
    const exports = await require(name);
    if (config) await config(exports);
    return exports;
  } catch (e) {
    const err = new PolymerError('load-error', `Error in package ${name}: ${e?.message ?? e}`, e);
    runHooks('package-error-hook', name, err);
    message('%s', err.message);
    console.error(e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Listing

/** Packages available on load-path: [{ name, dir, description, version, loaded }]. */
export async function listPackages() {
  const out = [];
  const seen = new Set();
  for (const base of getVarOr('load-path', [], null)) {
    const dir = asDirectory(expandFileName(base));
    let entries;
    try { entries = await listDirectory(dir); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      let name;
      let manifest = {};
      if (e.isDir) {
        name = e.name;
        try { manifest = await readManifest(asDirectory(dir + e.name)); } catch { manifest = {}; }
      } else if (e.name.endsWith('.js')) {
        name = e.name.slice(0, -3);
      } else continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({
        name,
        dir: e.isDir ? asDirectory(dir + e.name) : dir,
        description: manifest.description ?? '',
        version: manifest.version ?? '',
        loaded: packages.has(name),
      });
    }
  }
  return out;
}

export const loadedPackages = () => [...packages.values()];
