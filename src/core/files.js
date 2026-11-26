// Files: paths, file system access, and visiting files in buffers.
//
// Paths use forward slashes on every platform ("C:/Users/me/x.txt" on Windows).

import { defvar, getVarOr, setLocal, runHooks, runHooksAsync, setq } from './registry.js';
import { invoke, appInfo, isTauri } from './host.js';
import {
  getBufferCreate, findBufferVisiting, generateNewBufferName, renameBuffer, currentBuffer,
} from './buffer.js';
import { setMajorMode } from './modes.js';
import { PolymerError } from './errors.js';
import { message } from './echo.js';

defvar('default-directory', null, { doc: 'Directory for relative file names in this buffer (ends with "/").', local: true });
defvar('auto-mode-alist', [], { doc: 'List of [regexp, mode] pairs choosing the major mode from a file name.' });
defvar('recentf-list', [], { doc: 'Recently visited files, most recent first.' });
defvar('recentf-max-saved-items', 200, { doc: 'Maximum length of recentf-list.' });
defvar('require-final-newline', true, { doc: 'Add a newline at the end of the file when saving, if missing.' });

let home = null;
let cwd = null;

/** Load home/cwd from the backend. Called once at startup. */
export async function initFiles() {
  const info = await appInfo();
  home = info.homeDir ? normalizePath(info.homeDir) : null;
  cwd = info.cwd ? normalizePath(info.cwd) : home;
  setq('default-directory', asDirectory(cwd ?? '/'), null);
}

export const homeDirectory = () => home;

// ---------------------------------------------------------------------------
// Paths

export function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

const isWindowsDrive = (p) => /^[A-Za-z]:\//.test(p);
export const isAbsolute = (p) => p.startsWith('/') || isWindowsDrive(p) || p.startsWith('~');

export function asDirectory(p) { return p.endsWith('/') ? p : `${p}/`; }
export function stripSlash(p) { return p.length > 1 && p.endsWith('/') && !/^[A-Za-z]:\/$/.test(p) ? p.slice(0, -1) : p; }

export function basename(p) {
  const s = stripSlash(normalizePath(p));
  return s.slice(s.lastIndexOf('/') + 1);
}

/** Directory part including the trailing slash: "/a/b/c.txt" -> "/a/b/". */
export function dirname(p) {
  const s = normalizePath(p);
  const i = s.lastIndexOf('/');
  return i < 0 ? '' : s.slice(0, i + 1);
}

export function extension(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1) : '';
}

/**
 * Make `name` absolute relative to `dir` (default: the current buffer's
 * default-directory), expanding "~" and resolving "." and "..".
 */
