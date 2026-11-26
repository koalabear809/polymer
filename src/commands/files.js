// File commands: find-file (helm-find-files style), save, write, revert, recent files.

import { defcommand, getVarOr, call } from '../core/registry.js';
import { defineKey } from '../core/keymap.js';
import { helm, helmSession, yesOrNo } from '../core/helm/helm.js';
import { compileQuery, matchLabel } from '../core/helm/match.js';
import { currentBuffer } from '../core/buffer.js';
import { selectedWindow, setWindowBuffer, displayBuffer, selectWindow } from '../core/window.js';
import { message } from '../core/echo.js';
import { PolymerError } from '../core/errors.js';
import {
  expandFileName, abbreviateFileName, asDirectory, stripSlash, dirname,
  listDirectory, findFileNoselect, saveBuffer, writeFile, revertBuffer, pathInfo,
} from '../core/files.js';

function humanSize(n) {
  if (n < 1024) return `${n}B`;
  const units = ['K', 'M', 'G', 'T'];
  let v = n;
  let i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}${units[i]}`;
}

/** Split typed input into the directory part (as typed) and the pattern after it. */
function splitInput(q) {
  if (q.endsWith('/')) return { dirPart: q, pattern: '' };
  const d = dirname(q);
  return { dirPart: d, pattern: q.slice(d.length) };
}

function currentDirectoryInput() {
  return abbreviateFileName(asDirectory(getVarOr('default-directory', '/')));
}

/**
 * Read a file name with a helm-find-files style interface.
 *   actions     { name: (path) => ... } for existing files/directories
 *   newActions  { name: (path) => ... } for a path that doesn't exist yet
 */
export function helmFindFiles({ prompt = 'Find file: ', initial, actions, newActions }) {
  const cache = new Map();
  const list = (dir) => {
    if (!cache.has(dir)) cache.set(dir, listDirectory(dir).catch(() => null));
    return cache.get(dir);
  };

  async function entriesFor(query) {
    const { dirPart, pattern } = splitInput(query);
    if (!dirPart) return { dir: null, pattern, entries: [] };
    const dir = asDirectory(expandFileName(dirPart));
    return { dir, pattern, entries: (await list(dir)) ?? [] };
  }

  return helm({
    prompt,
    initial: initial ?? currentDirectoryInput(),
    keymap: 'helm-find-files-map',
    history: 'file-name-history',
    sources: [
      {
        name: 'Find files',
        volatile: true,
        match: false,
        delay: 0,
        async candidates({ query }) {
          const { dir, pattern, entries } = await entriesFor(query);
          if (!dir) return [];
          let items = entries.map((e) => ({ e, label: e.name + (e.isDir ? '/' : '') }));
          if (!pattern.startsWith('.')) {
            // Dotfiles last unless the pattern asks for them.
            items = [...items.filter((i) => !i.e.name.startsWith('.')), ...items.filter((i) => i.e.name.startsWith('.'))];
          }
          let matched;
          if (!pattern) {
            matched = items.map((i) => ({ ...i, positions: [] }));
          } else {
            const compiled = compileQuery(pattern);
            matched = items
              .map((i) => {
                const m = matchLabel(compiled, i.label);
                return m && { ...i, score: m.score + (i.e.name === pattern ? 1000 : 0), positions: m.positions };
              })
              .filter(Boolean)
              .sort((a, b) => b.score - a.score);
          }
          return matched.map((i) => ({
            label: i.label,
            value: dir + i.e.name + (i.e.isDir ? '/' : ''),
            isDir: i.e.isDir,
            positions: i.positions,
            annotation: i.e.isDir ? '' : humanSize(i.e.size),
          }));
        },
        actions,
      },
      {
        name: 'New file',
        volatile: true,
        match: false,
        delay: 0,
        async candidates({ query }) {
          const { dir, pattern, entries } = await entriesFor(query);
          if (!dir || !pattern || entries.some((e) => e.name === pattern)) return [];
          return [{ label: `[+] ${abbreviateFileName(dir + pattern)}`, value: dir + pattern, isNew: true }];
        },
        actions: newActions ?? actions,
      },
    ],
  });
}

/** Read a file name; resolves with the absolute path. */
export function readFileName(prompt, opts = {}) {
  const pick = (p) => p;
  return helmFindFiles({ prompt, initial: opts.initial, actions: { Select: pick }, newActions: { Select: pick } });
}

export async function openFile(path, { otherWindow = false } = {}) {
  // A directory opens as a listing.
  if ((await pathInfo(expandFileName(path))).isDir) {
    const { dired } = await import('./dired.js');
    if (otherWindow) {
      const b = await dired(path, { display: false });
      displayBuffer(b, { otherWindow: true });
      return b;
    }
    return dired(path);
  }
  const buf = await findFileNoselect(path);
  if (otherWindow) displayBuffer(buf, { otherWindow: true });
  else {
    setWindowBuffer(selectedWindow(), buf);
    selectWindow(selectedWindow());
  }
  return buf;
}

async function copyPath(path) {
  await navigator.clipboard.writeText(path);
  message('Copied %s', path);
}

defcommand('find-file', { doc: 'Visit a file, choosing it with helm. RET on a directory enters it; DEL at a "/" or C-l goes up. The "Open" action on a directory shows it in dired.' }, () => helmFindFiles({
  actions: {
    'Find file': (p) => openFile(p),
    'Open directory in dired': async (p) => {
      const { dired } = await import('./dired.js');
      return dired(p.endsWith('/') ? p : dirname(p), { focus: p.endsWith('/') ? undefined : p.slice(dirname(p).length) });
    },
    'Find file other window': (p) => openFile(p, { otherWindow: true }),
    'Copy path': copyPath,
  },
  newActions: {
    'Create file': (p) => openFile(p),
    'Create file other window': (p) => openFile(p, { otherWindow: true }),
  },
}));

defcommand('find-file-other-window', { doc: 'Visit a file in another window.' }, () => helmFindFiles({
  actions: { 'Find file other window': (p) => openFile(p, { otherWindow: true }) },
}));

defcommand('save-buffer', { doc: 'Save the current buffer to its file (asks for a name if it has none).' }, async () => {
  const b = currentBuffer();
  if (!b.file) return call('write-file');
  return saveBuffer(b, { confirm: yesOrNo });
});

defcommand('write-file', {
  doc: 'Write the current buffer to a file chosen with helm, and visit that file.',
  interactive: async () => [await readFileName('Write file: ')],
}, (path) => writeFile(currentBuffer(), path, { confirm: yesOrNo }));

defcommand('revert-buffer', { doc: 'Re-read the current buffer from its file, discarding changes.' }, async () => {
  const b = currentBuffer();
  if (!b.file) throw new PolymerError('user-error', 'Buffer is not visiting a file');
  if (b.modified && !(await yesOrNo(`Discard changes and revert ${b.name}?`))) return;
  return revertBuffer(b);
});

defcommand('recentf-open-files', { doc: 'Open a recently visited file.' }, () => helm({
  prompt: 'Recent file: ',
  sources: [{
    name: 'Recent files',
    candidates: getVarOr('recentf-list', [], null).map((p) => ({ label: abbreviateFileName(p), value: p })),
    actions: {
      'Find file': (p) => openFile(p),
      'Find file other window': (p) => openFile(p, { otherWindow: true }),
      'Copy path': copyPath,
    },
  }],
}));

defcommand('copy-file-path', { doc: 'Copy the current buffer\'s file path to the clipboard.' }, () => {
  const b = currentBuffer();
  if (!b.file) throw new PolymerError('user-error', 'Buffer is not visiting a file');
  return copyPath(b.file);
});

// ---------------------------------------------------------------------------
// helm-find-files keys

function ffSession() {
  const s = helmSession();
  if (!s) throw new PolymerError('error', 'No active helm session');
  return s;
}

defcommand('helm-ff-maybe-exit', { doc: 'In find-file: enter a directory, or run the default action on a file.' }, () => {
  const s = ffSession();
  const sel = s.selected();
  if (!s.actionMode && sel?.cand.data?.isDir) return s.setInput(abbreviateFileName(sel.cand.value));
  return call('helm-maybe-exit');
});

defcommand('helm-ff-persistent', { doc: 'In find-file: enter a directory (C-z on a file previews it).' }, () => {
  const s = ffSession();
  const sel = s.selected();
  if (sel?.cand.data?.isDir) return s.setInput(abbreviateFileName(sel.cand.value));
  return call('helm-execute-persistent-action');
});

defcommand('helm-find-files-up-one-level', { doc: 'In find-file: go to the parent directory.' }, () => {
  const s = ffSession();
  const q = s.input;
  const { dirPart } = splitInput(q);
  const base = q.endsWith('/') ? stripSlash(q) : stripSlash(dirPart);
  const parent = dirname(base);
  s.setInput(parent || '/');
});

defcommand('helm-ff-delete-char-backward', { doc: 'In find-file: delete a character, or go up a directory at a "/".' }, () => {
  const s = ffSession();
  const q = s.input;
  if (q.endsWith('/') && q.length > 1 && q !== '~/') return call('helm-find-files-up-one-level');
  s.setInput(q.slice(0, -1));
});

defineKey({ keymaps: 'helm-find-files-map' }, {
  'RET': 'helm-ff-maybe-exit',
  'C-z': 'helm-ff-persistent',
  'C-l': 'helm-find-files-up-one-level',
});

defineKey({ keymaps: 'helm-find-files-map', states: 'insert' }, {
  'DEL': 'helm-ff-delete-char-backward',
});

