// Dired: a buffer listing a directory.
//
// The listing is plain text, so every vim motion and search works as usual. Dired's keys
// avoid motion keys: RET opens (a file replaces the listing in this window; a directory
// moves the listing there), DEL goes up a directory, m/u/U mark, d flags for deletion and
// x deletes flagged, D deletes, R renames/moves, C copies, o / O create a file /
// directory, g r refreshes, g h toggles hidden files. With a visual selection (V), m, u,
// d, D, R and C act on every selected entry.

import { defcommand, defvar, getVarOr, addHook } from '../core/registry.js';
import { defineMajorMode, setMajorMode } from '../core/modes.js';
import { defineKey } from '../core/keymap.js';
import { getBufferCreate, currentBuffer, bufferList, generateNewBufferName, renameBuffer, findBufferVisiting } from '../core/buffer.js';
import { selectedWindow, setWindowBuffer } from '../core/window.js';
import { readString, yesOrNo } from '../core/helm/helm.js';
import { message } from '../core/echo.js';
import { PolymerError } from '../core/errors.js';
import { invoke } from '../core/host.js';
import {
  listDirectory, abbreviateFileName, asDirectory, stripSlash, dirname, basename, expandFileName,
  makeDirectory, writeTextFile, pathInfo,
} from '../core/files.js';

defvar('dired-show-hidden', true, { doc: 'Show files whose names start with "." in dired.' });

const userError = (msg) => new PolymerError('user-error', msg);

defineMajorMode('dired-mode', {
  parent: 'special-mode',
  lighter: 'Dired',
  doc: 'A directory listing. RET open, DEL up a directory, m/u/U mark, d flag and x delete, D delete, R rename, C copy, o/O new file/directory, g r refresh, g h hidden files. Vim motions work as usual; with a visual selection the commands act on every selected entry.',
});

