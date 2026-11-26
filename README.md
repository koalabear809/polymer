# Polymer

A buffer-centric, Emacs-like environment built on Tauri, with vim keys,
general.el-style keybindings, helm-style completion, and a live, redefinable
JavaScript runtime. See [PLAN.md](PLAN.md) for the design and roadmap.

## Running

Requires Rust and the Tauri CLI (`cargo install tauri-cli --version "^2" --locked`).

```sh
cd src-tauri
cargo tauri dev
```

The frontend in `src/` is plain ES modules with no build step. `cargo tauri dev`
serves it straight from disk and reloads the window when files change. `SPC q r`
also reloads it from inside the app.

## Configuration

Polymer reads `~/.config/polymer/` (or `$POLYMER_CONFIG_DIR`):

```
~/.config/polymer/
  init.js                  evaluated at startup
  packages/<name>/         one directory per package
    package.json           optional: description, version, main, dependencies
    index.js
    data/                  the package's own files (packageDataDir('<name>'))
  var/state.json           recent files and histories (written automatically)
```

- `SPC f p` opens `init.js` (from a template if it doesn't exist; nothing is written until
  you save). `SPC h r r` re-runs it.
- Files run as modules with `module`, `exports`, `require`, `load`, `__filename` and
  `__dirname` in scope, plus every Polymer global. `require` is async:
  `const util = await require('./util.js')` or `await require('my-package')`.
- `await usePackage('name', { init() {}, config(exports) {} })` loads a package use-package
  style; a failing package is reported and the rest of `init.js` keeps going.
- `M-x create-package` scaffolds a package, `SPC h p` lists packages (load, reload, open),
  `SPC h r p` reloads one after editing. `SPC e b` in a file buffer evaluates it as a module.
- Start with `POLYMER_NO_INIT=1` (or `-q`) to skip `init.js`.

## Syntax (tree-sitter)

