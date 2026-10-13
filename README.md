# td-code — minimal VSCode-like editor for Termux

[![GitHub Release](https://img.shields.io/github/v/release/involvex/vite-termux-code)](https://github.com/involvex/vite-termux-code/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/bun-%3E%3D1.3-black?logo=bun)](https://bun.sh)

`td-code` serves a directory to a touch-friendly web UI: file browser, CodeMirror editor (highlight, autocomplete, bracket autoclosing), search, and a browser tab (e.g. for opencode running in another Termux session).

No native dependencies. Works with Bun (primary) and Node 20+.

## Termux quickstart

```bash
pkg install bun git
git clone <this-repo> td-code
cd td-code
bun i
bun run build
bun link
td-code .                 # serves cwd on 0.0.0.0:4444 with a random token
# open the printed http://localhost:4444/?token=... URL in your browser
```

In a second Termux session:

```bash
opencode serve --port 4096   # or whatever your tool uses
```

Then in td-code open the 🌐 Browser tab → `http://localhost:4096`.

If you serve `~/storage`, run `termux-setup-storage` first.

## CLI

```
td-code [dir] [-p PORT] [--host ADDR] [--no-auth] [--auth-token TOKEN] [--no-watch] [--open]
```

| Flag | Default | Notes |
| ---- | ------- | ----- |
| `dir` | `.` | jailed root, `..` escapes blocked |
| `-p, --port` | `4444` | or `TD_CODE_PORT` env |
| `--host` | `0.0.0.0` | use `127.0.0.1` to lock to device, or `TD_CODE_HOST` |
| `--no-auth` | off | random token is printed unless disabled; `TD_CODE_TOKEN` overrides |
| `--auth-token` | random | fixed token, e.g. `--auth-token secret` |
| `--no-watch` | off | disable chokidar file-watcher (saves RAM on low-end phones) |
| `--no-terms` | off | disable the terminal (shell) feature entirely |
| `--open` | off | try `termux-open-url` / `xdg-open` / `open` |

Auth: append `?token=...` to the URL, or send `Authorization: Bearer ...` / `x-auth-token` header.

## Dev

```bash
bun i
bun run dev:server   # API on 127.0.0.1:4445
bun run dev          # Vite UI on 0.0.0.0:4444, proxies /api + /ws
```

Production: `bun run build` → `dist/` (UI) + `dist/cli.js` (server, `bin: td-code`).

## API

- `GET /api/health`
- `GET /api/files?path=&hidden=0|1`
- `GET /api/file?path=` (2MB editable preview cap, binary flagged, 10MB hard cap)
- `POST /api/file {path, content}` (atomic write, 5MB cap)
- `POST /api/mkdir {path}` · `POST /api/rename {from,to}` · `POST /api/remove {path}`
- `GET /api/search?q=&path=`
- `WS /ws` → `{type: add|change|unlink|addDir|unlinkDir, path}`
- Terminal: `GET /api/terms`, `POST /api/terms {cwd?, shell?, cols?, rows?}`, `DELETE /api/terms/:id`, `WS /term?id=` (`{type:'input'|'resize'}` ↔ `{type:'replay'|'data'|'exit'}`)
- Git: `GET /api/git/status|log|diff|branches`, `POST /api/git/stage|unstage|commit|checkout`
- Tasks: `GET /api/tasks` (bun/npm scripts from `package.json` + `Makefile` targets), `POST /api/tasks/run {id}` → `{termId, task}` (runs in a new terminal session)
- LSP: `GET /api/lsp/status`, `POST /api/lsp/ensure {lang}`, `WS /lsp?lang=typescript` (`{type:'open'|'change'|'close'|'request'|'ensure'}` ↔ `{type:'opened'|'response'|'diagnostics'|'ready'|'error'}`)
- Debug: `GET /api/dap/status`, `POST /api/dap/start {program, stopOnEntry?}`, `POST /api/dap/stop`, `WS /dap` (`{type:'breakpoints'|'request'}` ↔ `{type:'ack'|'response'|'event'}`) (`{type:'open'|'change'|'close'|'request'|'ensure'}` ↔ `{type:'opened'|'response'|'diagnostics'|'ready'|'error'}`)

## Terminal (no node-pty, Termux-safe)

The ⌨ button (or `Ctrl+``) opens a bottom drawer with real shells rendered by xterm.js: session tabs, scrollback replay on reconnect, and a mobile key bar (Tab, Ctrl+C, Esc, arrows, `|`, `~`).

How it works without native modules: sessions spawn via `node:child_process` only. If `script(1)` (util-linux) is on `PATH`, the shell runs under a **real PTY** (`script -qec … /dev/null`, macOS variant handled) so colors, prompts, and interactive TUIs behave. Otherwise it falls back to **pipes** — fine for builds, git, and CLIs, but fullscreen apps like `vim`/`htop` won't work.

```bash
pkg install util-linux  # Termux: provides `script` for PTY mode
```

Notes:

- Sessions are jailed: `cwd` must stay under the served root; `shell` must be a bare command name on `PATH` (default `$SHELL` → `bash` → `sh`, `powershell.exe` on Windows). Max 8 sessions.
- Same token auth as the file API (HTTP + WS close `4401` without it). Sharing on untrusted LAN? Use `--no-terms` to disable the shell while keeping files/browser.
- PTY size is fixed at spawn (default 80×24 or the requested `cols`/`rows`); the client re-fits its own viewport on resize.
- The drawer auto-starts one shell when first opened; `+ new` spawns more.

## Source Control (⎇ tab)

Spawns your real `git` (zero new dependencies — uses your config and credentials; Termux: `pkg install git`). Status, stage/unstage per file or all, inline diffs, commit (with optional inline name/email, or your repo's `user.name`/`user.email`), recent log, branch list + checkout, and a `⎇ branch +N` indicator in the status bar. All file arguments are jailed to the served directory; outside a repo the tab shows a "not a git repository" state.

## Task Runner (▶ tab)

Lists `scripts` from the root `package.json` as runnable tasks — one entry per available runtime (`bun run <script>` when `bun` is on `PATH`, `npm run <script>` when `npm` is) — plus explicit targets parsed from a root `Makefile`/`makefile`/`GNUmakefile` (`make <target>` when `make` is on `PATH`). Clicking a task spawns a new integrated terminal session and types the command there, so output streams live with scrollback replay.

## Language Server (TypeScript/JavaScript)

`.ts/.tsx/.js/.jsx` files get diagnostics (squiggles + gutter), hover tooltips, LSP-powered completions, and go-to-definition (`Ctrl/Cmd+Click` or `F12`; cross-file jumps open the target). The server spawns `typescript-language-server --stdio` on demand (via the binary on `PATH`, `bunx`, or `npx`) and bridges it to the editor over `WS /lsp`:

```bash
bun add -d typescript-language-server typescript
```

If the server can't start, the editor shows a banner with the error and keeps working without intelligence (syntax highlight + bracket matching unaffected).

## Run and Debug (🐞 tab)

Python debugging via `debugpy` (no native dependencies):

```bash
pip install debugpy   # Termux: pkg install python && pip install debugpy
```

Click the gutter in the editor to set breakpoints (persisted per file), then ▶ Start debugging. The panel shows controls (continue/step over/into/out/pause/stop), call stack with thread switching, scopes + expandable variables, and the program's console output. The stopped line is highlighted in the editor and the view jumps to it. `F5` / `F10` / `F11` step while a session is active. Single active session (v1); only `.py` programs under the served root.

## Command Palette (⌘ button, Ctrl+Shift+P / Ctrl+P / F1)

Fuzzy-matched command list: switch panels, toggle sidebar/terminal, new/save/close files, stage/unstage all, restart the language server, switch themes, reset settings. Ignored while the browser tab or terminal has focus.

## Themes & Settings

Three themes (One Dark, GitHub Light, Dracula) switchable from the `◐` chip in the status bar or the palette — applied to UI, editor, and terminal together. Editor font size, terminal font size, tab size, spaces-vs-tabs, and word wrap persist in `localStorage` (`td-code-settings-v1`) across reloads; terminal `A-`/`A+` buttons adjust and persist the terminal font.

## Notes / limits (by design for Termux)

- Large files (>2MB) open read-only; binaries are flagged, not rendered.
- Search skips `node_modules/.git/dist/__pycache__` and files >512KB.
- Initial bundle is ~238KB JS (~75KB gzip, app shell only). CodeMirror (~621KB) and xterm (~341KB) load on demand when you first open a file / the terminal — acceptable on LAN.
