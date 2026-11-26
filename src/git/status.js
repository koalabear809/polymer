// The git status buffer (magit-status).
//
// The buffer is plain text, so vim motions and search work; each line is tagged with what
// it shows (section, file, hunk, hunk line, commit, stash), and commands act on the thing
// at point.

import { defcommand, defvar, getVarOr, addHook, call, runHooks } from '../core/registry.js';
import { defineMajorMode, setMajorMode } from '../core/modes.js';
import { getBuffer, getBufferCreate, currentBuffer, bufferList } from '../core/buffer.js';
import { selectedWindow, setWindowBuffer, windowList } from '../core/window.js';
import { yesOrNo } from '../core/helm/helm.js';
import { message } from '../core/echo.js';
import { PolymerError } from '../core/errors.js';
import { abbreviateFileName, basename } from '../core/files.js';
import {
  runGit, repoRoot, parseStatus, parseDiff, hunkPatch, hunkLineTarget, STATUS_LABELS,
} from './git.js';

defvar('git-log-count', 10, { doc: 'Recent commits shown in the status buffer.' });
defvar('git-auto-refresh', true, { doc: 'Refresh status buffers after saving a file in their repository.' });

const userError = (msg) => new PolymerError('user-error', msg);

defineMajorMode('git-status-mode', {
  parent: 'special-mode',
  lighter: 'Git',
  doc: 'Git status. TAB toggles; s/u/x stage, unstage, discard; c commit, P push, F pull, f fetch, b branch, l log, z stash; g r refresh; $ process log.',
});

const SECTIONS = [
  ['conflicted', 'Unmerged changes'],
  ['untracked', 'Untracked files'],
  ['unstaged', 'Unstaged changes'],
  ['staged', 'Staged changes'],
];

// ---------------------------------------------------------------------------
// Data

async function collect(root) {
  const [status, log, stash] = await Promise.all([
    runGit(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { cwd: root }),
    runGit(['log', `-n${getVarOr('git-log-count', 10)}`, '--format=%h%x1f%s%x1f%D'], { cwd: root, allowFail: true }),
    runGit(['stash', 'list', '--format=%gd%x1f%s'], { cwd: root, allowFail: true }),
  ]);
  const parsed = parseStatus(status.stdout);
  parsed.commits = log.code === 0 ? log.stdout.split('\n').filter(Boolean).map((l) => {
    const [hash, subject, refs] = l.split('\x1f');
    return { hash, subject, refs };
  }) : [];
  parsed.stashes = stash.code === 0 ? stash.stdout.split('\n').filter(Boolean).map((l) => {
    const [ref, subject] = l.split('\x1f');
    return { ref, subject };
  }) : [];
  return parsed;
}

const fileKey = (section, path) => `${section}:${path}`;

async function fileDiff(b, section, entry) {
  const args = section === 'staged'
    ? ['diff', '--cached', '--no-ext-diff', '-M', '--', entry.path, ...(entry.orig ? [entry.orig] : [])]
    : ['diff', '--no-ext-diff', '--', entry.path];
  if (section === 'untracked') {
    // Show the whole new file as an addition.
    const out = await runGit(['diff', '--no-index', '--no-ext-diff', '--', '/dev/null', entry.path], { cwd: b.git.root, allowFail: true });
    return parseDiff(out.stdout)[0] ?? null;
  }
  const out = await runGit(args, { cwd: b.git.root });
  return parseDiff(out.stdout)[0] ?? null;
}

// ---------------------------------------------------------------------------
// Rendering

