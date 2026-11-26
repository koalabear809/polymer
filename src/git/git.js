// Running git and parsing its output.

import { defvar, getVarOr } from '../core/registry.js';
import { invoke } from '../core/host.js';
import { getBufferCreate } from '../core/buffer.js';
import { setMajorMode } from '../core/modes.js';
import { PolymerError } from '../core/errors.js';
import { normalizePath, asDirectory } from '../core/files.js';

defvar('git-executable', 'git', { doc: 'The git program.' });
defvar('git-process-log-max', 200, { doc: 'Commands kept in the *git-process* log.' });

const firstLine = (s) => (s ?? '').trim().split('\n')[0];

// ---------------------------------------------------------------------------
// Process log (`$` in git buffers)

let logEntries = 0;
function logProcess(args, cwd, out, ms) {
  const b = getBufferCreate('*git-process*');
  if (b.mode !== 'special-mode') setMajorMode(b, 'special-mode');
  b.undoEnabled = false;
  const body = [out.stdout, out.stderr].map((s) => s.trimEnd()).filter(Boolean).join('\n');
  const lines = [`$ git ${args.join(' ')}`, ...(body ? body.split('\n').slice(0, 400).map((l) => `  ${l}`) : []), `  [exit ${out.code ?? 'signal'}, ${Math.round(ms)}ms in ${cwd}]`, ''];
  b.append(`${lines.join('\n')}\n`);
  // Keep the log bounded.
  if (++logEntries > getVarOr('git-process-log-max', 200)) {
    const text = b.getText();
    const cut = text.indexOf('\n$ git ', Math.floor(text.length / 3));
    if (cut > 0) b.deleteText(0, cut + 1, { inhibitReadOnly: true, undo: false });
    logEntries = Math.floor(logEntries * 2 / 3);
  }
}

/**
 * Run git. Resolves to { code, stdout, stderr }. Throws a PolymerError with git's message
 * when it fails, unless `allowFail`.
 */
export async function runGit(args, { cwd, stdin, allowFail = false } = {}) {
  const fullArgs = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args];
  const t0 = performance.now();
  const out = await invoke('run_process', {
    options: {
      program: getVarOr('git-executable', 'git'),
      args: fullArgs,
      cwd,
      stdin,
      env: { GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0', GIT_EDITOR: 'false' },
    },
  });
  logProcess(args, cwd, out, performance.now() - t0);
  if (out.code !== 0 && !allowFail) {
    throw new PolymerError('git-error', firstLine(out.stderr) || firstLine(out.stdout) || `git ${args[0]} failed (${out.code})`, out);
  }
  return out;
}

/** The repository root containing `dir` (with a trailing slash), or null. */
export async function repoRoot(dir) {
  const out = await runGit(['rev-parse', '--show-toplevel'], { cwd: dir, allowFail: true });
  return out.code === 0 ? asDirectory(normalizePath(out.stdout.trim())) : null;
}

// ---------------------------------------------------------------------------
// Status (git status --porcelain=v2 --branch -z)

export const STATUS_LABELS = { M: 'modified', A: 'new file', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange', U: 'unmerged' };

export function parseStatus(out) {
  const res = {
    branch: { oid: null, head: null, upstream: null, ahead: 0, behind: 0 },
    untracked: [],
    unstaged: [],
    staged: [],
    conflicted: [],
  };
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    if (e.startsWith('# ')) {
      const [, key, ...rest] = e.split(' ');
      const val = rest.join(' ');
      if (key === 'branch.oid') res.branch.oid = val;
      else if (key === 'branch.head') res.branch.head = val;
      else if (key === 'branch.upstream') res.branch.upstream = val;
      else if (key === 'branch.ab') {
        const m = /\+(\d+) -(\d+)/.exec(val);
        if (m) { res.branch.ahead = Number(m[1]); res.branch.behind = Number(m[2]); }
      }
    } else if (e[0] === '1' || e[0] === '2') {
      const f = e.split(' ');
      const xy = f[1];
      const path = f.slice(e[0] === '1' ? 8 : 9).join(' ');
      const orig = e[0] === '2' ? parts[++i] : null;
      if (xy[0] !== '.') res.staged.push({ path, status: xy[0], orig });
      if (xy[1] !== '.') res.unstaged.push({ path, status: xy[1] });
    } else if (e[0] === 'u') {
      res.conflicted.push({ path: e.split(' ').slice(10).join(' '), status: 'U' });
    } else if (e[0] === '?') {
      res.untracked.push({ path: e.slice(2), status: '?' });
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// Diffs

/**
 * Parse `git diff` output into files:
 *   [{ path, oldPath, header: [lines], binary, hunks: [{ header, oldStart, newStart, lines: [...] }] }]
 */
export function parseDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      file = { path: m ? m[2] : line.slice(11), oldPath: m ? m[1] : null, header: [line], binary: false, hunks: [] };
      files.push(file);
      hunk = null;
    } else if (!file) {
      continue;
    } else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      hunk = { header: line, oldStart: m ? Number(m[1]) : 0, newStart: m ? Number(m[2]) : 0, lines: [] };
      file.hunks.push(hunk);
    } else if (hunk) {
      hunk.lines.push(line);
    } else {
      file.header.push(line);
      if (line.startsWith('+++ ') && line !== '+++ /dev/null') file.path = line.slice(6);
      if (line.startsWith('--- ') && line !== '--- /dev/null') file.oldPath = line.slice(6);
      if (/^Binary files .* differ$/.test(line)) file.binary = true;
    }
  }
  // A trailing newline in git's output leaves an empty last line in the last hunk.
  for (const f of files) for (const h of f.hunks) while (h.lines.length && h.lines.at(-1) === '') h.lines.pop();
  return files;
}

/** A patch containing one hunk of a file, for git apply. */
export function hunkPatch(file, hunk) {
  return `${file.header.join('\n')}\n${hunk.header}\n${hunk.lines.join('\n')}\n`;
}

/**
 * The line in the new file that a hunk line corresponds to (1-based). Removed lines map
 * to the position where they were.
 */
export function hunkLineTarget(hunk, index) {
  let line = hunk.newStart;
  for (let i = 0; i < index && i < hunk.lines.length; i++) {
    const c = hunk.lines[i][0];
    if (c === ' ' || c === '+') line++;
  }
  return Math.max(1, line);
}

export { firstLine };
