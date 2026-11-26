# Bundled tree-sitter grammars

Prebuilt `.wasm` grammars and highlight queries, copied from their npm packages
(all MIT licensed; each directory has its LICENSE). They load lazily, the first time a
buffer needs that language. Runtime: `web-tree-sitter` 0.27.2 in `src/vendor/web-tree-sitter/`.

`highlights.scm` files concatenate a grammar's query files from general to specific,
because when several patterns capture the same node the later one wins (JavaScript's base
queries come before TypeScript's, C's before C++'s).

| Language | Source |
|---|---|
| javascript | `tree-sitter-javascript` 0.25.0 |
| typescript | `tree-sitter-typescript` 0.23.2 |
| tsx | `tree-sitter-typescript` 0.23.2 |
| json | `tree-sitter-json` 0.24.8 |
| css | `tree-sitter-css` 0.25.0 |
| html | `tree-sitter-html` 0.23.2 |
| python | `tree-sitter-python` 0.25.0 |
| rust | `tree-sitter-rust` 0.24.0 |
| go | `tree-sitter-go` 0.25.0 |
| c | `tree-sitter-c` 0.24.1 |
| cpp | `tree-sitter-cpp` 0.23.4 |
| bash | `tree-sitter-bash` 0.25.1 |
| lua | `@tree-sitter-grammars/tree-sitter-lua` 0.4.1 |
| toml | `@tree-sitter-grammars/tree-sitter-toml` 0.7.0 |
| yaml | `@tree-sitter-grammars/tree-sitter-yaml` 0.7.1 |

To add a language from a package instead, see `defineTreesitLanguage` in
`src/syntax/treesit.js`.