function render(b) {
  const g = b.git;
  const s = g.status;
  const lines = [];
  const info = [];
  const decos = [];
  const push = (text, item, deco = []) => {
    lines.push(text);
    info.push(item);
    decos.push(deco);
  };

  const head = s.branch.head === '(detached)' ? `(detached at ${s.branch.oid?.slice(0, 7)})` : s.branch.head ?? '?';
  const last = s.commits[0];
  push(`Head:     ${head}  ${last ? last.subject : '(no commits yet)'}`, { kind: 'head' }, [{ from: 10, to: 10 + head.length, face: 'git-branch' }]);
  if (s.branch.upstream) {
    const ab = [s.branch.ahead && `ahead ${s.branch.ahead}`, s.branch.behind && `behind ${s.branch.behind}`].filter(Boolean).join(', ');
    push(`Push:     ${s.branch.upstream}${ab ? `  (${ab})` : ''}`, { kind: 'head' }, [{ from: 10, to: 10 + s.branch.upstream.length, face: 'git-remote' }]);
  } else {
    push('Push:     (no upstream)', { kind: 'head' }, [{ from: 10, to: 23, face: 'git-dim' }]);
  }

  for (const [key, title] of SECTIONS) {
    const files = s[key];
    if (!files.length) continue;
    push('', { kind: 'blank' });
    const collapsed = g.collapsed.has(key);
    const heading = `${title} (${files.length})`;
    push(heading, { kind: 'section', section: key }, [{ from: 0, to: heading.length, face: 'git-section' }]);
    if (collapsed) continue;
    for (const f of files) {
      const label = key === 'untracked' ? '' : `${(STATUS_LABELS[f.status] ?? f.status).padEnd(11)}`;
      const name = f.orig ? `${f.orig} -> ${f.path}` : f.path;
      const k = fileKey(key, f.path);
      const expanded = g.expanded.has(k);
      push(`${label}${name}`, { kind: 'file', section: key, file: f }, [
        ...(label ? [{ from: 0, to: label.length, face: `git-file-status git-status-${f.status}` }] : []),
        { from: label.length, to: label.length + name.length, face: 'git-file' },
      ]);
      const diff = expanded ? g.diffs.get(k) : null;
      if (!diff) continue;
      if (diff.binary) push('  Binary file', { kind: 'file', section: key, file: f }, [{ from: 0, to: 13, face: 'git-dim' }]);
      diff.hunks.forEach((h, hi) => {
        push(h.header, { kind: 'hunk', section: key, file: f, diff, hunk: h, hunkIndex: hi }, [{ lineFace: 'git-hunk-header' }]);
        h.lines.forEach((l, li) => {
          const face = l[0] === '+' ? 'git-diff-add' : l[0] === '-' ? 'git-diff-del' : null;
          push(l, { kind: 'hunk-line', section: key, file: f, diff, hunk: h, hunkIndex: hi, lineIndex: li }, face ? [{ lineFace: face }] : []);
        });
      });
    }
  }

  if (s.stashes.length) {
    push('', { kind: 'blank' });
    const heading = `Stashes (${s.stashes.length})`;
    push(heading, { kind: 'section', section: 'stashes' }, [{ from: 0, to: heading.length, face: 'git-section' }]);
    if (!g.collapsed.has('stashes')) {
      for (const st of s.stashes) {
        push(`${st.ref} ${st.subject}`, { kind: 'stash', stash: st }, [{ from: 0, to: st.ref.length, face: 'git-hash' }]);
      }
    }
  }

  if (s.commits.length) {
    push('', { kind: 'blank' });
    const heading = 'Recent commits';
    push(heading, { kind: 'section', section: 'commits' }, [{ from: 0, to: heading.length, face: 'git-section' }]);
    if (!g.collapsed.has('commits')) {
      for (const c of s.commits) {
        const refs = c.refs ? `(${c.refs}) ` : '';
        push(`${c.hash} ${refs}${c.subject}`, { kind: 'commit', hash: c.hash }, [
          { from: 0, to: c.hash.length, face: 'git-hash' },
          ...(refs ? [{ from: c.hash.length + 1, to: c.hash.length + 1 + refs.length, face: 'git-refs' }] : []),
        ]);
      }
    }
  }

  if (!s.untracked.length && !s.unstaged.length && !s.staged.length && !s.conflicted.length) {
    lines.splice(2, 0, '', 'Nothing to commit, working tree clean.');
    info.splice(2, 0, { kind: 'blank' }, { kind: 'blank' });
    decos.splice(2, 0, [], [{ from: 0, to: 38, face: 'git-dim' }]);
  }

  // Keep point on the same thing if it still exists.
  const prev = g.info?.[b.lineAt()];
  const prevLine = b.lineAt();
  g.info = info;
  g.lineDecos = decos;
  b.setText(lines.join('\n'));
  const same = (a, x) => a && x && a.kind === x.kind && a.section === x.section && a.file?.path === x.file?.path
    && a.hunkIndex === x.hunkIndex && a.lineIndex === x.lineIndex && a.hash === x.hash && a.stash?.ref === x.stash?.ref;
  let target = prev ? info.findIndex((x) => same(prev, x)) : -1;
  if (target < 0 && prev?.file) target = info.findIndex((x) => x.kind === 'file' && x.file.path === prev.file.path);
  if (target < 0 && prev?.section) target = info.findIndex((x) => x.kind === 'section' && x.section === prev.section);
  if (target < 0) target = Math.min(prevLine, lines.length - 1);
  b.point.set(b.lineStart(target));
}

