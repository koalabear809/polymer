// Ex commands (:w, :q, :s/a/b/g, :%norm A;, :g/pat/d, ...).
//
// Define your own:
//   defineExCommand('hello', 'he', ({ args }) => message('hello %s', args))
// The second argument is the shortest accepted abbreviation.

import { defcommand, getVarOr, setq, setLocal, call, fboundp, boundp, runHooksAsync } from '../core/registry.js';
import { readString, yesOrNo } from '../core/helm/helm.js';
import { message } from '../core/echo.js';
import { PolymerError } from '../core/errors.js';
import { invoke, isTauri } from '../core/host.js';
import { saveState } from '../core/persist.js';
import { evalString } from '../core/eval.js';
import { prin1 } from '../core/printer.js';
import { executeKeys, parseKeyString, callInteractively } from '../core/command-loop.js';
import { bufferList, getBuffer, getBufferCreate, generateNewBufferName } from '../core/buffer.js';
import { Marker } from '../core/marker.js';
import {
  selectedWindow, setWindowBuffer, windowList, deleteWindow, splitWindow, selectWindow,
  deleteOtherWindows,
} from '../core/window.js';
import { saveBuffer, writeFile, revertBuffer, expandFileName, abbreviateFileName, asDirectory } from '../core/files.js';
import { setMajorMode } from '../core/modes.js';
import { storeRegister, getRegister, registerList, setReadOnlyRegister } from './registers.js';
import {
  cur, prefix, firstNonBlank, lineRange, rangeText, getMark, allMarks, pushJump,
  invalidateRecording, exitVisual,
} from './core.js';
import { deleteRange, shiftLines } from './commands.js';
import { compileSearch, setLastSearch, lastSearchPattern, findMatch } from './search.js';

const userError = (msg) => new PolymerError('user-error', msg);

// ---------------------------------------------------------------------------
// Command table

const exCommands = []; // { name, abbrev, fn, doc }

/** Register an ex command. `abbrev` is the shortest accepted prefix (default: name). */
export function defineExCommand(name, abbrev, fn, doc = '') {
  if (typeof abbrev === 'function') [abbrev, fn, doc] = [name, abbrev, fn ?? ''];
  const i = exCommands.findIndex((c) => c.name === name);
  const entry = { name, abbrev, fn, doc };
  if (i >= 0) exCommands[i] = entry;
  else exCommands.push(entry);
  return name;
}

export function findExCommand(word) {
  const exact = exCommands.find((c) => c.name === word);
  if (exact) return exact;
  return exCommands.find((c) => c.name.startsWith(word) && word.length >= c.abbrev.length) ?? null;
}

export const exCommandNames = () => exCommands.map((c) => c.name);

// ---------------------------------------------------------------------------
// Parsing

function parseAddress(s, i, b) {
  let line = null;
  const c = s[i];
  if (c === '.') { line = b.lineAt(); i++; }
  else if (c === '$') { line = b.lineCount - 1; i++; }
  else if (/\d/.test(c ?? '')) {
    const m = /^\d+/.exec(s.slice(i));
    line = Number(m[0]) - 1;
    i += m[0].length;
  } else if (c === "'") {
    const mk = getMark(b, s[i + 1]);
    if (!mk || mk.buffer !== b) throw userError(`Mark not set: ${s[i + 1]}`);
    line = b.lineAt(mk.pos);
    i += 2;
  } else if (c === '/' || c === '?') {
    const end = s.indexOf(c, i + 1);
    const pat = s.slice(i + 1, end < 0 ? undefined : end) || lastSearchPattern();
    const m = findMatch(b, pat, b.point.pos, c === '/');
    if (!m) throw userError(`Pattern not found: ${pat}`);
    line = b.lineAt(m.from);
    i = end < 0 ? s.length : end + 1;
  }
  // Offsets: +N, -N, + and - alone mean 1.
  while (s[i] === '+' || s[i] === '-') {
    const sign = s[i] === '+' ? 1 : -1;
    i++;
    const m = /^\d+/.exec(s.slice(i));
    const n = m ? Number(m[0]) : 1;
    if (m) i += m[0].length;
    line = (line ?? b.lineAt()) + sign * n;
  }
  return { line, i };
}

