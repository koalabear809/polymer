// Default key bindings (Doom-flavoured). Override any of these from init.js with defineKey.

import { defineKey } from '../core/keymap.js';

// Available in every state and context.
defineKey({ keymaps: 'global' }, {
  'M-x': 'execute-extended-command',
  'M-:': 'eval-expression',
  'C-g': 'keyboard-quit',
  's-s': 'save-buffer',
});

// Leader key.
defineKey({ keymaps: 'global', states: ['normal', 'visual'], prefix: 'SPC' }, {
  ':': 'execute-extended-command',
  ';': 'eval-expression',
  '.': 'find-file',
  ',': 'switch-to-buffer',
  '`': 'previous-buffer',

  'f': { label: 'files' },
  'f f': 'find-file',
  'f s': 'save-buffer',
  'f S': 'write-file',
  'f r': 'recentf-open-files',
  'f y': 'copy-file-path',
  'f p': 'find-init-file',
  'f P': 'open-config-directory',

  'b': { label: 'buffers' },
  'b b': 'switch-to-buffer',
  'b k': 'kill-buffer',
  'b d': 'kill-current-buffer',
  'b n': 'next-buffer',
  'b p': 'previous-buffer',
  'b r': 'revert-buffer',
  'b s': 'save-buffer',
  'b x': 'switch-to-scratch-buffer',
  'b m': 'view-echo-area-messages',

  'e': { label: 'eval' },
  'e e': 'eval-expression',
  'e b': 'eval-buffer',
  'e l': 'eval-line',

  'w': { label: 'windows' },
  'w s': 'split-window-below',
  'w v': 'split-window-right',
  'w S': 'split-window-below-and-focus',
  'w V': 'split-window-right-and-focus',
  'w d': 'delete-window',
  'w c': 'delete-window',
  'w m': 'delete-other-windows',
  'w o': 'delete-other-windows',
  'w w': 'other-window',
  'w h': 'windmove-left',
  'w j': 'windmove-down',
  'w k': 'windmove-up',
  'w l': 'windmove-right',
  'w =': 'balance-windows',
  'w +': 'enlarge-window',
  'w -': 'shrink-window',
  'w >': 'enlarge-window-horizontally',
  'w <': 'shrink-window-horizontally',
  'w _': 'maximize-window-vertically',
  'w |': 'maximize-window-horizontally',

  'h': { label: 'help' },
  'h f': 'describe-function',
  'h x': 'describe-command',
  'h v': 'describe-variable',
  'h k': 'describe-key',
  'h m': 'describe-mode',
  'h e': 'view-echo-area-messages',
  'h V': 'polymer-version',
  'h p': 'list-packages',
  'h M': 'mcp-connection-info',
  'h r': { label: 'reload' },
  'h r r': 'reload-init-file',
  'h r p': 'reload-package',

  't': { label: 'toggles' },
  't d': 'toggle-debug-on-error',
  't t': 'load-theme',

  'q': { label: 'quit/reload' },
  'q r': 'reload-polymer',
  'q q': 'save-buffers-kill-polymer',

  's': { label: 'search' },
  's c': 'vim-ex-nohighlight',
});

// Vim window keys and buffer cycling.
defineKey({ keymaps: 'global', states: ['normal', 'visual'] }, {
  'C-w': { label: 'window' },
  'C-w s': 'split-window-below',
  'C-w v': 'split-window-right',
  'C-w c': 'delete-window',
  'C-w q': 'delete-window',
  'C-w o': 'delete-other-windows',
  'C-w w': 'other-window',
  'C-w h': 'windmove-left',
  'C-w j': 'windmove-down',
  'C-w k': 'windmove-up',
  'C-w l': 'windmove-right',
  'C-w =': 'balance-windows',
  'C-w +': 'enlarge-window',
  'C-w -': 'shrink-window',
  'C-w >': 'enlarge-window-horizontally',
  'C-w <': 'shrink-window-horizontally',
  'C-w _': 'maximize-window-vertically',
  'C-w |': 'maximize-window-horizontally',
  ']': { label: 'next' },
  '] b': 'next-buffer',
  '[': { label: 'previous' },
  '[ b': 'previous-buffer',
});

// Read-only buffers.
defineKey({ keymaps: 'special-mode-map', states: 'normal' }, {
  'q': 'quit-window',
});
