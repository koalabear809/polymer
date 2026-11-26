// Git key bindings (evil-collection-magit style). Prefix keys act like magit's menus:
// pause after c, P, F, f, b, l or z and which-key lists the choices.

import { defineKey } from '../core/keymap.js';

defineKey({ keymaps: 'git-status-mode-map', states: 'normal' }, {
  'TAB': 'git-toggle-section',
  'RET': 'git-visit',
  's': 'git-stage',
  'u': 'git-unstage',
  'S': 'git-stage-all',
  'U': 'git-unstage-all',
  'x': 'git-discard',
  'g r': 'git-refresh',
  'g j': 'git-next-section',
  'g k': 'git-previous-section',
  'C-j': 'git-next-section',
  'C-k': 'git-previous-section',
  '$': 'git-process-buffer',
  'c': { label: 'commit' },
  'c c': 'git-commit',
  'c a': 'git-commit-amend',
  'c e': 'git-commit-extend',
  'P': { label: 'push' },
  'P p': 'git-push',
  'P f': 'git-push-force',
  'F': { label: 'pull' },
  'F p': 'git-pull',
  'F r': 'git-pull-rebase',
  'f': { label: 'fetch' },
  'f f': 'git-fetch',
  'f a': 'git-fetch-all',
  'b': { label: 'branch' },
  'b b': 'git-checkout',
  'b c': 'git-branch-create',
  'b k': 'git-branch-delete',
  'l': { label: 'log' },
  'l l': 'git-log',
  'l a': 'git-log-all',
  'z': { label: 'stash' },
  'z z': 'git-stash',
  'z p': 'git-stash-pop',
  'z a': 'git-stash-apply',
  'z k': 'git-stash-drop',
});

defineKey({ keymaps: 'git-log-mode-map', states: 'normal' }, {
  'RET': 'git-log-visit',
  'g r': 'git-log',
  '$': 'git-process-buffer',
});

defineKey({ keymaps: 'git-revision-mode-map', states: 'normal' }, {
  '$': 'git-process-buffer',
});

defineKey({ keymaps: 'git-commit-mode-map', states: ['normal', 'insert'] }, {
  'C-c': { label: 'commit' },
  'C-c C-c': 'git-commit-finish',
  'C-c C-k': 'git-commit-cancel',
});

defineKey({ keymaps: 'git-commit-mode-map', states: 'normal' }, {
  'Z Z': 'git-commit-finish',
  'Z Q': 'git-commit-cancel',
});

defineKey({ keymaps: 'global', states: ['normal', 'visual'], prefix: 'SPC' }, {
  'g': { label: 'git' },
  'g g': 'git-status',
  'g S': 'git-stage-file',
  'g U': 'git-unstage-file',
  'g c': 'git-commit',
  'g l': 'git-log',
  'g L': 'git-log-file',
  'g b': 'git-checkout',
  'g p': 'git-push',
  'g F': 'git-pull',
  'g f': 'git-fetch',
  'g $': 'git-process-buffer',
});
