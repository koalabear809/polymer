// Vim key bindings. Motions live in the 'motion' state, which normal, visual and
// operator-pending states inherit.

import { defineKey } from '../core/keymap.js';
import { isMac } from '../core/clipboard.js';

// ---------------------------------------------------------------------------
// Motions (normal, visual, operator-pending)

defineKey({ keymaps: 'global', states: 'motion' }, {
  'h': 'vim-backward-char',
  'l': 'vim-forward-char',
  'j': 'vim-next-line',
  'k': 'vim-previous-line',
  '<left>': 'vim-backward-char',
  '<right>': 'vim-forward-char',
  '<down>': 'vim-next-line',
  '<up>': 'vim-previous-line',
  'w': 'vim-forward-word-begin',
  'W': 'vim-forward-WORD-begin',
  'b': 'vim-backward-word-begin',
  'B': 'vim-backward-WORD-begin',
  'e': 'vim-forward-word-end',
  'E': 'vim-forward-WORD-end',
  '0': 'vim-digit-argument-or-beginning-of-line',
  '^': 'vim-first-non-blank',
  '$': 'vim-end-of-line',
  '<home>': 'vim-beginning-of-line',
  '<end>': 'vim-end-of-line',
  '|': 'vim-goto-column',
  '_': 'vim-first-non-blank-of-line',
  '+': 'vim-next-line-first-non-blank',
  'RET': 'vim-next-line-first-non-blank',
  '-': 'vim-previous-line-first-non-blank',
  'G': 'vim-goto-line',
  'f': 'vim-find-char',
  'F': 'vim-find-char-backward',
  't': 'vim-find-char-to',
  'T': 'vim-find-char-to-backward',
  ';': 'vim-repeat-find-char',
  ',': 'vim-repeat-find-char-reverse',
  '}': 'vim-forward-paragraph',
  '{': 'vim-backward-paragraph',
  '%': 'vim-jump-item',
  'H': 'vim-window-top',
  'M': 'vim-window-middle',
  'L': 'vim-window-bottom',
  '/': 'vim-search-forward',
  '?': 'vim-search-backward',
  'n': 'vim-search-next',
  'N': 'vim-search-previous',
  '*': 'vim-search-word-forward',
  '#': 'vim-search-word-backward',
  '`': 'vim-goto-mark',
  "'": 'vim-goto-mark-line',
  'g': { label: 'goto' },
  'g g': 'vim-goto-first-line',
  'g e': 'vim-backward-word-end',
  'g E': 'vim-backward-WORD-end',
  'g _': 'vim-last-non-blank',
  'g j': 'vim-next-visual-line',
  'g k': 'vim-previous-visual-line',
  ...Object.fromEntries('123456789'.split('').map((d) => [d, 'vim-digit-argument'])),
});

// ---------------------------------------------------------------------------
// Operators (normal, visual, and operator-pending so dd/yy/cc/>> work)

defineKey({ keymaps: 'global', states: ['normal', 'visual', 'operator'] }, {
  'd': 'vim-delete',
  'c': 'vim-change',
  'y': 'vim-yank',
  '>': 'vim-shift-right',
  '<': 'vim-shift-left',
  'g ~': 'vim-invert-case',
  'g u': 'vim-downcase',
  'g U': 'vim-upcase',
});

// ---------------------------------------------------------------------------
// Text objects (operator-pending and visual)

const textObjects = {
  'w': 'word', 'W': 'WORD', 'p': 'paragraph',
  '"': 'double-quote', "'": 'single-quote', '`': 'back-quote',
  '(': 'paren', ')': 'paren', 'b': 'paren',
  '[': 'bracket', ']': 'bracket',
  '{': 'curly', '}': 'curly', 'B': 'curly',
  '<': 'angle', '>': 'angle',
};
const objectBindings = { 'i': { label: 'inner' }, 'a': { label: 'outer' } };
for (const [k, name] of Object.entries(textObjects)) {
  objectBindings[`i ${k}`] = `vim-inner-${name}`;
  objectBindings[`a ${k}`] = `vim-a-${name}`;
}
defineKey({ keymaps: 'global', states: ['operator', 'visual'] }, objectBindings);

defineKey({ keymaps: 'global', states: 'operator' }, {
  'ESC': 'vim-normal-state',
  '~': 'vim-operator-line-case',
  'u': 'vim-operator-line-case',
  'U': 'vim-operator-line-case',
});

// ---------------------------------------------------------------------------
// Normal state

