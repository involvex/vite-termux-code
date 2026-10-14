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
td-code [dir...] [options]
td-code config init [--force]   write a starter ~/.td-code/config.json
td-code config edit             open the config in $VISUAL/$EDITOR
td-code config validate         check the config without starting
td-code config path             print the config file path
td-code completion bash         print a bash completion script
```

Bash completion (`td-code completion bash | sudo tee /etc/bash_completion.d/td-code`):
flags, `config`/`completion` subcommands, `config init --force`, `--host`
values, and directory names (with trailing `/` so completion continues
inside).

Easiest setup — `td-code completion bash --install` writes the script to
`~/.td-code/completion.bash` and sources it from `~/.bashrc` (once; a second
run is a no-op). `--target <file>` picks a different rc file. Then restart
your shell or run `source ~/.bashrc`. If you previously added an
`eval $(td-code …)` line by hand, remove it: without quotes the shell
collapses the script's newlines and silently defines nothing — always
`eval "$(…)"` or, better, `source`.

A bare word that matches no subcommand, flag, or existing path gets a
`did you mean` hint instead of `directory not found` (so `td-code
completions bash` tells you the command is `completion`).

| Flag             | Default                  | Notes                                                                |
| ---------------- | ------------------------ | -------------------------------------------------------------------- |
| `dir...`         | `.` or config workspaces | jailed roots, `..` escapes blocked; CLI dirs win over config         |
| `-p, --port`     | `4444`                   | or `TD_CODE_PORT` env                                                |
| `--host`         | `0.0.0.0`                | use `127.0.0.1` to lock to device, or `TD_CODE_HOST`                 |
| `--no-auth`      | off                      | random token is printed unless disabled; `TD_CODE_TOKEN` overrides   |
| `--auth-token`   | random                   | fixed token, e.g. `--auth-token secret`                              |
| `--pairing`      | off                      | also accept a short 6-digit pairing code (easier to type on a phone) |
| `--pairing-code` | random                   | fixed pairing code (4–10 digits)                                     |
| `--no-watch`     | off                      | disable chokidar file-watcher (saves RAM on low-end phones)          |
| `--no-terms`     | off                      | disable the terminal (shell) feature entirely                        |
| `--open`         | off                      | try `termux-open-url` / `xdg-open` / `open`                          |

Auth: append `?token=...` to the URL, or send `Authorization: Bearer ...` / `x-auth-token` header.

### User config: `~/.td-code/config.json`

Optional, and everything in it is optional too. Precedence: **defaults < config file < CLI flags < `TD_CODE_*` env vars**.

```jsonc
{
	"port": 4444,
	"host": "0.0.0.0",

	"auth": false, // turn auth off entirely (trusted networks only)
	"authToken": "secret", // fixed token instead of a random one per start

	"pairing": {
		// short code accepted in addition to the token
		"enabled": true, // random 6-digit code per start
		"code": "482913", // …or pin it (must be 4–10 digits)
		"length": 6, // length of a generated code
	},

	"watch": true, // false = --no-watch
	"terms": true, // false = --no-terms
	"open": false, // launch a browser at startup

	"workspaces": [
		// multi-root folders served without CLI args
		"~/projects/api", // CLI dirs win over this list;
		{"path": "~/projects/web", "name": "web"}, // TD_CODE_WORKSPACES wins over both
	],
	"version": 1,
}
```

Generate the file with `td-code config init` (refuses to overwrite without
`--force`); keys starting with `_` are comments and ignored by the parser.
`td-code config edit` opens it in `$VISUAL`/`$EDITOR` (creating a starter
first if missing, and reporting problems right after you save), falling back
to the OS opener. `td-code config validate` parses it and checks that every
workspace exists and is a directory, without starting the server — secrets
(`authToken`, `pairing.code`) print as `<set>`.

Unknown keys and wrong types are reported on startup and ignored (the file is never fatal), so a typo like `"authentification"` tells you instead of being silently dropped. A UTF-8 BOM (what Windows Notepad writes) is handled.

**Pairing code** — when enabled, the code is printed at startup and accepted anywhere a token is (`?code=…`, `x-auth-token`, or typed into the in-app pairing screen). Without a token in the URL the editor shows a pairing prompt instead of the IDE, so you can open `http://<host>:4444/` on your phone and type 6 digits instead of pasting a 24-char token. `--pairing`/`--pairing-code` do the same for one-off runs.

## Dev

```bash
bun i
bun run dev:server   # API on 127.0.0.1:4445
bun run dev          # Vite UI on 0.0.0.0:4444, proxies /api + /ws
```

Production: `bun run build` → `dist/` (UI) + `dist/cli.js` (server, `bin: td-code`).

### Tests

```bash
bun run check    # tsc -b --noEmit (src + server + scripts + tests)
bun run test     # bun test (unit tests, no deps)
bun run smoke    # headless end-to-end smoke test against the built app
```

`bun run smoke` boots `dist/cli.js` on a free port, drives a real headless
Chrome/Edge over the DevTools protocol, and asserts the critical path: the app
boots, the Explorer lists files, opening a file mounts CodeMirror, the
breakpoint gutter toggles + persists a breakpoint, the terminal starts a PTY
session, the bundled example extension installs and its command runs from the
palette, and no pane-failure UI or console error appears. It exits non-zero on
the first failing check, so a broken lazy pane can't ship unnoticed.

