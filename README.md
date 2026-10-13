# td-code — minimal VSCode-like editor for Termux

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

## Notes / limits (by design for Termux)

- Large files (>2MB) open read-only; binaries are flagged, not rendered.
- Search skips `node_modules/.git/dist/__pycache__` and files >512KB.
- Initial bundle is ~238KB JS (~75KB gzip, app shell only). CodeMirror (~621KB) and xterm (~341KB) load on demand when you first open a file / the terminal — acceptable on LAN.