defineKey({ keymaps: 'global', states: 'normal' }, {
  'ESC': 'vim-normal-state',
  'i': 'vim-insert',
  'a': 'vim-append',
  'I': 'vim-insert-line',
  'A': 'vim-append-line',
  'o': 'vim-open-below',
  'O': 'vim-open-above',
  'R': 'vim-replace-state',
  'x': 'vim-delete-char',
  'X': 'vim-delete-backward-char',
  '<delete>': 'vim-delete-char',
  's': 'vim-substitute',
  'S': 'vim-change-whole-line',
  'C': 'vim-change-line',
  'D': 'vim-delete-line',
  'Y': 'vim-yank-line',
  'p': 'vim-paste-after',
  'P': 'vim-paste-before',
  'r': 'vim-replace',
  '~': 'vim-invert-char',
  'J': 'vim-join',
  'u': 'vim-undo',
  'C-r': 'vim-redo',
  '.': 'vim-repeat',
  'm': 'vim-set-marker',
  '"': 'vim-use-register',
  'v': 'vim-visual-char',
  'V': 'vim-visual-line',
  'C-v': 'vim-visual-block',
  ':': 'vim-ex',
  'C-o': 'vim-jump-backward',
  'C-i': 'vim-jump-forward',
  'C-d': 'vim-scroll-down',
  'C-u': 'vim-scroll-up',
  'C-f': 'vim-scroll-page-down',
  'C-b': 'vim-scroll-page-up',
  'C-e': 'vim-scroll-line-down',
  'C-y': 'vim-scroll-line-up',
  'g J': 'vim-join-whitespace',
  'g i': 'vim-insert-resume',
  'g v': 'vim-visual-restore',
  'z': { label: 'scroll' },
  'z z': 'vim-scroll-line-to-center',
  'z t': 'vim-scroll-line-to-top',
  'z b': 'vim-scroll-line-to-bottom',
  'Z': { label: 'quit' },
  'Z Z': 'vim-save-and-close',
  'Z Q': 'vim-quit-without-save',
});

// ---------------------------------------------------------------------------
// Visual state

defineKey({ keymaps: 'global', states: 'visual' }, {
  'ESC': 'vim-normal-state',
  'C-g': 'vim-normal-state',
  'v': 'vim-visual-char',
  'V': 'vim-visual-line',
  'C-v': 'vim-visual-block',
  'o': 'vim-visual-exchange-corners',
  'O': 'vim-visual-exchange-corners',
  'x': 'vim-delete',
  'X': 'vim-visual-delete-lines',
  'D': 'vim-visual-delete-lines',
  's': 'vim-change',
  'S': 'vim-visual-change-lines',
  'R': 'vim-visual-change-lines',
  'C': 'vim-visual-change-lines',
  'Y': 'vim-visual-yank-lines',
  'I': 'vim-visual-insert',
  'A': 'vim-visual-append',
  'r': 'vim-replace',
  '~': 'vim-invert-case',
  'u': 'vim-downcase',
  'U': 'vim-upcase',
  'J': 'vim-join',
  'p': 'vim-paste-after',
  'P': 'vim-paste-before',
  '"': 'vim-use-register',
  ':': 'vim-ex',
  'g J': 'vim-join-whitespace',
  's-c': 'vim-yank',
});

// ---------------------------------------------------------------------------
// Insert and replace state

defineKey({ keymaps: 'global', states: ['insert', 'replace'] }, {
  'ESC': 'vim-normal-state',
  '<left>': 'backward-char',
  '<right>': 'forward-char',
  '<up>': 'previous-line',
  '<down>': 'next-line',
  '<home>': 'beginning-of-line',
  '<end>': 'end-of-line',
});

defineKey({ keymaps: 'global', states: 'insert' }, {
  'DEL': 'delete-backward-char',
  'C-h': 'delete-backward-char',
  '<delete>': 'delete-char',
  'RET': 'newline',
  'TAB': 'indent-for-tab-command',
  'C-w': 'vim-delete-backward-word',
  'C-u': 'vim-delete-back-to-indentation',
  'C-r': 'vim-paste-register-insert',
  'C-t': 'vim-shift-right-line',
  'C-d': 'vim-shift-left-line',
});

defineKey({ keymaps: 'global', states: 'replace' }, {
  'DEL': 'vim-replace-backspace',
  'RET': 'newline',
});

// ---------------------------------------------------------------------------
// System clipboard. macOS uses Cmd-C / Cmd-V (handled natively); elsewhere Ctrl-V pastes in
// insert state and Ctrl-Shift-V in every state (normal-state Ctrl-V stays visual block).
// Copy with y (yanks always reach the system clipboard) or Ctrl-Shift-C; plain Ctrl-C is
// left unbound in visual state.

if (!isMac) {
  defineKey({ keymaps: 'global', states: ['insert', 'replace'] }, { 'C-v': 'clipboard-paste' });
  defineKey({ keymaps: 'global', states: ['normal', 'visual', 'insert', 'replace'] }, { 'C-S-v': 'clipboard-paste' });
  defineKey({ keymaps: 'global', states: 'visual' }, { 'C-S-c': 'vim-yank' });
}
