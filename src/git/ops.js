// Git operations: commit, push/pull/fetch, branches, stashes, log, commits, process log.

import { defcommand, defvar, getVarOr, call } from '../core/registry.js';
import { defineMajorMode, setMajorMode } from '../core/modes.js';
import { getBufferCreate, currentBuffer, killBufferInternal } from '../core/buffer.js';
import { selectedWindow, setWindowBuffer, displayBuffer, windowList, replaceBufferInWindows } from '../core/window.js';
import { helm, readString, yesOrNo, completingRead } from '../core/helm/helm.js';
import { message } from '../core/echo.js';
import { PolymerError } from '../core/errors.js';
import { basename } from '../core/files.js';
import { runGit, repoRoot, firstLine } from './git.js';
import { refreshRepo, currentDir, thingAtPoint } from './status.js';

defvar('git-log-max', 300, { doc: 'Commits shown by git-log.' });

const userError = (msg) => new PolymerError('user-error', msg);

async function root() {
  const r = await repoRoot(currentDir());
  if (!r) throw userError('Not inside a git repository');
  return r;
}

/** Run a git command with a progress message, then refresh. Returns git's output. */
async function op(r, label, args, opts = {}) {
  message('%s…', label);
  const out = await runGit(args, { cwd: r, ...opts });
  const summary = firstLine(out.stderr) || firstLine(out.stdout) || 'done';
  message('%s: %s', label, summary);
  await refreshRepo(r);
  return out;
}

// ---------------------------------------------------------------------------
// Commit

defineMajorMode('git-commit-mode', {
  parent: 'text-mode',
  lighter: 'Commit',
  doc: 'Write a commit message. C-c C-c (or ZZ) commits; C-c C-k (or ZQ) cancels. Lines starting with # are ignored.',
});

async function startCommit({ amend = false } = {}) {
  const r = await root();
  const status = await runGit(['status', '--porcelain=v2', '--branch'], { cwd: r });
  const lines = status.stdout.split('\n');
  const staged = lines.filter((l) => /^[12u] [^.]/.test(l));
  if (!staged.length && !amend) throw userError('Nothing staged (stage with s, or S for everything)');
  const branch = (lines.find((l) => l.startsWith('# branch.head ')) ?? '').slice(14);
  const stat = await runGit(['diff', '--cached', '--stat', ...(amend ? ['HEAD^'] : [])], { cwd: r, allowFail: true });
  let initial = '';
  if (amend) initial = (await runGit(['log', '-1', '--format=%B'], { cwd: r })).stdout.trimEnd();
  const b = getBufferCreate(`COMMIT_EDITMSG: ${basename(r)}`);
  setMajorMode(b, 'git-commit-mode');
  b.gitCommit = { root: r, amend };
  b.locals.set('default-directory', r);
  const help = [
    '',
    '# Write the commit message above. Lines starting with # are ignored.',
    `# C-c C-c or ZZ to ${amend ? 'amend' : 'commit'}; C-c C-k or ZQ to cancel.`,
    '#',
    `# On branch ${branch}`,
    ...stat.stdout.trimEnd().split('\n').filter(Boolean).map((l) => `#${l}`),
  ];
  b.setText(`${initial}\n${help.join('\n')}\n`);
  b.modified = false;
  displayBuffer(b, { otherWindow: windowList().length > 0 && currentBuffer()?.mode === 'git-status-mode' });
  b.point.set(initial.length);
  await call('vim-insert');
  return b;
}

defcommand('git-commit', { doc: 'Commit the staged changes (c c).' }, () => startCommit());
defcommand('git-commit-amend', { doc: 'Amend the last commit (c a).' }, () => startCommit({ amend: true }));

defcommand('git-commit-extend', { doc: 'Add the staged changes to the last commit without editing its message (c e).' }, async () => {
  const r = await root();
  await op(r, 'Extending', ['commit', '--amend', '--no-edit']);
});

function commitBuffer() {
  const b = currentBuffer();
  if (!b.gitCommit) throw userError('Not a commit message buffer');
  return b;
}

function closeCommitBuffer(b) {
  replaceBufferInWindows(b);
  killBufferInternal(b);
}