/** Parse ":[range]cmd[!] args" into { range, name, bang, args }. */
export function parseEx(input, b) {
  const s = input.replace(/^[:\s]+/, '');
  let i = 0;
  let range = null;
  if (s[0] === '%') {
    range = { from: 0, to: b.lineCount - 1 };
    i = 1;
  } else {
    const a = parseAddress(s, 0, b);
    i = a.i;
    if (a.line !== null) range = { from: a.line, to: a.line };
    if (s[i] === ',' || s[i] === ';') {
      i++;
      const c = parseAddress(s, i, b);
      i = c.i;
      range = { from: range?.from ?? b.lineAt(), to: c.line ?? b.lineAt() };
    }
  }
  if (range) {
    if (range.from > range.to) [range.from, range.to] = [range.to, range.from];
    range.from = Math.max(0, range.from);
    range.to = Math.min(b.lineCount - 1, range.to);
  }
  const rest = s.slice(i).trimStart();
  const m = /^([a-zA-Z]+|[&~<>!=#@]+)/.exec(rest);
  let name = m ? m[1] : '';
  let after = m ? rest.slice(m[1].length) : rest;
  // "s/a/b/" style: the command is a single letter followed by a delimiter.
  if (/^(s|g|v)[^a-zA-Z\s]/.test(rest) && !findExCommand(name)) { name = rest[0]; after = rest.slice(1); }
  // ":>>" shifts twice: one command plus repeat characters.
  if (/^([<>])\1+$/.test(name)) { after = name.slice(1) + after; name = name[0]; }
  const bang = after.startsWith('!');
  if (bang) after = after.slice(1);
  return { range, name, bang, args: after.trim(), raw: after };
}

/** Run an ex command line. */
export async function executeEx(input) {
  const b = cur();
  const parsed = parseEx(input, b);
  setReadOnlyRegister(':', input);
  if (!parsed.name) {
    // A bare range moves to its last line.
    if (parsed.range) {
      pushJump(b);
      b.goto(firstNonBlank(b, parsed.range.to));
      return;
    }
    return;
  }
  const cmd = findExCommand(parsed.name);
  if (!cmd) throw userError(`Not an editor command: ${parsed.name}`);
  return cmd.fn({ ...parsed, buf: b, input });
}

defcommand('vim-ex', { doc: 'Read and run an ex command (:). In visual state the range is the selection.' }, async () => {
  invalidateRecording();
  const b = cur();
  let initial = '';
  if (b.state === 'visual') {
    exitVisual(b);
    initial = "'<,'>";
  } else if (prefix.count !== null) {
    initial = prefix.count === 1 ? '.' : `.,.+${prefix.count - 1}`;
  }
  const input = await readString(':', { initial, history: 'vim-ex-history' });
  if (!input.trim()) return;
  return executeEx(input);
});

defcommand('vim-ex-execute', { doc: 'Run an ex command given as a string.' }, (input) => executeEx(input));

// ---------------------------------------------------------------------------
// Helpers

const defaultRange = (p, b) => p.range ?? { from: b.lineAt(), to: b.lineAt() };

function fileBuffers({ modified = false } = {}) {
  return bufferList({ all: true }).filter((x) => x.file && (!modified || x.modified));
}

async function quitApp(force) {
  if (!force) {
    const dirty = fileBuffers({ modified: true });
    if (dirty.length) throw userError(`No write since last change for ${dirty.map((d) => d.name).join(', ')} (add ! to override)`);
  }
  if (!isTauri) throw userError('Not running in the app');
  await runHooksAsync('kill-polymer-hook');
  try { await saveState(); } catch (e) { console.warn('polymer: saving state failed:', e); }
  await invoke('quit_app');
}

async function closeWindow(b, force) {
  if (b.file && b.modified && !force && windowList().filter((w) => w.buffer === b).length <= 1) {
    throw userError('No write since last change (add ! to override)');
  }
  if (windowList().length > 1) return deleteWindow(selectedWindow());
  return quitApp(force);
}

async function openFileEx(path, { split } = {}) {
  const { openFile } = await import('../commands/files.js');
  if (split) selectWindow(splitWindow(selectedWindow(), split));
  return openFile(expandFileName(path));
}

// ---------------------------------------------------------------------------
// Files, buffers, windows

defineExCommand('write', 'w', async ({ buf, args, bang }) => {
  if (args) return writeFile(buf, args, { confirm: bang ? null : yesOrNo });
  if (!buf.file) throw userError('No file name');
  buf.modified = true; // :w always writes
  return saveBuffer(buf, { confirm: bang ? async () => true : yesOrNo });
}, 'Write the buffer (to a new file name if given).');

defineExCommand('update', 'up', async ({ buf }) => { if (buf.modified) return saveBuffer(buf, { confirm: yesOrNo }); }, 'Write the buffer if modified.');
defineExCommand('wq', 'wq', async (p) => { await findExCommand('write').fn(p); return closeWindow(p.buf, true); }, 'Write and close.');
defineExCommand('xit', 'x', async ({ buf, bang }) => { if (buf.modified && buf.file) await saveBuffer(buf, { confirm: yesOrNo }); return closeWindow(buf, bang); }, 'Write if modified, then close.');
defineExCommand('exit', 'exi', async (p) => findExCommand('xit').fn(p), 'Same as :x.');
defineExCommand('quit', 'q', ({ buf, bang }) => closeWindow(buf, bang), 'Close the window (quit on the last one).');
defineExCommand('close', 'clo', () => deleteWindow(selectedWindow()), 'Close the window.');
defineExCommand('only', 'on', () => deleteOtherWindows(selectedWindow()), 'Close all other windows.');
defineExCommand('qall', 'qa', ({ bang }) => quitApp(bang), 'Quit (fails with unsaved changes unless !).');
defineExCommand('quitall', 'quita', ({ bang }) => quitApp(bang), 'Same as :qa.');
defineExCommand('wall', 'wa', async () => { for (const x of fileBuffers({ modified: true })) await saveBuffer(x, { confirm: yesOrNo }); }, 'Write all modified buffers.');
defineExCommand('wqall', 'wqa', async () => { for (const x of fileBuffers({ modified: true })) await saveBuffer(x, { confirm: yesOrNo }); return quitApp(true); }, 'Write all and quit.');
defineExCommand('xall', 'xa', async (p) => findExCommand('wqall').fn(p), 'Same as :wqa.');

defineExCommand('edit', 'e', async ({ buf, args, bang }) => {
  if (args) return openFileEx(args);
  if (!buf.file) throw userError('No file name');
  if (buf.modified && !bang) throw userError('No write since last change (add ! to override)');
  return revertBuffer(buf);
}, 'Edit a file, or re-read the current one.');

defineExCommand('enew', 'ene', () => {
  const nb = getBufferCreate(generateNewBufferName('untitled'));
  setWindowBuffer(selectedWindow(), nb);
}, 'Edit a new, unnamed buffer.');

defineExCommand('saveas', 'sav', ({ buf, args }) => {
  if (!args) throw userError('Argument required');
  return writeFile(buf, args, { confirm: yesOrNo });
}, 'Save to a new file name and visit it.');

defineExCommand('buffer', 'b', ({ args }) => {
  if (!args) return callInteractively('switch-to-buffer');
  const all = bufferList();
  const target = getBuffer(args) ?? all.find((x) => x.name.includes(args));
  if (!target) throw userError(`No matching buffer for ${args}`);
  setWindowBuffer(selectedWindow(), target);
}, 'Switch to a buffer by name.');

defineExCommand('buffers', 'buffers', () => callInteractively('switch-to-buffer'), 'List buffers.');
defineExCommand('ls', 'ls', () => callInteractively('switch-to-buffer'), 'List buffers.');
defineExCommand('bdelete', 'bd', async ({ buf, args, bang }) => {
  const target = args ? getBuffer(args) : buf;
  if (!target) throw userError(`No such buffer: ${args}`);
  if (target.file && target.modified && !bang) throw userError('No write since last change (add ! to override)');
  const { killBuffer } = await import('../commands/builtins.js');
  killBuffer(target);
}, 'Kill a buffer.');
defineExCommand('bnext', 'bn', () => call('next-buffer'), 'Next buffer.');
defineExCommand('bprevious', 'bp', () => call('previous-buffer'), 'Previous buffer.');
defineExCommand('bNext', 'bN', () => call('previous-buffer'), 'Previous buffer.');

defineExCommand('split', 'sp', ({ args }) => (args ? openFileEx(args, { split: 'below' }) : selectWindow(splitWindow(selectedWindow(), 'below'))), 'Split the window horizontally.');
defineExCommand('vsplit', 'vs', ({ args }) => (args ? openFileEx(args, { split: 'right' }) : selectWindow(splitWindow(selectedWindow(), 'right'))), 'Split the window vertically.');
defineExCommand('new', 'new', () => { selectWindow(splitWindow(selectedWindow(), 'below')); return findExCommand('enew').fn({}); }, 'Split with a new buffer.');
defineExCommand('vnew', 'vne', () => { selectWindow(splitWindow(selectedWindow(), 'right')); return findExCommand('enew').fn({}); }, 'Vertical split with a new buffer.');

defineExCommand('pwd', 'pw', () => message('%s', abbreviateFileName(getVarOr('default-directory', '/'))), 'Show the current directory.');
defineExCommand('cd', 'cd', ({ buf, args }) => {
  const dir = asDirectory(expandFileName(args || '~'));
  setLocal('default-directory', dir, buf);
  message('%s', abbreviateFileName(dir));
}, 'Set this buffer\'s directory.');

// ---------------------------------------------------------------------------
// Editing

defineExCommand('delete', 'd', ({ buf, range, args }) => {
  const r = defaultRange({ range }, buf);
  const m = /^([a-zA-Z"_])?\s*(\d+)?$/.exec(args) ?? [];
  const to = m[2] ? Math.min(buf.lineCount - 1, r.to + Number(m[2]) - 1) : r.to;
  deleteRange(buf, lineRange(buf, r.from, to), m[1] ?? null);
}, 'Delete lines [into a register].');

defineExCommand('yank', 'y', ({ buf, range, args }) => {
  const r = defaultRange({ range }, buf);
  const m = /^([a-zA-Z"_])?\s*(\d+)?$/.exec(args) ?? [];
  const to = m[2] ? Math.min(buf.lineCount - 1, r.to + Number(m[2]) - 1) : r.to;
  storeRegister(m[1] ?? null, rangeText(buf, lineRange(buf, r.from, to)), 'line', 'yank');
}, 'Yank lines [into a register].');

defineExCommand('put', 'pu', async ({ buf, range, args, bang }) => {
  const reg = await getRegister(args || '"');
  if (!reg) throw userError('Register is empty');
  const line = range ? range.to : buf.lineAt();
  const text = reg.text.endsWith('\n') ? reg.text : `${reg.text}\n`;
  if (bang) { buf.insertText(buf.lineStart(line), text); buf.goto(firstNonBlank(buf, line)); }
  else if (line === buf.lineCount - 1) { buf.insertText(buf.length, `\n${text.slice(0, -1)}`); buf.goto(firstNonBlank(buf, line + 1)); }
  else { buf.insertText(buf.lineStart(line + 1), text); buf.goto(firstNonBlank(buf, line + 1)); }
}, 'Put a register as lines below (above with !).');

defineExCommand('join', 'j', ({ buf, range }) => {
  const r = defaultRange({ range }, buf);
  buf.goto(buf.lineStart(r.from));
  prefix.count = Math.max(2, r.to - r.from + 1);
  return call('vim-join');
}, 'Join lines.');

defineExCommand('>', '>', ({ buf, range, raw }) => {
  const r = defaultRange({ range }, buf);
  shiftLines(buf, r.from, r.to, 1, 1 + (raw.match(/>/g)?.length ?? 0));
}, 'Indent lines.');

defineExCommand('<', '<', ({ buf, range, raw }) => {
  const r = defaultRange({ range }, buf);
  shiftLines(buf, r.from, r.to, -1, 1 + (raw.match(/</g)?.length ?? 0));
}, 'Unindent lines.');

defineExCommand('sort', 'sor', ({ buf, range, bang, args }) => {
  const r = range ?? { from: 0, to: buf.lineCount - 1 };
  const lines = [];
  for (let l = r.from; l <= r.to; l++) lines.push(buf.lineText(l));
  const flags = args.replace(/\s/g, '');
  let cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  if (flags.includes('i')) cmp = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  if (flags.includes('n')) cmp = (a, b) => (parseFloat(a.match(/-?\d+(\.\d+)?/)?.[0]) || 0) - (parseFloat(b.match(/-?\d+(\.\d+)?/)?.[0]) || 0);
  let sorted = [...lines].sort(cmp);
  if (bang) sorted.reverse();
  if (flags.includes('u')) sorted = sorted.filter((l, i) => i === 0 || cmp(l, sorted[i - 1]) !== 0);
  buf.replaceText(buf.lineStart(r.from), buf.lineEnd(r.to), sorted.join('\n'));
  buf.goto(firstNonBlank(buf, r.from));
}, 'Sort lines (! reverses; flags: i ignore case, n numeric, u unique).');

// :s/pattern/replacement/flags. Replacement uses Vim syntax: & and \0 for the whole
// match, \1..\9 for groups, \n for a newline, \& for a literal &.
let lastSubstitute = null;

function convertReplacement(rep) {
  let out = '';
  for (let i = 0; i < rep.length; i++) {
    const c = rep[i];
    if (c === '\\' && i + 1 < rep.length) {
      const n = rep[++i];
      if (/\d/.test(n)) out += n === '0' ? '$&' : `$${n}`;
      else if (n === 'n' || n === 'r') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === '$') out += '$$';
      else out += n;
    } else if (c === '&') out += '$&';
    else if (c === '$') out += '$$';
    else out += c;
  }
  return out;
}

function splitDelimited(s, delim) {
  const parts = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === delim) { cur += delim; i++; }
    else if (s[i] === delim) { parts.push(cur); cur = ''; }
    else cur += s[i];
  }
  parts.push(cur);
  return parts;
}

function substitute(buf, range, raw) {
  let pattern;
  let replacement;
  let flags;
  if (!raw.trim() || /^[&cegiInp#lr]*$/.test(raw.trim())) {
    if (!lastSubstitute) throw userError('No previous substitute');
    ({ pattern, replacement } = lastSubstitute);
    flags = raw.trim().replace(/^&/, '');
  } else {
    const delim = raw[0];
    const parts = splitDelimited(raw.slice(1), delim);
    pattern = parts[0] || lastSearchPattern();
    replacement = parts[1] ?? '';
    flags = parts[2] ?? '';
    if (!pattern) throw userError('No previous pattern');
    lastSubstitute = { pattern, replacement };
  }
  const re = compileSearch(pattern);
  const global = flags.includes('g');
  const countOnly = flags.includes('n');
  const finalRe = new RegExp(re.source, (flags.includes('I') ? '' : flags.includes('i') ? 'i' : re.flags.replace('g', '')) + (global ? 'g' : ''));
  const rep = convertReplacement(replacement);
  setLastSearch(pattern);
  let lines = 0;
  let count = 0;
  let lastLine = null;
  // Work bottom-up so earlier line numbers stay valid as replacements add/remove lines.
  for (let l = range.to; l >= range.from; l--) {
    const text = buf.lineText(l);
    finalRe.lastIndex = 0;
    if (!finalRe.test(text)) continue;
    finalRe.lastIndex = 0;
    const n = (text.match(new RegExp(finalRe.source, `${finalRe.flags.replace('g', '')}g`)) ?? []).length;
    count += global ? n : 1;
    lines++;
    if (lastLine === null) lastLine = l;
    if (countOnly) continue;
    finalRe.lastIndex = 0;
    const replaced = text.replace(finalRe, rep);
    if (replaced !== text) buf.replaceText(buf.lineStart(l), buf.lineEnd(l), replaced);
  }
  if (!lines) {
    if (flags.includes('e')) return;
    throw userError(`Pattern not found: ${pattern}`);
  }
  if (!countOnly) buf.goto(firstNonBlank(buf, Math.min(lastLine, buf.lineCount - 1)));
  if (countOnly || lines > 1) message('%d match%s on %d line%s', count, count === 1 ? '' : 'es', lines, lines === 1 ? '' : 's');
}

defineExCommand('substitute', 's', ({ buf, range, raw }) => substitute(buf, defaultRange({ range }, buf), raw), 'Substitute: :s/pattern/replacement/[g][i][n][e].');
defineExCommand('&', '&', ({ buf, range, raw }) => substitute(buf, defaultRange({ range }, buf), raw), 'Repeat the last substitute.');

defineExCommand('normal', 'norm', async ({ buf, range, args }) => {
  const keys = parseKeyString(args);
  const r = range ?? { from: buf.lineAt(), to: buf.lineAt() };
  // Markers keep track of the lines as earlier lines change.
  const starts = [];
  for (let l = r.from; l <= r.to; l++) starts.push(new Marker(buf, buf.lineStart(l)));
  try {
    for (const m of starts) {
      if (!m.buffer) continue;
      buf.goto(m.pos);
      await executeKeys(keys);
      if (buf.state !== 'normal') await executeKeys(['ESC']);
    }
  } finally {
    for (const m of starts) m.detach();
  }
}, 'Run normal-state keys on each line of the range, e.g. :%norm A;');

async function globalCommand({ buf, range, raw }, invert) {
  const delim = raw[0];
  const parts = splitDelimited(raw.slice(1), delim);
  const pattern = parts[0] || lastSearchPattern();
  const command = parts.slice(1).join(delim).trim() || 'p';
  const re = compileSearch(pattern);
  setLastSearch(pattern);
  const r = range ?? { from: 0, to: buf.lineCount - 1 };
  const marks = [];
  for (let l = r.from; l <= r.to; l++) {
    re.lastIndex = 0;
    if (re.test(buf.lineText(l)) !== invert) marks.push(new Marker(buf, buf.lineStart(l)));
  }
  if (command === 'p' || command === 'print') {
    const lines = marks.map((m) => `${String(buf.lineAt(m.pos) + 1).padStart(5)}  ${buf.lineText(buf.lineAt(m.pos))}`);
    marks.forEach((m) => m.detach());
    const { showHelp } = await import('../commands/help.js');
    showHelp(lines.join('\n') || 'No matches');
    return;
  }
  try {
    for (const m of marks) {
      if (!m.buffer) continue;
      const line = buf.lineAt(m.pos);
      buf.goto(m.pos);
      await executeEx(`${line + 1}${command}`);
    }
  } finally {
    marks.forEach((m) => m.detach());
  }
}

defineExCommand('global', 'g', (p) => globalCommand(p, p.bang), 'Run an ex command on matching lines: :g/pattern/d');
defineExCommand('vglobal', 'v', (p) => globalCommand(p, true), 'Run an ex command on non-matching lines: :v/pattern/d');

// ---------------------------------------------------------------------------
// Options, info, misc

const OPTIONS = {
  tabstop: ['tab-width', 'number'], ts: ['tab-width', 'number'],
  shiftwidth: ['vim-shift-width', 'number'], sw: ['vim-shift-width', 'number'],
  scrolloff: ['scroll-margin', 'number'], so: ['scroll-margin', 'number'],
  expandtab: ['indent-tabs-mode', 'invert'], et: ['indent-tabs-mode', 'invert'],
  number: ['display-line-numbers', 'bool'], nu: ['display-line-numbers', 'bool'],
  relativenumber: ['display-line-numbers', 'relative'], rnu: ['display-line-numbers', 'relative'],
  hlsearch: ['vim-ex-search-highlight-all', 'bool'], hls: ['vim-ex-search-highlight-all', 'bool'],
  wrapscan: ['vim-search-wrap', 'bool'], ws: ['vim-search-wrap', 'bool'],
  ignorecase: ['vim-ex-search-case', 'case'], ic: ['vim-ex-search-case', 'case'],
};

function setOption(spec, local, buf) {
  const set = (name, value) => (local ? setLocal(name, value, buf) : setq(name, value, null));
  let m = /^(\w+)=(.*)$/.exec(spec);
  if (m) {
    const opt = OPTIONS[m[1]];
    if (!opt) throw userError(`Unknown option: ${m[1]}`);
    set(opt[0], opt[1] === 'number' ? Number(m[2]) : m[2]);
    return;
  }
  m = /^(no)?(\w+)(!)?$/.exec(spec);
  const opt = m && OPTIONS[m[2]];
  if (!opt) throw userError(`Unknown option: ${spec}`);
  const on = !m[1];
  if (opt[1] === 'invert') set(opt[0], !on);
  else if (opt[1] === 'relative') set(opt[0], on ? 'relative' : true);
  else if (opt[1] === 'case') set(opt[0], on ? 'insensitive' : 'smart');
  else set(opt[0], on);
}

defineExCommand('set', 'se', ({ buf, args }) => {
  for (const spec of args.split(/\s+/).filter(Boolean)) setOption(spec, false, buf);
}, 'Set options: :set ts=2 et nu rnu so=5 ...');
defineExCommand('setlocal', 'setl', ({ buf, args }) => {
  for (const spec of args.split(/\s+/).filter(Boolean)) setOption(spec, true, buf);
}, 'Set options for this buffer only.');

defineExCommand('nohlsearch', 'noh', () => call('vim-ex-nohighlight'), 'Stop highlighting search matches.');

defineExCommand('registers', 'reg', async () => {
  const lines = ['Type Name Content'];
  for (const [name, v] of registerList()) {
    const t = { char: 'c', line: 'l', block: 'b' }[v.type] ?? 'c';
    lines.push(`  ${t}  "${name}   ${v.text.replace(/\n/g, '^J').slice(0, 200)}`);
  }
  const { showHelp } = await import('../commands/help.js');
  showHelp(lines.join('\n'));
}, 'Show register contents.');
defineExCommand('display', 'di', (p) => findExCommand('registers').fn(p), 'Same as :registers.');

defineExCommand('marks', 'marks', async ({ buf }) => {
  const lines = ['mark line  col file/text'];
  for (const [k, mb, pos] of allMarks(buf)) {
    const { line, col } = mb.posAt(pos);
    const where = mb === buf ? mb.lineText(line).trim() : abbreviateFileName(mb.file ?? mb.name);
    lines.push(` ${k}  ${String(line + 1).padStart(6)} ${String(col).padStart(4)} ${where}`);
  }
  const { showHelp } = await import('../commands/help.js');
  showHelp(lines.join('\n'));
}, 'Show marks.');

defineExCommand('messages', 'mes', () => call('view-echo-area-messages'), 'Show *Messages*.');

defineExCommand('help', 'h', ({ args }) => {
  if (!args) return callInteractively('describe-function');
  if (fboundp(args)) return call('describe-function', args);
  if (boundp(args)) return call('describe-variable', args);
  const ex = findExCommand(args.replace(/^:/, ''));
  if (ex) return message(':%s  %s', ex.name, ex.doc || '');
  throw userError(`No help for ${args}`);
}, 'Describe a function, variable or ex command.');

defineExCommand('js', 'js', async ({ args }) => {
  const value = await evalString(args);
  message('%s', prin1(value));
}, 'Evaluate JavaScript: :js 1 + 2');

defineExCommand('mode', 'mode', ({ buf, args }) => setMajorMode(buf, args.endsWith('-mode') ? args : `${args}-mode`), 'Set the major mode: :mode rust');


defcommand('save-buffers-kill-polymer', { doc: 'Offer to save each modified file buffer, then quit.' }, async () => {
  for (const b of fileBuffers({ modified: true })) {
    if (await yesOrNo(`Save ${abbreviateFileName(b.file)}?`)) await saveBuffer(b, { confirm: yesOrNo });
  }
  const dirty = fileBuffers({ modified: true });
  if (dirty.length && !(await yesOrNo(`${dirty.length} modified buffer(s) not saved; quit anyway?`))) return;
  return quitApp(true);
});