/** Re-read the repository and redraw. */
export async function refreshStatus(b) {
  const g = b.git;
  if (g.refreshing) { g.again = true; return; }
  g.refreshing = true;
  try {
    g.status = await collect(g.root);
    // Re-fetch diffs of expanded files; forget files that no longer exist.
    const diffs = new Map();
    for (const k of g.expanded) {
      const [section, ...rest] = k.split(':');
      const path = rest.join(':');
      const entry = g.status[section]?.find((f) => f.path === path);
      if (!entry) { g.expanded.delete(k); continue; }
      const d = await fileDiff(b, section, entry);
      if (d) diffs.set(k, d);
    }
    g.diffs = diffs;
    render(b);
  } finally {
    g.refreshing = false;
    if (g.again) { g.again = false; refreshStatus(b); }
  }
}

/** Refresh every status buffer for a repository (after an operation). */
export async function refreshRepo(root) {
  for (const b of bufferList({ all: true })) if (b.git?.root === root && b.mode === 'git-status-mode') await refreshStatus(b);
  runHooks('git-refresh-hook', root);
}

// ---------------------------------------------------------------------------
// Opening

async function rootFor(dir) {
  const root = await repoRoot(dir);
  if (!root) throw userError(`Not inside a git repository: ${abbreviateFileName(dir)}`);
  return root;
}

export const currentDir = (b = currentBuffer()) => b?.git?.root ?? getVarOr('default-directory', null, b) ?? '/';

/** The status buffer for a repository (created and filled if needed). Not displayed. */
export async function statusBuffer(root) {
  const name = `*git: ${basename(root)}*`;
  let b = bufferList({ all: true }).find((x) => x.mode === 'git-status-mode' && x.git?.root === root);
  if (!b) {
    b = getBufferCreate(getBuffer(name) ? `*git: ${abbreviateFileName(root)}*` : name);
    setMajorMode(b, 'git-status-mode');
    b.git = { root, status: null, info: [], lineDecos: [], expanded: new Set(), collapsed: new Set(['stashes']), diffs: new Map() };
    b.undoEnabled = false;
    b.decorators.push((buf, line) => buf.git?.lineDecos?.[line] ?? []);
    b.locals.set('default-directory', root);
  }
  await refreshStatus(b);
  return b;
}

defcommand('git-status', { doc: 'Show the git status of the repository containing the current buffer (magit-status).' }, async () => {
  const root = await rootFor(currentDir());
  const b = await statusBuffer(root);
  setWindowBuffer(selectedWindow(), b);
  return b;
});

// ---------------------------------------------------------------------------
// Thing at point

export function thingAtPoint(b = currentBuffer()) {
  if (!b.git?.info) return null;
  return b.git.info[b.lineAt()] ?? null;
}

function requireStatus() {
  const b = currentBuffer();
  if (b.mode !== 'git-status-mode') throw userError('Not a git status buffer');
  return b;
}

defcommand('git-toggle-section', { doc: 'Expand or collapse the section, file or hunk at point (TAB).' }, async () => {
  const b = requireStatus();
  const t = thingAtPoint(b);
  if (!t) return;
  const g = b.git;
  if (t.kind === 'section') {
    if (g.collapsed.has(t.section)) g.collapsed.delete(t.section);
    else g.collapsed.add(t.section);
    render(b);
  } else if (t.kind === 'file' || t.kind === 'hunk' || t.kind === 'hunk-line') {
    const k = fileKey(t.section, t.file.path);
    if (g.expanded.has(k)) {
      g.expanded.delete(k);
      g.diffs.delete(k);
      render(b);
      b.point.set(b.lineStart(g.info.findIndex((x) => x.kind === 'file' && x.section === t.section && x.file.path === t.file.path)));
    } else {
      const d = await fileDiff(b, t.section, t.file);
      if (!d) return message('No diff for %s', t.file.path);
      g.expanded.add(k);
      g.diffs.set(k, d);
      render(b);
    }
  }
});

