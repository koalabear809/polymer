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

## Layout

```
src/                  frontend (plain JS, no bundler)
  main.js             boot
  core/               registry, keymaps, command loop, buffers, windows, helm, ...
  commands/           built-in commands, help, default key bindings
  vendor/             vendored third-party modules (none yet)
src-tauri/            Rust backend
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
