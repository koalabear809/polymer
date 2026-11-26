// Major modes for common file types. Phase 2 adds tree-sitter highlighting to these.

import { defineMajorMode } from '../core/modes.js';
import { setq, getVarOr } from '../core/registry.js';

defineMajorMode('prog-mode', { doc: 'Parent mode for programming languages.' });
defineMajorMode('text-mode', { doc: 'Parent mode for prose.' });

const LANGUAGES = [
  // [mode, parent, lighter, file-name regexps]
  ['js-mode', 'prog-mode', 'JS', [/\.(m|c)?jsx?$/]],
  ['typescript-mode', 'prog-mode', 'TS', [/\.(m|c)?tsx?$/]],
  ['json-mode', 'prog-mode', 'JSON', [/\.json$/, /\.jsonc$/, /^\.(babel|eslint|prettier)rc$/]],
  ['css-mode', 'prog-mode', 'CSS', [/\.css$/, /\.scss$/]],
  ['html-mode', 'prog-mode', 'HTML', [/\.html?$/, /\.svelte$/, /\.vue$/]],
  ['rust-mode', 'prog-mode', 'Rust', [/\.rs$/]],
  ['python-mode', 'prog-mode', 'Python', [/\.py$/, /\.pyi$/]],
  ['go-mode', 'prog-mode', 'Go', [/\.go$/]],
  ['c-mode', 'prog-mode', 'C', [/\.[ch]$/]],
  ['c++-mode', 'prog-mode', 'C++', [/\.(cc|cpp|cxx|hh|hpp|hxx)$/]],
  ['sh-mode', 'prog-mode', 'Sh', [/\.(sh|bash|zsh|fish)$/, /^\.(bash|zsh)rc$/, /^\.(bash_)?profile$/]],
  ['toml-mode', 'prog-mode', 'TOML', [/\.toml$/, /^Cargo\.lock$/]],
  ['yaml-mode', 'prog-mode', 'YAML', [/\.ya?ml$/]],
  ['lua-mode', 'prog-mode', 'Lua', [/\.lua$/]],
  ['emacs-lisp-mode', 'prog-mode', 'ELisp', [/\.el$/]],
  ['makefile-mode', 'prog-mode', 'Make', [/^(GNU)?[Mm]akefile$/, /\.mk$/]],
  ['markdown-mode', 'text-mode', 'Markdown', [/\.(md|markdown)$/]],
  ['org-mode', 'text-mode', 'Org', [/\.org$/]],
];

const alist = [...getVarOr('auto-mode-alist', [], null)];
for (const [mode, parent, lighter, patterns] of LANGUAGES) {
  defineMajorMode(mode, { parent, lighter, doc: `Major mode for ${lighter} files.` });
  for (const re of patterns) alist.push([re, mode]);
}
alist.push([/\.(txt|text|log)$/, 'text-mode']);
setq('auto-mode-alist', alist, null);

// *scratch* holds JavaScript you can evaluate (like lisp-interaction-mode).
defineMajorMode('scratch-mode', { parent: 'js-mode', lighter: 'JS Scratch', doc: 'Mode for *scratch*: write JavaScript and evaluate it with SPC e b / SPC e l.' });