defcommand('git-refresh', { doc: 'Refresh the status buffer (g r).' }, async () => {
  const b = currentBuffer();
  if (b.mode === 'git-status-mode') await refreshStatus(b);
  else if (b.git?.root) await refreshRepo(b.git.root);
  message('Refreshed');
});

function sectionPaths(b, section) {
  return (b.git.status[section] ?? []).flatMap((f) => [f.path, ...(f.orig ? [f.orig] : [])]);
}

async function applyPatch(root, file, hunk, args) {
  await runGit(['apply', '--recount', ...args, '-'], { cwd: root, stdin: hunkPatch(file, hunk) });
}

defcommand('git-stage', { doc: 'Stage the section, file or hunk at point (s).' }, async () => {
  const b = requireStatus();
  const t = thingAtPoint(b);
  const root = b.git.root;
  if (!t) return;
  if (t.kind === 'section') {
    if (t.section === 'untracked' || t.section === 'conflicted') await runGit(['add', '--', ...sectionPaths(b, t.section)], { cwd: root });
    else if (t.section === 'unstaged') await runGit(['add', '-u'], { cwd: root });
    else return message('Nothing to stage here');
  } else if (t.kind === 'file') {
    if (t.section === 'staged') return message('Already staged');
    await runGit(['add', '-A', '--', t.file.path], { cwd: root });
  } else if (t.kind === 'hunk' || t.kind === 'hunk-line') {
    if (t.section === 'staged') return message('Already staged');
    if (t.section === 'untracked') await runGit(['add', '--', t.file.path], { cwd: root });
    else await applyPatch(root, t.diff, t.hunk, ['--cached']);
  } else return;
  await refreshRepo(root);
});

async function unstagePaths(b, paths) {
  const root = b.git.root;
  // Before the first commit there is no HEAD to reset to.
  if (b.git.status.branch.oid === '(initial)') await runGit(['rm', '--cached', '-r', '-q', '--', ...paths], { cwd: root });
  else await runGit(['reset', '-q', '--', ...paths], { cwd: root });
}

defcommand('git-unstage', { doc: 'Unstage the section, file or hunk at point (u).' }, async () => {
  const b = requireStatus();
  const t = thingAtPoint(b);
  const root = b.git.root;
  if (!t) return;
  if (t.section !== 'staged') return message('Not staged');
  if (t.kind === 'section') await unstagePaths(b, sectionPaths(b, 'staged'));
  else if (t.kind === 'file') await unstagePaths(b, [t.file.path, ...(t.file.orig ? [t.file.orig] : [])]);
  else if (t.kind === 'hunk' || t.kind === 'hunk-line') await applyPatch(root, t.diff, t.hunk, ['--cached', '-R']);
  else return;
  await refreshRepo(root);
});

defcommand('git-stage-all', { doc: 'Stage all changes, including untracked files (S).' }, async () => {
  const b = requireStatus();
  await runGit(['add', '-A'], { cwd: b.git.root });
  await refreshRepo(b.git.root);
});

defcommand('git-unstage-all', { doc: 'Unstage everything (U).' }, async () => {
  const b = requireStatus();
  const paths = sectionPaths(b, 'staged');
  if (!paths.length) return message('Nothing staged');
  await unstagePaths(b, paths);
  await refreshRepo(b.git.root);
});