defcommand('git-commit-finish', { doc: 'Commit with this message (C-c C-c).' }, async () => {
  const b = commitBuffer();
  if (b.state === 'insert') await call('vim-normal-state');
  const text = b.getText().split('\n').filter((l) => !l.startsWith('#')).join('\n').trim();
  if (!text) throw userError('Empty commit message');
  const { root: r, amend } = b.gitCommit;
  const out = await runGit(['commit', ...(amend ? ['--amend'] : []), '-F', '-'], { cwd: r, stdin: `${text}\n` });
  closeCommitBuffer(b);
  message('%s', firstLine(out.stdout) || 'Committed');
  await refreshRepo(r);
});

defcommand('git-commit-cancel', { doc: 'Cancel the commit (C-c C-k).' }, () => {
  const b = commitBuffer();
  closeCommitBuffer(b);
  message('Commit cancelled');
});

// ---------------------------------------------------------------------------
// Remotes

async function remotes(r) {
  return (await runGit(['remote'], { cwd: r })).stdout.split('\n').filter(Boolean);
}

async function upstreamOf(r) {
  const out = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: r, allowFail: true });
  return out.code === 0 ? out.stdout.trim() : null;
}

defcommand('git-push', { doc: 'Push the current branch to its upstream (or set one on the first push) (P p).' }, async () => {
  const r = await root();
  if (await upstreamOf(r)) return op(r, 'Pushing', ['push']);
  const rs = await remotes(r);
  if (!rs.length) throw userError('No remotes configured');
  const remote = rs.includes('origin') ? 'origin' : rs.length === 1 ? rs[0] : await completingRead('Push to remote: ', rs);
  return op(r, `Pushing to ${remote}`, ['push', '-u', remote, 'HEAD']);
});

defcommand('git-push-force', { doc: 'Force-push with lease (P f). Asks first.' }, async () => {
  const r = await root();
  if (!(await yesOrNo('Force push (with lease)?'))) return;
  return op(r, 'Force pushing', ['push', '--force-with-lease']);
});

defcommand('git-pull', { doc: 'Pull from the upstream (F p).' }, async () => op(await root(), 'Pulling', ['pull']));
defcommand('git-pull-rebase', { doc: 'Pull with rebase (F r).' }, async () => op(await root(), 'Pulling (rebase)', ['pull', '--rebase']));
defcommand('git-fetch', { doc: 'Fetch from the default remote (f f).' }, async () => op(await root(), 'Fetching', ['fetch']));
defcommand('git-fetch-all', { doc: 'Fetch all remotes, pruning deleted branches (f a).' }, async () => op(await root(), 'Fetching all', ['fetch', '--all', '--prune']));

// ---------------------------------------------------------------------------
// Branches

async function branches(r) {
  const out = await runGit(['branch', '-a', '--format=%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(subject)'], { cwd: r });
  return out.stdout.split('\n').filter(Boolean).map((l) => {
    const [name, head, upstream, subject] = l.split('\t');
    return { name, current: head === '*', upstream, subject };
  }).filter((b) => !b.name.endsWith('/HEAD'));
}

defcommand('git-checkout', { doc: 'Check out a branch (b b). Remote branches get a local tracking branch.' }, async () => {
  const r = await root();
  const list = await branches(r);
  const name = await helm({
    prompt: 'Checkout: ',
    sources: [
      { name: 'Branches', candidates: list.map((b) => ({ label: b.name, value: b.name, annotation: [b.current ? 'current' : '', b.upstream, b.subject].filter(Boolean).join('  ') })) },
      { name: 'Create branch', dummy: true, actions: { 'Create and check out': (n) => ({ create: n }) } },
    ],
  });
  if (name?.create) return op(r, `Creating ${name.create}`, ['switch', '-c', name.create.trim()]);
  const local = list.find((b) => b.name === name && !b.name.includes('/'));
  const remoteBranch = !local && name.includes('/') ? name : null;
  if (remoteBranch) {
    const localName = remoteBranch.split('/').slice(1).join('/');
    return op(r, `Checking out ${localName}`, ['switch', '--track', '-c', localName, remoteBranch]).catch(() => op(r, `Checking out ${localName}`, ['switch', localName]));
  }
  return op(r, `Checking out ${name}`, ['switch', name]);
});

defcommand('git-branch-create', {
  doc: 'Create a branch from HEAD and check it out (b c).',
  interactive: async () => [await readString('New branch: ')],
}, async (name) => {
  if (!name?.trim()) throw userError('A branch needs a name');
  return op(await root(), `Creating ${name}`, ['switch', '-c', name.trim()]);
});