// ---------------------------------------------------------------------------
// Rendering

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatSize(n, isDir) {
  if (isDir) return '-';
  if (n < 1024) return `${n}`;
  const units = ['K', 'M', 'G', 'T'];
  let v = n;
  let i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}${units[i]}`;
}

function formatDate(ms) {
  if (!ms) return ''.padEnd(12);
  const d = new Date(ms);
  const recent = Date.now() - ms < 1000 * 60 * 60 * 24 * 180;
  const day = String(d.getDate()).padStart(2);
  const tail = recent ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : ` ${d.getFullYear()}`;
  return `${MONTHS[d.getMonth()]} ${day} ${tail}`;
}

async function readDir(b) {
  const d = b.dired;
  let entries = await listDirectory(d.dir);
  if (!getVarOr('dired-show-hidden', true, b)) entries = entries.filter((e) => !e.name.startsWith('.'));
  d.entries = entries; // already sorted: directories first, then by name
}

function render(b) {
  const d = b.dired;
  const header = abbreviateFileName(d.dir);
  const lines = [header];
  const decos = [[{ from: 0, to: header.length, face: 'dired-header' }]];
  const sizes = d.entries.map((e) => formatSize(e.size, e.isDir));
  const sizeWidth = Math.max(1, ...sizes.map((s) => s.length));
  d.entries.forEach((e, i) => {
    const mark = d.marks.get(e.name) ?? ' ';
    const prefix = `${mark} ${sizes[i].padStart(sizeWidth)}  ${formatDate(e.mtimeMs)}  `;
    const name = `${e.name}${e.isDir ? '/' : ''}${e.isSymlink ? ' @' : ''}`;
    lines.push(prefix + name);
    const face = e.isDir ? 'dired-directory' : e.name.startsWith('.') ? 'dired-hidden' : 'dired-file';
    decos.push([
      { from: 0, to: 1, face: mark === 'D' ? 'dired-flagged' : 'dired-marked' },
      { from: 2, to: prefix.length, face: 'dired-dim' },
      { from: prefix.length, to: prefix.length + name.length, face: mark === 'D' ? 'dired-flagged' : mark === '*' ? 'dired-marked' : face },
    ]);
    d.nameCol = prefix.length; // same for every line
  });
  if (!d.entries.length) {
    lines.push('  (empty)');
    decos.push([{ from: 0, to: 9, face: 'dired-dim' }]);
  }
  d.lineDecos = decos;
  const keep = b.lineAt();
  b.setText(lines.join('\n'));
  return keep;
}

/** Put the cursor on an entry's name (by name), or on line `fallback`. */
function gotoEntry(b, name, fallback = 1) {
  const i = name ? b.dired.entries.findIndex((e) => e.name === name) : -1;
  const line = i >= 0 ? i + 1 : Math.max(1, Math.min(fallback, b.lineCount - 1));
  b.point.set(b.offsetAt(line, b.dired.nameCol ?? 0));
}

async function refresh(b, { focus } = {}) {
  const prevEntry = entryAtLine(b, b.lineAt())?.name;
  await readDir(b);
  // Forget marks on entries that are gone.
  for (const k of [...b.dired.marks.keys()]) if (!b.dired.entries.some((e) => e.name === k)) b.dired.marks.delete(k);
  const line = render(b);
  gotoEntry(b, focus ?? prevEntry, line);
}

// ---------------------------------------------------------------------------
// Opening

function bufferName(dir) {
  return `${basename(stripSlash(dir)) || dir}/`;
}

/**
 * Show a directory listing. Reuses `buffer` (moving it to the new directory) when given,
 * else a dired buffer already showing `dir`, else a new one. `focus`: entry to put the
 * cursor on.
 */
export async function dired(dir, { buffer, focus, display = true } = {}) {
  dir = asDirectory(expandFileName(dir));
  const info = await pathInfo(dir);
  if (!info.isDir) throw userError(`Not a directory: ${abbreviateFileName(dir)}`);
  let b = buffer ?? bufferList({ all: true }).find((x) => x.dired?.dir === dir);
  if (!b) {
    b = getBufferCreate(generateNewBufferName(bufferName(dir)));
    setMajorMode(b, 'dired-mode');
    b.undoEnabled = false;
    b.decorators.push((buf, line) => buf.dired?.lineDecos?.[line] ?? []);
  }
  if (b.dired?.dir !== dir) {
    b.dired = { dir, entries: [], marks: new Map(), lineDecos: [], nameCol: 0 };
    const name = bufferName(dir);
    if (b.name !== name) renameBuffer(b, generateNewBufferName(name));
  }
  b.locals.set('default-directory', dir);
  b.locals.set('display-line-numbers', false);
  await refresh(b, { focus });
  if (display) setWindowBuffer(selectedWindow(), b);
  return b;
}

function requireDired() {
  const b = currentBuffer();
  if (!b.dired) throw userError('Not a dired buffer');
  return b;
}

const entryAtLine = (b, line) => (line >= 1 ? b.dired?.entries[line - 1] ?? null : null);
const pathOf = (b, e) => b.dired.dir + e.name;

/** Entries a command acts on: the visual selection, else the marked ones, else the one at point. */
async function targets(b, { marked = true } = {}) {
  if (b.state === 'visual' && b.vim?.visual) {
    const { visualRange, exitVisual } = await import('../vim/core.js');
    const r = visualRange(b);
    exitVisual(b);
    const l1 = b.lineAt(r.from);
    const l2 = b.lineAt(Math.max(r.from, r.to - 1));
    const out = [];
    for (let l = l1; l <= l2; l++) { const e = entryAtLine(b, l); if (e) out.push(e); }
    return out;
  }
  if (marked) {
    const m = b.dired.entries.filter((e) => b.dired.marks.get(e.name) === '*');
    if (m.length) return m;
  }
  const e = entryAtLine(b, b.lineAt());
  return e ? [e] : [];
}

defcommand('dired', {
  doc: 'Open a directory listing (default: this buffer\'s directory).',
  interactive: async () => {
    const { readFileName } = await import('./files.js');
    return [await readFileName('Dired: ')];
  },
}, (dir) => dired(dir ?? getVarOr('default-directory', '/')));

defcommand('dired-jump', { doc: 'Open the directory of the current file, with the cursor on that file (SPC f d).' }, () => {
  const b = currentBuffer();
  if (b.dired) return dired(dirname(stripSlash(b.dired.dir)) || '/', { buffer: b, focus: basename(stripSlash(b.dired.dir)) });
  if (b.file) return dired(dirname(b.file), { focus: basename(b.file) });
  return dired(getVarOr('default-directory', '/'));
});

defcommand('dired-find-file', { doc: 'Open the entry at point: a file replaces the listing in this window; a directory moves the listing into it (RET).' }, async () => {
  const b = requireDired();
  const e = entryAtLine(b, b.lineAt());
  if (!e) return;
  if (e.isDir) return dired(pathOf(b, e), { buffer: b });
  const { openFile } = await import('./files.js');
  return openFile(pathOf(b, e));
});

defcommand('dired-up-directory', { doc: 'Go to the parent directory, with the cursor on the one you came from (DEL).' }, () => {
  const b = requireDired();
  const here = stripSlash(b.dired.dir);
  const parent = dirname(here);
  if (!parent || parent === b.dired.dir) return message('At the root');
  return dired(parent, { buffer: b, focus: basename(here) });
});

defcommand('dired-refresh', { doc: 'Re-read the directory (g r).' }, () => refresh(requireDired()));

defcommand('dired-toggle-hidden', { doc: 'Show or hide dotfiles (g h).' }, () => {
  const b = requireDired();
  b.locals.set('dired-show-hidden', !getVarOr('dired-show-hidden', true, b));
  return refresh(b);
});

// ---------------------------------------------------------------------------
// Marks

async function setMark(char, { advance = true } = {}) {
  const b = requireDired();
  const visual = b.state === 'visual';
  const list = await targets(b, { marked: false });
  for (const e of list) {
    if (char === ' ') b.dired.marks.delete(e.name);
    else b.dired.marks.set(e.name, char);
  }
  const line = b.lineAt();
  render(b);
  b.point.set(b.offsetAt(Math.min(b.lineCount - 1, advance && !visual ? line + 1 : line), b.dired.nameCol));
}

defcommand('dired-mark', { doc: 'Mark the entry at point (or the selection) and move down (m).' }, () => setMark('*'));
defcommand('dired-unmark', { doc: 'Unmark the entry at point (or the selection) and move down (u).' }, () => setMark(' '));
defcommand('dired-flag-delete', { doc: 'Flag the entry at point (or the selection) for deletion and move down (d).' }, () => setMark('D'));
defcommand('dired-unmark-all', { doc: 'Remove all marks and flags (U).' }, () => {
  const b = requireDired();
  b.dired.marks.clear();
  const line = b.lineAt();
  render(b);
  b.point.set(b.offsetAt(line, b.dired.nameCol));
});

// ---------------------------------------------------------------------------
// File operations

async function deleteEntries(b, list) {
  if (!list.length) return message('Nothing to delete');
  const names = list.map((e) => e.name + (e.isDir ? '/' : ''));
  const what = names.length === 1 ? names[0] : `${names.length} entries (${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''})`;
  const dirs = list.some((e) => e.isDir);
  if (!(await yesOrNo(`Delete ${what}${dirs ? ' and everything inside' : ''}?`))) return;
  for (const e of list) {
    await invoke('delete_path', { path: pathOf(b, e), recursive: e.isDir });
    b.dired.marks.delete(e.name);
    // Buffers visiting deleted files keep their text but are no longer on disk.
    const fb = findBufferVisiting(pathOf(b, e));
    if (fb) fb.fileInfo = { ...(fb.fileInfo ?? {}), mtimeMs: null };
  }
  await refresh(b);
  message('Deleted %s', what);
}

defcommand('dired-do-delete', { doc: 'Delete the selection, the marked entries, or the entry at point (D). Asks first.' }, async () => {
  const b = requireDired();
  return deleteEntries(b, await targets(b));
});

defcommand('dired-do-flagged-delete', { doc: 'Delete the entries flagged with d (x). Asks first.' }, () => {
  const b = requireDired();
  return deleteEntries(b, b.dired.entries.filter((e) => b.dired.marks.get(e.name) === 'D'));
});

/** Ask for a destination for one entry (a new name) or several (a directory). */
async function destination(b, list, verb) {
  const one = list.length === 1;
  const initial = abbreviateFileName(one ? pathOf(b, list[0]) : b.dired.dir);
  const answer = (await readString(`${verb} ${one ? list[0].name : `${list.length} entries`} to: `, { initial })).trim();
  if (!answer) return null;
  return expandFileName(answer, b.dired.dir);
}

async function transferEntries(b, list, verb, command) {
  if (!list.length) return message(`Nothing to ${verb.toLowerCase()}`);
  const dest = await destination(b, list, verb);
  if (!dest) return;
  const destInfo = await pathInfo(dest);
  const intoDir = destInfo.isDir || list.length > 1 || dest.endsWith('/');
  if (intoDir && !destInfo.exists) await makeDirectory(dest);
  const moved = [];
  for (const e of list) {
    const to = intoDir ? asDirectory(dest) + e.name : dest;
    await invoke(command, { from: pathOf(b, e), to });
    b.dired.marks.delete(e.name);
    moved.push(to);
    if (command === 'rename_path') {
      // Keep open buffers pointing at the file's new name.
      const fb = findBufferVisiting(pathOf(b, e));
      if (fb) fb.file = to;
    }
  }
  const focus = !intoDir && dirname(dest) === b.dired.dir ? basename(dest) : undefined;
  await refresh(b, { focus });
  message('%s %d entr%s to %s', verb === 'Rename' ? 'Moved' : 'Copied', moved.length, moved.length === 1 ? 'y' : 'ies', abbreviateFileName(intoDir ? asDirectory(dest) : dest));
}

defcommand('dired-do-rename', { doc: 'Rename or move the selection, the marked entries, or the entry at point (R).' }, async () => {
  const b = requireDired();
  return transferEntries(b, await targets(b), 'Rename', 'rename_path');
});

defcommand('dired-do-copy', { doc: 'Copy the selection, the marked entries, or the entry at point (C).' }, async () => {
  const b = requireDired();
  return transferEntries(b, await targets(b), 'Copy', 'copy_path');
});

defcommand('dired-create-file', { doc: 'Create an empty file here and open it (o).' }, async () => {
  const b = requireDired();
  const name = (await readString('New file: ')).trim();
  if (!name) return;
  const path = expandFileName(name, b.dired.dir);
  if ((await pathInfo(path)).exists) throw userError(`${abbreviateFileName(path)} already exists`);
  await makeDirectory(dirname(path));
  await writeTextFile(path, '', false);
  await refresh(b, { focus: basename(path) });
  const { openFile } = await import('./files.js');
  return openFile(path);
});

defcommand('dired-create-directory', { doc: 'Create a directory here (O).' }, async () => {
  const b = requireDired();
  const name = (await readString('New directory: ')).trim();
  if (!name) return;
  const path = expandFileName(name, b.dired.dir);
  if ((await pathInfo(path)).exists) throw userError(`${abbreviateFileName(path)} already exists`);
  await makeDirectory(path);
  await refresh(b, { focus: basename(stripSlash(path)) });
});

// Keep listings current when files are saved into them.
addHook('after-save-hook', function diredRefreshAfterSave(buf) {
  if (!buf.file) return;
  for (const b of bufferList({ all: true })) if (b.dired && dirname(buf.file) === b.dired.dir) refresh(b).catch(() => {});
});

// ---------------------------------------------------------------------------
// Keys: none of these shadow a vim motion.

defineKey({ keymaps: 'dired-mode-map', states: 'normal' }, {
  'RET': 'dired-find-file',
  'DEL': 'dired-up-directory',
  'm': 'dired-mark',
  'u': 'dired-unmark',
  'U': 'dired-unmark-all',
  'd': 'dired-flag-delete',
  'x': 'dired-do-flagged-delete',
  'D': 'dired-do-delete',
  'R': 'dired-do-rename',
  'C': 'dired-do-copy',
  'o': 'dired-create-file',
  'O': 'dired-create-directory',
  'g r': 'dired-refresh',
  'g h': 'dired-toggle-hidden',
});

defineKey({ keymaps: 'dired-mode-map', states: 'visual' }, {
  'm': 'dired-mark',
  'u': 'dired-unmark',
  'd': 'dired-flag-delete',
  'D': 'dired-do-delete',
  'R': 'dired-do-rename',
  'C': 'dired-do-copy',
});

defineKey({ keymaps: 'global', states: ['normal', 'visual'], prefix: 'SPC' }, {
  'f d': 'dired-jump',
  'o -': 'dired-jump',
});
