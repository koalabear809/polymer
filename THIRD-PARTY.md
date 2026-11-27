# Third-party software

Polymer bundles the following, each under its own license (license files are included
next to the code where the upstream project provides one).

- **web-tree-sitter** (MIT): `src/vendor/web-tree-sitter/`
- **Tree-sitter grammars** (MIT): `src/grammars/<language>/`, prebuilt `.wasm` files and
  highlight queries from the tree-sitter-* projects; versions are listed in
  `src/grammars/README.md`.
- **Rust crates** (compiled into the app), notably Tauri (MIT/Apache-2.0),
  portable-pty (MIT), alacritty_terminal (Apache-2.0), tiny_http (MIT/Apache-2.0) and
  getrandom (MIT/Apache-2.0). See `src-tauri/Cargo.lock` for the full list.
