import { defineKey } from '../core/keymap.js';

defineKey({ keymaps: 'treesit-mode-map', states: ['operator', 'visual'] }, {
  'i f': 'vim-inner-function',
  'a f': 'vim-a-function',
  'i c': 'vim-inner-class',
  'a c': 'vim-a-class',
  'i a': 'vim-inner-argument',
  'a a': 'vim-a-argument',
});

defineKey({ keymaps: 'treesit-mode-map', states: ['normal', 'visual', 'operator'] }, {
  '] f': 'vim-next-function-start',
  '[ f': 'vim-previous-function-start',
  '] c': 'vim-next-class-start',
  '[ c': 'vim-previous-class-start',
});

defineKey({ keymaps: 'global', states: ['normal', 'visual'], prefix: 'SPC' }, {
  'h t': { label: 'tree-sitter' },
  'h t i': 'treesit-inspect-node',
  'h t e': 'treesit-explore',
  't h': 'treesit-toggle-highlighting',
});