CI (`.github/workflows/ci.yml`) runs `check` → `test` → `lint` → `build` →
`smoke` on every push and PR, and uploads `dist/` as an artifact.

```bash
bun run smoke -- --url=http://127.0.0.1:4444   # test an already running server
bun run smoke -- --dir=../some/path           # serve another directory
bun run smoke -- --browser=/path/to/chrome    # pick a browser
```

If a lazy pane (editor, terminal) fails to load, the UI now says which kind of
failure it is instead of blaming the network: a **chunk load failure** (offline,
404, stale `index.html` after a redeploy) vs. a **render crash** (the code ran
and threw). Both show the underlying error and offer Retry / Copy details /
Reload window.

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

## File Explorer (📁 tab)

File-type badges (TS/JS/PY/JSON/MD/HTML/CSS/YAML/RS/GO/...), git status badges per file (A/D/U/?), and dirty-dot on folded folders that contain changes. Filter input, show-hidden toggle, expand/collapse all (3-level depth), and context actions (new file/folder, rename, delete). Right-click / long-press a file for the menu.

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

Python and Node.js debugging (no native dependencies, one session at a time):

```bash
pip install debugpy   # Termux: pkg install python && pip install debugpy
```

`.py` files use `debugpy` (auto-detected from any python on `PATH`). `.js`/`.mjs`/`.cjs`/`.ts`/`.mts`/`.cts` files use `js-debug`, which is **not** on npm — provide it explicitly:

1. Download `js-debug-dap` from the [microsoft/vscode-js-debug releases](https://github.com/microsoft/vscode-js-debug/releases) (or copy it from a VS Code install), and install node (`pkg install nodejs` on Termux).
2. Set `TD_CODE_JS_DEBUG` to the full adapter command, e.g.
   `TD_CODE_JS_DEBUG="node /opt/js-debug/dapDebugServer.js"`.
   A `js-debug` executable on `PATH` is used as fallback.

Without it, starting a `.js` program fails with setup instructions (verified against the DAP protocol with a mock adapter; real js-debug behavior may vary slightly).

Click the gutter in the editor to set breakpoints (persisted per file, `Alt+Click` a set breakpoint for condition / hit condition), then ▶ Start debugging. The panel shows controls (continue/step over/into/out/pause/stop), call stack with thread switching, scopes + expandable variables, and the program's console output. The stopped line is highlighted in the editor and the view jumps to it. `F5` / `F10` / `F11` step while a session is active. Single active session (v1); only programs under the served root.

- **Conditional breakpoints**: `Alt+Click` a set breakpoint, then enter a condition expression and/or hit condition (empty clears). Shown as hollow dots; evaluated by the adapter.
- **Watch expressions**: add them in the Watch section; they re-evaluate on every stop against the selected frame.
- **TypeScript on node**: node strips types natively on 23.6+ (no setup). On node 22.6–22.x pass the flag through, e.g. `TD_CODE_NODE_RUNTIME_ARGS="--experimental-strip-types"`, which is forwarded as `runtimeArgs` in the js-debug launch config.

## Command Palette (⌘ button, Ctrl+Shift+P / Ctrl+P / F1)

Fuzzy-matched command list: switch panels, toggle sidebar/terminal, new/save/close files, stage/unstage all, restart the language server, switch themes, reset settings — plus every command contributed by an installed extension. Ignored while the browser tab or terminal has focus.

## Extensions (🧩 tab, 🏪 Marketplace)

Third-party extensions are plain ESM modules with an `activate(ctx)` export, loaded on demand with `import()`:

1. Open the 🧩 tab and paste a manifest URL (same-origin, GitHub, `npm:<pkg>`, or any self-hosted extension server).
2. The extension registers commands, sidebar views, settings, and event handlers; its commands show up in the Command Palette as `Category: Title`.
3. Extensions that declare `onCommand:<id>` (or simply contribute the command) stay dormant until you run them.

A runnable example ships in `public/extensions/hello-world/` and is copied verbatim into `dist/`, so it is always installable from your own server:

```
http://<your-td-code-host>/extensions/hello-world/package.json
```

Extension API highlights: `registerCommand`, `registerView`, `onDidSaveFile` / `onDidChangeFile` / `onDidCreateFile` / `onDidDeleteFile`, `onDidOpenTab` / `onDidCloseTab`, `onDidChangeActiveWorkspace`, `readFile` / `writeFile` / `listFiles` / `createTerminal`, `globalStorage` / `workspaceStorage`, `showMessage` / `showInputBox` / `showQuickPick`, and per-extension settings generated from `contributes.configuration` (⚙ on the extension card).

Extensions run with full trust in the page (like VSCode without a sandbox), so only install code you trust.

## Themes & Settings

Three themes (One Dark, GitHub Light, Dracula) switchable from the `◐` chip in the status bar or the palette — applied to UI, editor, and terminal together. Editor font size, terminal font size, tab size, spaces-vs-tabs, and word wrap persist in `localStorage` (`td-code-settings-v1`) across reloads; terminal `A-`/`A+` buttons adjust and persist the terminal font.

## Notes / limits (by design for Termux)

- Large files (>2MB) open read-only; binaries are flagged, not rendered.
- Search skips `node_modules/.git/dist/__pycache__` and files >512KB.
- Initial bundle is ~238KB JS (~75KB gzip, app shell only). CodeMirror (~621KB) and xterm (~341KB) load on demand when you first open a file / the terminal — acceptable on LAN.