export function expandFileName(name, dir) {
  let p = normalizePath(name);
  // "foo//bar" or "foo/~/bar" restarts the path, like Emacs's substitute-in-file-name.
  const restart = Math.max(p.lastIndexOf('//'), p.lastIndexOf('/~/'));
  if (restart > 0) p = p.slice(restart + 1);
  if (p === '~' || p.startsWith('~/')) p = (home ?? '') + p.slice(1);
  if (!isAbsolute(p)) {
    const base = dir ?? getVarOr('default-directory', null) ?? asDirectory(cwd ?? '/');
    p = asDirectory(normalizePath(base)) + p;
  }
  const drive = isWindowsDrive(p) ? p.slice(0, 2) : '';
  const rest = drive ? p.slice(2) : p;
  const out = [];
  for (const part of rest.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  const trailing = p.endsWith('/') && out.length ? '/' : '';
  return `${drive}/${out.join('/')}${trailing}`;
}

/** Replace the home directory prefix with "~". */
export function abbreviateFileName(p) {
  if (home && (p === home || p.startsWith(asDirectory(home)))) return `~${p.slice(home.length)}`;
  return p;
}

// ---------------------------------------------------------------------------
// File system (Rust)

function requireHost() {
  if (!isTauri) throw new PolymerError('file-error', 'File access requires the Tauri app (not available in a plain browser)');
}

export async function readTextFile(path) { requireHost(); return invoke('read_text_file', { path }); }
export async function writeTextFile(path, text, crlf = false) { requireHost(); return invoke('write_text_file', { path, text, crlf }); }
export async function listDirectory(path) { requireHost(); return invoke('list_directory', { path }); }
export async function pathInfo(path) { requireHost(); return invoke('path_info', { path }); }
export async function makeDirectory(path) { requireHost(); return invoke('make_directory', { path }); }

export async function fileExists(path) { return (await pathInfo(path)).exists; }

// ---------------------------------------------------------------------------
// Modes from file names

/** Major mode for a file name according to auto-mode-alist, or null. */
export function modeForFile(path) {
  const name = basename(path);
  for (const [re, mode] of getVarOr('auto-mode-alist', [], null)) {
    const r = re instanceof RegExp ? re : new RegExp(re);
    if (r.test(name) || r.test(path)) return mode;
  }
  return null;
}

export function setAutoMode(buf) {
  setMajorMode(buf, (buf.file && modeForFile(buf.file)) || 'fundamental-mode');
  setLocal('default-directory', dirname(buf.file), buf);
}

// ---------------------------------------------------------------------------
// File handlers: open some files as something other than text (images, ...)

const fileHandlers = []; // { name, match(path), open(path) -> Promise<Buffer> }

/**
 * Open matching files with `open(path)` instead of reading them as text. Later
 * definitions win.
 *   defineFileHandler('image', { match: (p) => /\.png$/i.test(p), open: (p) => openImage(p) })
 */
export function defineFileHandler(name, { match, open }) {
  const i = fileHandlers.findIndex((h) => h.name === name);
  if (i >= 0) fileHandlers.splice(i, 1);
  fileHandlers.unshift({ name, match, open });
  return name;
}

export const fileHandlerFor = (path) => fileHandlers.find((h) => h.match(path)) ?? null;

// ---------------------------------------------------------------------------
// Visiting files

function recordRecent(path) {
  const list = getVarOr('recentf-list', [], null).filter((p) => p !== path);
  list.unshift(path);
  setq('recentf-list', list.slice(0, getVarOr('recentf-max-saved-items', 200, null)), null);
}

/** Read `path` into a buffer (reusing one already visiting it). Returns the buffer. */
export async function findFileNoselect(path) {
  path = expandFileName(path);
  const existing = findBufferVisiting(path);
  if (existing) return existing;
  const info = await pathInfo(path);
  if (info.isDir) throw new PolymerError('file-error', `${abbreviateFileName(path)} is a directory`);
  const handler = info.exists && fileHandlerFor(path);
  if (handler) {
    const hb = await handler.open(path);
    recordRecent(path);
    runHooks('find-file-hook', hb);
    return hb;
  }
  const buf = getBufferCreate(generateNewBufferName(basename(path)));
  buf.file = path;
  if (info.exists) {
    const contents = await readTextFile(path);
    buf.setText(contents.text);
    buf.fileInfo = { crlf: contents.crlf, mtimeMs: contents.mtimeMs };
  } else {
    buf.fileInfo = { crlf: false, mtimeMs: null };
    message('(New file)');
  }
  buf.modified = false;
  buf.point.set(0);
  setAutoMode(buf);
  recordRecent(path);
  runHooks('find-file-hook', buf);
  return buf;
}

/** Save `buf` to its file. Options: { force } skips the changed-on-disk check. */
export async function saveBuffer(buf = currentBuffer(), { confirm } = {}) {
  if (!buf.file) throw new PolymerError('error', `Buffer ${buf.name} is not visiting a file`);
  if (!buf.modified && buf.fileInfo?.mtimeMs) {
    message('(No changes need to be saved)');
    return false;
  }
  const info = await pathInfo(buf.file);
  if (info.exists && buf.fileInfo?.mtimeMs && info.mtimeMs && info.mtimeMs > buf.fileInfo.mtimeMs + 1) {
    if (!confirm || !(await confirm(`${basename(buf.file)} has changed since visited; save anyway?`))) {
      message('Save cancelled');
      return false;
    }
  }
  await runHooksAsync('before-save-hook', buf);
  let text = buf.getText();
  if (getVarOr('require-final-newline', true, buf) && text.length && !text.endsWith('\n')) {
    buf.insertText(buf.length, '\n', { inhibitReadOnly: true });
    text += '\n';
  }
  const mtime = await writeTextFile(buf.file, text, !!buf.fileInfo?.crlf);
  buf.fileInfo = { ...(buf.fileInfo ?? {}), mtimeMs: mtime };
  buf.modified = false;
  buf.touch();
  recordRecent(buf.file);
  message('Wrote %s', abbreviateFileName(buf.file));
  await runHooksAsync('after-save-hook', buf);
  return true;
}

/** Make `buf` visit `path` (renaming it) and save it there. */
export async function writeFile(buf, path, opts) {
  path = expandFileName(path);
  const info = await pathInfo(path);
  if (info.isDir) path = asDirectory(path) + basename(buf.file ?? buf.name);
  const wasFundamental = buf.mode === 'fundamental-mode';
  buf.file = path;
  buf.fileInfo = { crlf: buf.fileInfo?.crlf ?? false, mtimeMs: null };
  const name = basename(path);
  if (buf.name !== name) renameBuffer(buf, generateNewBufferName(name));
  if (wasFundamental) setAutoMode(buf);
  else setLocal('default-directory', dirname(path), buf);
  buf.modified = true;
  return saveBuffer(buf, opts);
}

/** Re-read the file, discarding changes. Keeps point on the same line where possible. */
export async function revertBuffer(buf = currentBuffer()) {
  if (!buf.file) throw new PolymerError('error', `Buffer ${buf.name} is not visiting a file`);
  if (buf.revertFunction) return buf.revertFunction(buf); // non-text buffers (images) reload themselves
  const { line, col } = buf.posAt(buf.point.pos);
  const contents = await readTextFile(buf.file);
  buf.setText(contents.text);
  buf.fileInfo = { crlf: contents.crlf, mtimeMs: contents.mtimeMs };
  buf.modified = false;
  buf.point.set(buf.offsetAt(line, col));
  runHooks('after-revert-hook', buf);
  message('Reverted %s', basename(buf.file));
}
