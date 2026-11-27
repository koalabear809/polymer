# Polymer

A buffer-centric, Emacs-like environment built on Tauri, with vim keys,
general.el-style keybindings, helm-style completion, and a live, redefinable
JavaScript runtime. See [PLAN.md](PLAN.md) for the design and roadmap.

## Installing

Download the latest build for your system from the
[Releases page](https://github.com/koalabear809/polymer/releases/latest):

| System | File |
|---|---|
| macOS, Apple Silicon (M1 and later) | `Polymer_<version>_aarch64.dmg` |
| macOS, Intel | `Polymer_<version>_x64.dmg` |
| Windows | `Polymer_<version>_x64-setup.exe` (or the `.msi`) |
| Linux | `Polymer_<version>_amd64.AppImage` (`chmod +x` it) or the `.deb` |

The builds aren't code-signed, so the first launch needs one extra step:

- **macOS:** drag Polymer to Applications, then run `xattr -cr /Applications/Polymer.app`
  once in a terminal (or right-click → Open). It's needed once per install.
- **Windows:** in the SmartScreen dialog choose *More info* → *Run anyway*.
- **Linux:** none.

Polymer checks for updates a few seconds after starting and asks before installing; run
`SPC h u` (`M-x check-for-updates`) to check yourself. Maintainers: see
[RELEASING.md](RELEASING.md).

## Running from source

Requires Rust and the Tauri CLI (`cargo install tauri-cli --version "^2" --locked`).

```sh
cd src-tauri
cargo tauri dev
```

The frontend in `src/` is plain ES modules with no build step. `cargo tauri dev`
serves it straight from disk and reloads the window when files change. `SPC q r`
also reloads it from inside the app.

## Configuration

Polymer reads `~/.polymer/` (or `$POLYMER_CONFIG_DIR`):

```
~/.polymer/
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

- Insert state sends every key to the program. `ESC` (or `C-\ C-n`) enters **copy mode**:
  the whole scrollback becomes text for vim motions, `/` search, `v`/`V` and `y`; dragging
  the mouse selects too. `p` pastes into the terminal; `i` or `a` returns to the prompt.
  In full-screen programs (vim, htop, less) `ESC` goes to the program
  (`term-escape-passthrough-in-fullscreen`); `C-\ ESC` always sends `ESC`.
  The mouse wheel scrolls history (or sends arrows in full-screen programs).
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

## Git

`SPC g g` opens a magit-style status buffer for the current buffer's repository. It's
plain text, so vim motions and search work; commands act on the line at point.

- `TAB` expand a file's diff (or collapse a section), `RET` open the file at that line
  (or show a commit/stash), `g j` / `g k` (or `C-j` / `C-k`) jump between items
- `s` / `u` / `x` stage, unstage, discard the section, file or **hunk** at point;
  `S` / `U` stage or unstage everything; `g r` refresh; `$` the git process log
- Menus (pause for which-key): `c` commit (`c c`, `c a` amend, `c e` extend),
  `P` push, `F` pull, `f` fetch, `b` branch (`b b` checkout, `b c` create, `b k` delete),
  `l` log, `z` stash (`z z`, `z p`, `z a`, `z k`)
- The commit buffer: `C-c C-c` or `ZZ` commits, `C-c C-k` or `ZQ` cancels
- From any file: `SPC g S` / `SPC g U` stage or unstage it, `SPC g L` its history,
  `SPC g l` the log, `SPC g c` commit, `SPC g b` checkout, `SPC g p` push

## Agents (ACP)

`SPC a a` opens Claude Code for the current project (via
`npx @agentclientprotocol/claude-agent-acp`; needs Node.js and a Claude login: run `claude` in
a terminal and `/login` once). Any ACP agent can be added with `defineAgent`.

- Type after `❯`; `RET` (insert state) or `C-j` adds a newline, and `C-c C-c` (or `RET` in normal state) sends.
  Mention files with `@path`. `C-c C-k` cancels, `C-c m` switches mode (e.g. plan),
  `C-c n` new conversation, `C-c /` slash commands. `RET` on a tool line opens its file.
  The input is ordinary text for vim: `o`/`O` open lines, `dd`, `yy`, `cc`, `p`, `u` and
  motions work on it (the transcript above stays read-only).
- The agent reads files through your buffers (it sees unsaved edits) and writes through
  them too (each edit is one undo step, then saved). Its shell commands run as processes
  whose output shows under the tool call. Permission requests appear as a helm prompt.
- Replies are shown as formatted Markdown (headings, lists, tables, highlighted code;
  `agent-render-markdown` false shows the raw text). Images the agent sends, image tool
  results and `![](local/file.png)` references are shown inline (remote images aren't loaded).
- The header line shows `agent-header-fields`, in order: any of `model`, `effort`, `mode`,
  `tokens`, `context` (context window used / size) and `cost` (the session's total, as the
  agent reports it). E.g. `setq('agent-header-fields', ['model', 'effort', 'context', 'cost'])`.
- Paste an image (a screenshot, say) into the input to send it with your message: it is
  attached as `[image #1]` with a preview above the input; delete that text to drop it.
- From any file: `SPC a f` adds `@file` (and the selected lines) to the agent's input.
- Conversations are saved as Markdown in `.polymer/agent/` under the agent's directory
  (`<start time>-<agent>.md`; tool calls with diffs and output, plans). `SPC a t` opens the
  current one, `SPC a T` browses them. Options: `agent-save-transcripts`,
  `agent-transcript-directory`.

## MCP server (agents controlling the editor)

Polymer runs an MCP server on `127.0.0.1` (streamable HTTP, random bearer token). Agents
started with `SPC a a` are connected to it automatically. Tools:

| Tool | |
|---|---|
| `list_buffers`, `get_buffer_text` | open buffers and their text, including unsaved edits |
| `get_editor_state` | current buffer, file, cursor, and the selection |
| `open_file` | show a file (at a line) in another window |
| `show_message` | a message in the echo area |
| `list_commands`, `run_command` | run commands in `mcp-commands` or defined with `{ mcp: true }` |
| `eval_js` | evaluate JavaScript in the editor; asks you each time (`mcp-allow-eval`) |

Add tools with `defineMcpTool(name, { description, inputSchema, handler })`.
`SPC h M` shows the URL and token for connecting other MCP clients.

## Themes

`SPC t t` (`load-theme`) picks a theme, previewing each as you move; the choice is
remembered. Bundled dark themes: Gruvbox Dark (default), Gruvbox Dark Hard, Tokyo Night,
Catppuccin Mocha, Nord, One Dark, Andromeda. Light: Gruvbox Light, Solarized Light,
Catppuccin Latte, One Light, GitHub Light. A theme sets the CSS variables in
`src/style.css` (UI, `--syn-*` syntax colors, `--term-0`..`--term-15`).

Themes are files, one per theme, named after it. Polymer copies the bundled ones into
`~/.polymer/themes/` (`custom-theme-directory`) at startup: all of them the first time,
and later any new in an update (a bundled theme whose file you deleted stays deleted).
Edit them or add your own there; saving a file in that directory reloads the themes
(`theme-reload-on-save`), or run `M-x reload-themes`. A file there replaces the bundled
theme with the same name, and deleting a file removes its theme on the next reload.

```js
// ~/.polymer/themes/my-theme.js
module.exports = {
  label: 'My Theme',
  base: 'gruvbox-dark',                // optional: start from another theme
  ui: { bg: '#1c1c1c', accent: '#7aa2f7' },
  syn: { keyword: '#ff79c6', variable: '#e0e0e0' },
  term: { 0: '#1c1c1c' },              // all 16 colors as an array, or some indexes
  colors: { '--region': '#333' },      // any CSS variable directly
};
```

`SPC h v custom-theme-directory` lists every key. Commands: `find-theme-file` opens a theme's file,
copying a bundled one there first. `install-default-themes` copies back bundled themes
that are missing.

The API: `defineTheme(name, spec)`, `loadTheme(name)`, `getTheme(name)`, `themeList()`,
`currentTheme()`, `themeColor('--bg')`, `loadThemeFile(path)`, `loadThemes()`,
`themeDirectory()`, `installDefaultThemes()`, and `after-load-theme-hook`, which is called
with the theme's name. In `init.js`:

```js
setq('theme', 'andromeda')                  // overrides the remembered choice
defineTheme('my-dark', { base: 'nord', ui: { bg: '#1c1c1c' } })
addHook('after-load-theme-hook', (name) => message('Theme: %s', name))
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
  themes/             theme API; builtin/ holds the bundled theme files
  persp/              perspectives
  git/                git interface
  agent/              ACP client and agent buffers
  mcp/                the editor's MCP tools
  grammars/           bundled tree-sitter grammars and highlight queries
  vendor/             vendored third-party modules (web-tree-sitter)
src-tauri/            Rust backend (files, processes, terminals, MCP server)
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
- `SPC f d` opens **dired** on the current file's directory (cursor on the file); opening any
  directory does too. It's plain text, so all vim motions and `/` search work. `RET` opens
  a file in this window (or moves into a directory), `-` or `DEL` goes up a directory, `m` / `u` /
  `U` mark, `d` flags and `x` deletes flagged, `D` delete, `R` rename/move, `C` copy,
  `o` / `O` new file / directory, `g r` refresh, `g h` hidden files. With a visual
  selection (`V`), `m` `u` `d` `D` `R` `C` act on every selected entry.
- **Images** (PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, SVG) open as pictures from find-file,
  dired or `:e`: `+`/`-` zoom, `0` fit, `1` actual size, `r`/`R` rotate, `n`/`p` next or
  previous image in the directory, `h j k l` pan (wheel scrolls, `C-wheel` zooms), `g r`
  reload. Other file types can open their own way with `defineFileHandler`.
- `SPC f f` find file: `RET` opens a file, or a directory in dired; `TAB` enters a
  directory (on a file it shows actions); `C-l` or `DEL` at a `/` goes up;
  `SPC f s` / `Cmd-S` save, `SPC f S` save as, `SPC f r` recent files, `SPC b r` revert
- `M-x` / `SPC :` run a command; `SPC e l` / `SPC e b` evaluate line / buffer as JavaScript
- System clipboard: `y` copies to it (deletes too, unless `vim-clipboard` is false). On
  Windows and Linux, `C-v` pastes in insert state; `C-S-v` pastes in any state and
  `C-S-c` copies a visual selection. On macOS, Cmd-V / Cmd-C.
- `SPC h f` / `SPC h v` / `SPC h k` describe a function / variable / key
- `SPC b b` switch buffers; in helm: `C-j`/`C-k` move, `TAB` actions, `C-SPC` mark,
  `C-z` preview, `Esc` for normal state (`j`/`k`, `gg`/`G`), `C-g` quit
- `SPC w v` / `SPC w s` split; `C-w h/j/k/l` move between windows

## License

MIT; see [LICENSE](LICENSE). Bundled third-party code: [THIRD-PARTY.md](THIRD-PARTY.md).