defcommand('git-branch-delete', { doc: 'Delete a local branch (b k). Asks before force-deleting an unmerged branch.' }, async () => {
  const r = await root();
  const locals = (await branches(r)).filter((b) => !b.name.includes('/') && !b.current).map((b) => b.name);
  if (!locals.length) throw userError('No other local branches');
  const name = await completingRead('Delete branch: ', locals);
  const out = await runGit(['branch', '-d', name], { cwd: r, allowFail: true });
  if (out.code !== 0) {
    if (!(await yesOrNo(`${name} is not fully merged. Delete anyway?`))) return;
    await runGit(['branch', '-D', name], { cwd: r });
  }
  message('Deleted branch %s', name);
  await refreshRepo(r);
});

// ---------------------------------------------------------------------------
// Stashes

defcommand('git-stash', { doc: 'Stash changes, including untracked files (z z).' }, async () => {
  const r = await root();
  const msg = await readString('Stash message (optional): ');
  return op(r, 'Stashing', ['stash', 'push', '--include-untracked', ...(msg.trim() ? ['-m', msg.trim()] : [])]);
});

function stashAtPoint() {
  const t = thingAtPoint();
  return t?.kind === 'stash' ? t.stash.ref : 'stash@{0}';
}

defcommand('git-stash-pop', { doc: 'Pop the stash at point, or the latest (z p).' }, async () => op(await root(), 'Popping', ['stash', 'pop', stashAtPoint()]));
defcommand('git-stash-apply', { doc: 'Apply the stash at point, or the latest (z a).' }, async () => op(await root(), 'Applying', ['stash', 'apply', stashAtPoint()]));
defcommand('git-stash-drop', { doc: 'Drop the stash at point, or the latest (z k). Asks first.' }, async () => {
  const r = await root();
  const ref = stashAtPoint();
  if (!(await yesOrNo(`Drop ${ref}?`))) return;
  return op(r, 'Dropping', ['stash', 'drop', ref]);
});

// ---------------------------------------------------------------------------
// Log and commits

defineMajorMode('git-log-mode', { parent: 'special-mode', lighter: 'Git Log', doc: 'Commit log. RET shows the commit; q quits.' });
defineMajorMode('git-revision-mode', { parent: 'special-mode', lighter: 'Git Rev', doc: 'A commit and its diff. q quits.' });

/** Faces for diff text (used by commit and stash buffers). */
function diffLineDecos(text) {
  if (text.startsWith('diff --git') || text.startsWith('+++ ') || text.startsWith('--- ')) return [{ lineFace: 'git-diff-file' }];
  if (text.startsWith('@@')) return [{ lineFace: 'git-hunk-header' }];
  if (text.startsWith('+')) return [{ lineFace: 'git-diff-add' }];
  if (text.startsWith('-')) return [{ lineFace: 'git-diff-del' }];
  if (/^(commit|Author|AuthorDate|Commit|CommitDate|Merge):?\s/.test(text)) return [{ from: 0, to: text.indexOf(' ') + 1 || text.length, face: 'git-dim' }, ...(text.startsWith('commit') ? [{ from: 7, to: text.length, face: 'git-hash' }] : [])];
  return [];
}

defcommand('git-show-commit', { doc: 'Show a commit (or stash) with its diff.' }, async (rev, r, { stash = false } = {}) => {
  r ??= await root();
  const args = stash ? ['stash', 'show', '-p', '--stat', rev] : ['show', '--stat', '-p', '--format=fuller', rev];
  const out = await runGit(args, { cwd: r });
  const b = getBufferCreate(`*git-revision: ${basename(r)}*`);
  if (b.mode !== 'git-revision-mode') {
    setMajorMode(b, 'git-revision-mode');
    b.decorators.push((buf, line, start, text) => diffLineDecos(text));
  }
  b.git = { root: r, rev };
  b.locals.set('default-directory', r);
  b.setText(out.stdout.trimEnd());
  b.point.set(0);
  displayBuffer(b, { otherWindow: true });
});

