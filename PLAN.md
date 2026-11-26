# Polymer — Plan

An Emacs-like, buffer-centric editing environment built on Tauri, with vim keys,
general.el-style keybindings, a helm-style completion interface, and a live,
redefinable JavaScript runtime.

## Principles

- **The extension language owns the editor.** Buffers, windows, keymaps, commands,
  variables, modes, perspectives and all UI live in the JS runtime, so anything can
  be redefined while the editor runs. Rust does only system work.
- **Late binding by name.** Keymaps, hooks and callers refer to commands by *name*
  (like Emacs symbols). Redefining a command takes effect everywhere immediately.
- **Everything is a buffer.** Special views (git status, help, agent chat, terminal)
  are buffers rendered by the same text view wherever possible, so vim motions,
  search and yank work everywhere.
- **Light, fast, simple.** Plain JavaScript (no TypeScript), plain ES modules, no
  bundler, no build step. Frontend dependencies only when clearly worth it, vendored
  as single files under `src/vendor/`. Rust crates are fine for system-level work.

## Decisions

| Area | Decision |
|---|---|
| Language | Plain JS everywhere in the frontend; user config is `init.js`. No Lisp layer. |
| Build | No bundler. Tauri serves `src/` directly; Tauri API via `window.__TAURI__`. |
| Editor core | Own implementation (no CodeMirror). |
| Vim | Own modal layer; motions/operators/text objects are registry commands. |
| Completion | Own helm-style engine: multi-source, multi-pattern matching, actions, marking, preview, async sources. |
| Tree-sitter | `web-tree-sitter` (WASM) in a Web Worker. Packages can ship grammar `.wasm` files. |
| Terminal | `portable-pty` + `alacritty_terminal` in Rust; grid rendered by our own view. Fallback: xterm.js. |
| Git | Shell out to the `git` CLI (porcelain output), like magit. |
| Project search | Rust `ignore` + `grep` crates (ripgrep's libraries), streamed into helm. |
| Agents | ACP client, hand-written JSON-RPC over stdio. Rust owns process lifetime. Claude Code via `claude-code-acp`. |
| MCP | Server hosted in Rust on localhost, passed to agents in ACP `session/new`. Tool calls forwarded to the JS registry; commands opt in with `mcp: true`. |
| Frontend framework | None. Plain DOM. |

## Architecture

```
┌────────────────────── Webview (JS) ──────────────────────┐
│ registry: commands · variables · hooks · advice · features│
│ keymaps + dispatcher (states, leader, which-key)          │
│ buffers · markers · overlays · undo                       │
│ windows (split tree) · mode line · echo area              │
│ helm engine · vim layer · modes · perspectives            │
│ packages loader (init.js, packages/*)                     │
└──────────────── Tauri IPC (invoke / channels) ───────────┘
┌────────────────────── Rust (Tauri) ──────────────────────┐
│ file I/O + watching · PTYs + terminal emulation           │
│ child processes (agents, git) · project file/grep search  │
│ MCP server (localhost)                                    │
└───────────────────────────────────────────────────────────┘
```

Long-lived processes (terminals, agents) live in Rust, so reloading the webview acts
like restarting the Lisp image: the frontend re-attaches to running sessions.

### Runtime API (sketch)

```js
defcommand('find-file', { doc: '...', interactive: async () => [await readFileName()] },
  async (path) => { ... })
defun('buffer-file-name', (buf) => ...)
defvar('tab-width', 4, { doc: '...' })        // does not clobber an existing value
setq('tab-width', 2)
addHook('after-save-hook', 'format-buffer')
advice('save-buffer', 'before', 'trim-whitespace')
call('find-file', '/tmp/x.js')                // always resolves by name

defineKey({ states: ['normal', 'visual'], keymaps: 'global', prefix: 'SPC' }, {
  'f':   { label: 'files' },
  'f f': 'find-file',
  'b b': 'switch-to-buffer',
})
```

### Helm (sketch)

```js
helm({
  prompt: 'Buffers: ',
  sources: [
    { name: 'Buffers', candidates: () => bufferNames(),
      actions: { 'Switch': (b) => call('switch-to-buffer', b), 'Kill': (b) => call('kill-buffer', b) } },
    { name: 'Create', dummy: true, actions: { 'New buffer': (q) => call('create-buffer', q) } },
  ],
})
```

- Sources: `candidates` (array | function | promise | async iterable), `volatile`
  (re-run on each query, e.g. grep), `display`, `match`, `actions`, `preview`.
- Matching: space-separated terms, all must match in any order; `!term` negates;
  fuzzy scoring with highlighted positions; smart case; incremental narrowing.
- Keys: `C-j`/`C-k` move, `RET` default action, `TAB` action menu, `C-SPC` mark,
  `C-z` persistent action (preview), `Esc` → normal state (`j`/`k`, `gg`/`G`), `C-g` quit.

### Config layout

```
~/.polymer/
  init.js
  packages/
    my-package/
      package.json      # name, version, deps, entry
      index.js          # provide('my-package')
      data/             # package-private storage
```

## Phases

| Phase | Deliverable |
|---|---|
| | *Done: 0, 1a–c, 2, 3, 4, 5, 6 (see git log)* |
| **0** | Tauri skeleton (no bundler); registry (commands, vars, hooks, advice); window split tree; helm engine; `M-x`, describe-command/variable; key dispatcher + which-key; `eval-expression`; echo area + `*Messages*` |
| **1a** | Text storage, markers, overlays, rendering, input (incl. IME), undo; file buffers; find-file, save, switch-buffer |
| **1b** | Vim layer: motions, operators, text objects, counts, registers, dot-repeat, visual, `:` commands |
| **1c** | `init.js` loading; local packages with `require`/`provide` |
| **2** | Tree-sitter worker, highlighting, structural text objects |
| **3** | Terminal buffers (Windows/macOS/Linux) |
| **4** | Perspectives, save/restore (buffer `serialize`/`restore` contract) |
| **5** | Magit-style git: status, staging (file/hunk), commit, log, diff |
| **6** | ACP client + Claude Code buffer |
| **7** | MCP server handed to agents |

## Risks

- **Own editor core + vim layer** is the largest body of work (roughly half the core).
  Keep the text-storage API narrow so the backing structure can change (line array →
  piece table) without touching callers.
- **IME and international input** in a custom editor need care from the start.
- **Terminal rendering performance** with our own grid renderer; xterm.js is the fallback.