defcommand('git-discard', { doc: 'Discard the changes at point: a hunk, a file, or a whole section (x). Asks first.' }, async () => {
  const b = requireStatus();
  const t = thingAtPoint(b);
  const root = b.git.root;
  if (!t || !['section', 'file', 'hunk', 'hunk-line'].includes(t.kind)) return;
  const what = t.kind === 'section' ? `all ${t.section} changes` : t.kind === 'file' ? t.file.path : `this hunk in ${t.file.path}`;
  const verb = t.section === 'untracked' ? 'Delete' : 'Discard';
  if (!(await yesOrNo(`${verb} ${what}?`))) return;
  if (t.kind === 'hunk' || t.kind === 'hunk-line') {
    if (t.section === 'staged') {
      await applyPatch(root, t.diff, t.hunk, ['--cached', '-R']);
      await applyPatch(root, t.diff, t.hunk, ['-R']).catch(() => {}); // the worktree may differ
    } else if (t.section === 'unstaged') {
      await applyPatch(root, t.diff, t.hunk, ['-R']);
    } else {
      await runGit(['clean', '-f', '-q', '--', t.file.path], { cwd: root });
    }
  } else {
    const entries = t.kind === 'section' ? b.git.status[t.section] : [t.file];
    const paths = entries.map((f) => f.path);
    if (t.section === 'untracked') await runGit(['clean', '-f', '-q', '--', ...paths], { cwd: root });
    else if (t.section === 'unstaged') await runGit(['checkout', '--', ...paths], { cwd: root });
    else if (t.section === 'staged') {
      const added = entries.filter((f) => f.status === 'A').map((f) => f.path);
      const rest = entries.filter((f) => f.status !== 'A').map((f) => f.path);
      if (added.length) await runGit(['rm', '-f', '-q', '--', ...added], { cwd: root });
      if (rest.length) await runGit(['checkout', 'HEAD', '--', ...rest], { cwd: root });
    }
  }
  await refreshRepo(root);
  // Buffers visiting changed files now differ from disk; re-read the unmodified ones.
  const { revertBuffer } = await import('../core/files.js');
  for (const fb of bufferList()) {
    if (fb.file?.startsWith(root) && !fb.modified) await revertBuffer(fb).catch(() => {});
  }
});

defcommand('git-visit', { doc: 'Open the file at point (at the hunk line), or show the commit or stash (RET).' }, async () => {
  const b = currentBuffer();
  const t = thingAtPoint(b);
  if (!t) return;
  if (t.kind === 'section') return call('git-toggle-section');
  if (t.kind === 'commit') return call('git-show-commit', t.hash, b.git.root);
  if (t.kind === 'stash') return call('git-show-commit', t.stash.ref, b.git.root, { stash: true });
  if (!t.file) return;
  const { openFile } = await import('../commands/files.js');
  const path = b.git.root + t.file.path;
  if (t.file.status === 'D') return message('%s was deleted', t.file.path);
  const fb = await openFile(path, { otherWindow: true });
  let line = 1;
  if (t.kind === 'hunk') line = t.hunk.newStart;
  if (t.kind === 'hunk-line') line = hunkLineTarget(t.hunk, t.lineIndex);
  fb.point.set(fb.offsetAt(line - 1, 0));
});

// ---------------------------------------------------------------------------
// Section motion

function jumpSection(dir) {
  const b = requireStatus();
  const info = b.git.info;
  const isStop = (x) => x && (x.kind === 'section' || x.kind === 'file' || x.kind === 'hunk' || x.kind === 'commit' || x.kind === 'stash');
  for (let i = b.lineAt() + dir; i >= 0 && i < info.length; i += dir) {
    if (isStop(info[i])) { b.point.set(b.lineStart(i)); return; }
  }
}

defcommand('git-next-section', { doc: 'Move to the next section, file or hunk (g j, C-j).' }, () => jumpSection(1));
defcommand('git-previous-section', { doc: 'Move to the previous section, file or hunk (g k, C-k).' }, () => jumpSection(-1));

// ---------------------------------------------------------------------------
// Keeping status buffers current

addHook('after-save-hook', async function gitRefreshAfterSave(buf) {
  if (!getVarOr('git-auto-refresh', true) || !buf.file) return;
  const statusBufs = bufferList({ all: true }).filter((x) => x.mode === 'git-status-mode' && buf.file.startsWith(x.git.root));
  for (const s of statusBufs) {
    if (windowList().some((w) => w.buffer === s)) refreshStatus(s).catch(() => {});
    else s.git.stale = true;
  }
});

addHook('window-buffer-change-hook', function gitRefreshStaleOnShow(win) {
  const b = win.buffer;
  if (b?.git?.stale) {
    b.git.stale = false;
    refreshStatus(b).catch(() => {});
  }
});

