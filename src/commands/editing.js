// Basic editing and motion commands.
//
// Emacs-named primitives (forward-char, next-line, delete-backward-char, ...). The vim
// layer in src/vim builds on these; insert state uses them directly.

import { defcommand, defvar, getVarOr, runHooks } from '../core/registry.js';
import { currentBuffer } from '../core/buffer.js';
import { undo, redo } from '../core/undo.js';
import { visualColumn, columnForVisual } from '../core/width.js';
import { message } from '../core/echo.js';
import { PolymerError } from '../core/errors.js';

defvar('indent-tabs-mode', false, { doc: 'When true, indentation inserts tabs; otherwise spaces.' });
defvar('electric-indent-mode', true, { doc: 'When true, newline copies the indentation of the current line.' });

const cur = () => currentBuffer();
const tabWidth = (b) => getVarOr('tab-width', 4, b);

function lineInfo(b, pos = b.point.pos) {
  const line = b.lineAt(pos);
  const start = b.lineStart(line);
  const text = b.lineText(line);
  return { line, start, text, col: pos - start, end: start + text.length };
}

// ---------------------------------------------------------------------------
// Insertion and deletion

defcommand('self-insert-command', { doc: 'Insert the typed text at point (overwriting in replace state).' }, (text) => {
  const b = cur();
  if (b.state === 'replace' && !text.includes('\n')) {
    const { end } = lineInfo(b);
    const n = Math.min([...text].length, end - b.point.pos);
    if (n > 0) b.deleteText(b.point.pos, b.point.pos + n);
  }
  b.insert(text);
  runHooks('post-self-insert-hook', text);
});

defcommand('newline', { doc: 'Insert a newline, copying indentation when electric-indent-mode is on.' }, () => {
  const b = cur();
  let indent = '';
  if (getVarOr('electric-indent-mode', true, b)) {
    const { text, col, start } = lineInfo(b);
    indent = /^[ \t]*/.exec(text)[0];
    if (indent.length > col) indent = indent.slice(0, col);
    // Clear whitespace around point: trailing spaces would be left behind on this line,
    // and leading spaces after point would add to the new line's indentation.
    const before = text.slice(0, col);
    const trailing = /[ \t]+$/.exec(before);
    const back = trailing && trailing[0].length < before.length ? trailing[0].length : 0;
    const ahead = /^[ \t]*/.exec(text.slice(col))[0].length;
    if (back || ahead) b.deleteText(start + col - back, start + col + ahead);
  }
  b.insert(`\n${indent}`);
});

defcommand('delete-backward-char', { doc: 'Delete the character before point (or back to the previous tab stop in leading spaces).' }, (n = 1) => {
  const b = cur();
  const pt = b.point.pos;
  if (pt === 0) throw new PolymerError('beginning-of-buffer', 'Beginning of buffer');
  const { text, col } = lineInfo(b);
  let count = n;
  // In leading indentation made of spaces, delete back to the previous tab stop.
  if (n === 1 && col > 0 && /^ +$/.test(text.slice(0, col)) && !getVarOr('indent-tabs-mode', false, b)) {
    const tw = tabWidth(b);
    count = ((col - 1) % tw) + 1;
  }
  b.deleteText(Math.max(0, pt - count), pt);
});

defcommand('delete-char', { doc: 'Delete the character after point.' }, (n = 1) => {
  const b = cur();
  const pt = b.point.pos;
  if (pt >= b.length) throw new PolymerError('end-of-buffer', 'End of buffer');
  b.deleteText(pt, Math.min(b.length, pt + n));
});

defcommand('indent-for-tab-command', { doc: 'Insert a tab, or spaces to the next tab stop.' }, () => {
  const b = cur();
  if (getVarOr('indent-tabs-mode', false, b)) return b.insert('\t');
  const { text, col } = lineInfo(b);
  const tw = tabWidth(b);
  const v = visualColumn(text, col, tw);
  b.insert(' '.repeat(tw - (v % tw)));
});

// ---------------------------------------------------------------------------
// Motion

defcommand('forward-char', { doc: 'Move point forward one character (crossing lines).' }, (n = 1) => {
  const b = cur();
  if (b.point.pos + n > b.length) throw new PolymerError('end-of-buffer', 'End of buffer');
  b.goto(b.point.pos + n);
});

defcommand('backward-char', { doc: 'Move point back one character (crossing lines).' }, (n = 1) => {
  const b = cur();
  if (b.point.pos - n < 0) throw new PolymerError('beginning-of-buffer', 'Beginning of buffer');
  b.goto(b.point.pos - n);
});

const VERTICAL = new Set(['next-line', 'previous-line', 'vim-next-line', 'vim-previous-line', 'scroll-half-page-down', 'scroll-half-page-up']);

/** Move `n` lines keeping the goal (visual) column across consecutive vertical motions. */
function verticalMove(b, n) {
  const { line, text, col } = lineInfo(b);
  const tw = tabWidth(b);
  if (!VERTICAL.has(getVarOr('last-command', null, null)) || b.goalColumn === undefined) {
    b.goalColumn = visualColumn(text, col, tw);
  }
  const target = Math.max(0, Math.min(b.lineCount - 1, line + n));
  if (target === line) {
    throw new PolymerError(n > 0 ? 'end-of-buffer' : 'beginning-of-buffer', n > 0 ? 'End of buffer' : 'Beginning of buffer');
  }
  const t = b.lineText(target);
  b.goto(b.lineStart(target) + columnForVisual(t, b.goalColumn, tw));
}

defcommand('next-line', { doc: 'Move to the next line, keeping the column.' }, (n = 1) => verticalMove(cur(), n));
defcommand('previous-line', { doc: 'Move to the previous line, keeping the column.' }, (n = 1) => verticalMove(cur(), -n));

defcommand('beginning-of-line', { doc: 'Move to the start of the line.' }, () => {
  const b = cur();
  b.goto(lineInfo(b).start);
});

defcommand('end-of-line', { doc: 'Move to the end of the line.' }, () => {
  const b = cur();
  b.goto(lineInfo(b).end);
});

defcommand('back-to-indentation', { doc: 'Move to the first non-whitespace character on the line.' }, () => {
  const b = cur();
  const { start, text } = lineInfo(b);
  b.goto(start + /^[ \t]*/.exec(text)[0].length);
});

defcommand('beginning-of-buffer', { doc: 'Move to the start of the buffer.' }, () => cur().goto(0));
defcommand('end-of-buffer', { doc: 'Move to the end of the buffer.' }, () => { const b = cur(); b.goto(b.length); });

// ---------------------------------------------------------------------------
// Undo (vim's u / C-r are in src/vim; undo boundaries are added by the vim layer)

defcommand('undo', { doc: 'Undo the last change.' }, () => {
  if (!undo(cur())) throw new PolymerError('user-error', 'No further undo information');
  message('Undo');
});

defcommand('redo', { doc: 'Redo the last undone change.' }, () => {
  if (!redo(cur())) throw new PolymerError('user-error', 'No further redo information');
  message('Redo');
});