Buffers in a language with a bundled grammar get `treesit-mode` (shown as `TS` in the mode
line): incremental parsing and highlighting of the visible lines. Bundled: JavaScript,
TypeScript, TSX, JSON, CSS, HTML, Python, Rust, Go, C, C++, Bash, Lua, TOML, YAML
(`src/grammars/`; each loads the first time it's needed).

- Text objects: `if`/`af` function, `ic`/`ac` class (struct, impl, interface, enum, trait),
  `ia`/`aa` argument or parameter. Motions: `]f` `[f` `]c` `[c`.
- `SPC h t i` shows the node at point, `SPC h t e` the whole tree; `SPC t h` toggles highlighting.
- Add a language from a package:
  ```js
  defineTreesitLanguage('zig', {
    wasm: __dirname + 'tree-sitter-zig.wasm',
    highlights: __dirname + 'highlights.scm',
    modes: ['zig-mode'],
  })
  ```

## Terminals

`SPC o t` opens a terminal (your login shell, in the buffer's directory); `SPC o T` in
another window; `SPC b t` lists terminals. Built on `portable-pty` (ConPTY on Windows) and
`alacritty_terminal`, rendered by Polymer's own view.

- Insert state sends every key to the program. `C-\ C-n` enters **copy mode**: the whole
  scrollback becomes text for vim motions, `/` search and `y`; `p` pastes into the terminal,
  `i` returns. The mouse wheel scrolls history (or sends arrows in full-screen programs).
- Shells run in the backend, so `SPC q r` (reload) re-attaches to them.
- Options: `term-shell`, `term-shell-args`; hooks: `term-mode-hook`, `term-exit-hook`,
  `term-bell-hook`. Add keys that work while the terminal has focus to `term-raw-map`.

## Perspectives

Named workspaces with their own buffer list and window layout (like perspective.el).
You start in `main`; the mode line shows `[name]` once there are several.

- `SPC TAB TAB` switch (type a new name to create), `SPC TAB n` new, `SPC TAB d` delete
  (also kills buffers only it had), `SPC TAB r` rename, `SPC TAB 1`..`9`, `SPC TAB [` `]`
- `SPC TAB a` / `x` add or remove a buffer. `SPC b b` shows this perspective's buffers
  first and the rest under "Other perspectives".
- `SPC TAB s` / `l` save or load the current perspective; `SPC TAB S` / `L` a whole
  session; `SPC TAB R` loads the session saved automatically on quit. Files go to
  `var/perspectives/`. File buffers keep their path and cursor, terminals their directory
  (a fresh shell starts there), text buffers like `*scratch*` their contents.
- Packages can save their own buffers with `defineBufferSerializer(kind, { serialize, restore })`.

## Themes

`SPC t t` (`load-theme`) picks a theme, previewing each as you move; the choice is
remembered. Bundled: Gruvbox Dark (default), Gruvbox Dark Hard, Tokyo Night,
Catppuccin Mocha, Nord, One Dark. A theme sets the CSS variables in `src/style.css`
(UI, `--syn-*` syntax colors, `--term-0`..`--term-15`). In `init.js`:

```js
setq('theme', 'nord')                       // overrides the remembered choice
defineTheme('my-theme', { base: 'gruvbox-dark', colors: { '--bg': '#1c1c1c' } })
```

## Windows

Drag the divider between windows to resize them (double-click evens them out), or use
`C-w +` `C-w -` `C-w >` `C-w <` with counts, `C-w _` / `C-w |` to maximize, `C-w =` to
balance (also under `SPC w`).

## Layout

```
src/                  frontend (plain JS, no bundler)
  main.js             boot
  core/               registry, keymaps, command loop, buffers, windows, helm, ...
  commands/           built-in commands, help, default key bindings
  vim/                vim layer (motions, operators, text objects, ex, search)
  syntax/             tree-sitter integration
  terminal/           terminal buffers (frontend)
  themes/             color themes
  persp/              perspectives
  grammars/           bundled tree-sitter grammars and highlight queries
  vendor/             vendored third-party modules (web-tree-sitter)
src-tauri/            Rust backend (files, terminals)
```

## Trying it out

- `SPC` leader key; pause for which-key
- Vim: motions (`w b e ge W B E`, `f t F T ; ,`, `0 ^ $ g_`, `gg G`, `{ }`, `%`, `H M L`),
  operators (`d c y > < g~ gu gU`) with counts and text objects
  (`iw aw iW aW i" a" i' a' i( a( i[ a[ i{ a{ i< a< ip ap`), `x X s S C D Y p P r ~ J gJ`,
  visual (`v V C-v`, block `I`/`A`), registers (`"a`, `"A`, `"0`-`"9`, `"_`, `"+`), `.` repeat,
  `u`/`C-r` (a whole change undoes at once), marks (`m` `` ` `` `'`), `C-o`/`C-i`, `R`, `gi`, `gv`,
  `zz zt zb`, `C-d C-u C-f C-b C-e C-y`
- Search: `/` `?` (incremental), `n` `N` `*` `#`; `Esc` or `:noh` clears highlights
- Ex: `:w :q :wq :x :qa :e file :sp :vs :b name :bd`, `:%s/a/b/g`, `:g/pat/d`, `:%norm A;`,
  `:sort`, `:set ts=2 rnu`, `:reg`, `:marks`, `:js 1 + 2`, `:mode rust`
- `SPC f f` find file (`RET` enters a directory, `C-l` or `DEL` at a `/` goes up),
  `SPC f s` / `Cmd-S` save, `SPC f S` save as, `SPC f r` recent files, `SPC b r` revert
- `M-x` / `SPC :` run a command; `SPC e l` / `SPC e b` evaluate line / buffer as JavaScript
- `SPC h f` / `SPC h v` / `SPC h k` describe a function / variable / key
- `SPC b b` switch buffers; in helm: `C-j`/`C-k` move, `TAB` actions, `C-SPC` mark,
  `C-z` preview, `Esc` for normal state (`j`/`k`, `gg`/`G`), `C-g` quit
- `SPC w v` / `SPC w s` split; `C-w h/j/k/l` move between windows
