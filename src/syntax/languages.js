// Bundled tree-sitter languages (src/grammars). Each loads the first time it's needed.

import { defineTreesitLanguage } from './treesit.js';

const bundled = (name, modes, extra = {}) => defineTreesitLanguage(name, {
  wasm: `app:grammars/${name}/${name}.wasm`,
  highlights: `app:grammars/${name}/highlights.scm`,
  modes,
  ...extra,
});

bundled('javascript', ['js-mode']);
bundled('typescript', ['typescript-mode']);
bundled('tsx', ['typescript-mode'], { filePattern: /\.tsx$/ });
bundled('json', ['json-mode']);
bundled('css', ['css-mode']);
bundled('html', ['html-mode']);
bundled('python', ['python-mode']);
bundled('rust', ['rust-mode']);
bundled('go', ['go-mode']);
bundled('c', ['c-mode']);
bundled('cpp', ['c++-mode']);
bundled('bash', ['sh-mode']);
bundled('lua', ['lua-mode']);
bundled('toml', ['toml-mode']);
bundled('yaml', ['yaml-mode']);