defcommand('git-log', { doc: 'Show the commit graph of the current branch (l l).' }, async (all = false) => {
  const r = await root();
  const out = await runGit(['log', '--graph', '--decorate', `-n${getVarOr('git-log-max', 300)}`, '--date=short', ...(all ? ['--all'] : []), '--format=%x1e%h%x1f%ad%x1f%an%x1f%D%x1f%s'], { cwd: r });
  const lines = [];
  const meta = [];
  for (const raw of out.stdout.split('\n')) {
    if (!raw) continue;
    const i = raw.indexOf('\x1e');
    if (i < 0) { lines.push(raw); meta.push({ graph: raw.length }); continue; }
    const graph = raw.slice(0, i);
    const [hash, date, author, refs, subject] = raw.slice(i + 1).split('\x1f');
    const refText = refs ? `(${refs}) ` : '';
    lines.push(`${graph}${hash} ${refText}${subject}  ${author}, ${date}`);
    meta.push({ graph: graph.length, hash, refs: refText.length, subjectEnd: graph.length + hash.length + 1 + refText.length + subject.length });
  }
  const b = getBufferCreate(`*git-log: ${basename(r)}*`);
  if (b.mode !== 'git-log-mode') setMajorMode(b, 'git-log-mode');
  b.git = { root: r, log: meta };
  b.locals.set('default-directory', r);
  b.decorators = [(buf, line, start, text) => {
    const m = buf.git?.log?.[line];
    if (!m) return [];
    const d = [{ from: 0, to: m.graph, face: 'git-graph' }];
    if (m.hash) {
      d.push({ from: m.graph, to: m.graph + m.hash.length, face: 'git-hash' });
      if (m.refs) d.push({ from: m.graph + m.hash.length + 1, to: m.graph + m.hash.length + 1 + m.refs, face: 'git-refs' });
      d.push({ from: m.subjectEnd, to: text.length, face: 'git-dim' });
    }
    return d;
  }];
  b.setText(lines.join('\n'));
  b.point.set(0);
  setWindowBuffer(selectedWindow(), b);
});

defcommand('git-log-all', { doc: 'Show the commit graph of all branches (l a).' }, () => call('git-log', true));

defcommand('git-log-visit', { doc: 'Show the commit on this line (RET).' }, () => {
  const b = currentBuffer();
  const m = b.git?.log?.[b.lineAt()];
  if (!m?.hash) return;
  return call('git-show-commit', m.hash, b.git.root);
});

defcommand('git-process-buffer', { doc: 'Show the log of git commands run and their output ($).' }, () => {
  const b = getBufferCreate('*git-process*');
  displayBuffer(b, { otherWindow: true });
  b.point.set(b.length);
});

// ---------------------------------------------------------------------------
// From any file buffer

async function fileRepo() {
  const b = currentBuffer();
  if (!b.file) throw userError('Buffer is not visiting a file');
  const r = await repoRoot(currentDir(b));
  if (!r) throw userError('File is not in a git repository');
  return { b, r, rel: b.file.startsWith(r) ? b.file.slice(r.length) : b.file };
}

defcommand('git-stage-file', { doc: 'Stage the current buffer\'s file (SPC g S).' }, async () => {
  const { b, r, rel } = await fileRepo();
  if (b.modified) await call('save-buffer');
  await runGit(['add', '-A', '--', rel], { cwd: r });
  message('Staged %s', rel);
  await refreshRepo(r);
});

defcommand('git-unstage-file', { doc: 'Unstage the current buffer\'s file (SPC g U).' }, async () => {
  const { r, rel } = await fileRepo();
  await runGit(['reset', '-q', '--', rel], { cwd: r, allowFail: true });
  message('Unstaged %s', rel);
  await refreshRepo(r);
});

defcommand('git-log-file', { doc: 'Show the history of the current buffer\'s file.' }, async () => {
  const { r, rel } = await fileRepo();
  const out = await runGit(['log', '--follow', '-n100', '--date=short', '--format=%h  %ad  %an  %s', '--', rel], { cwd: r });
  const b = getBufferCreate(`*git-log: ${rel}*`);
  if (b.mode !== 'git-log-mode') setMajorMode(b, 'git-log-mode');
  const meta = out.stdout.split('\n').filter(Boolean).map((l) => ({ graph: 0, hash: l.split(' ')[0], refs: 0, subjectEnd: l.length }));
  b.git = { root: r, log: meta };
  b.decorators = [(buf, line, start, text) => (buf.git?.log?.[line] ? [{ from: 0, to: buf.git.log[line].hash.length, face: 'git-hash' }] : [])];
  b.setText(out.stdout.trimEnd() || '(no history)');
  b.point.set(0);
  setWindowBuffer(selectedWindow(), b);
});

