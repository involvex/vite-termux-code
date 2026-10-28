# AGENTS.md — td-code (vite-termux-code)

> Comprehensive agent instructions for this repository. Covers commands, stack, architecture, conventions, and contribution guidelines.

---

## 1. Project Overview

**td-code** is a minimal VSCode-like editor for Termux (Android). It serves a directory to a touch-friendly web UI with:

- File browser with search
- CodeMirror 6 editor (syntax highlighting, autocomplete, bracket autoclosing)
- Real terminal with xterm.js (PTY via `script(1)` when available, pipes fallback)
- Source Control panel (git status, stage/unstage, diff, commit, log, branches)
- Browser tab for embedding other tools (e.g., opencode on port 4096)

**No native dependencies.** Works with Bun (primary) and Node 20+.

---

## 2. Useful Commands

### Development

```bash
# Install dependencies
bun i

# Start dev servers (UI + API)
bun run dev           # Vite UI on 0.0.0.0:4444, proxies /api + /ws to :4445
bun run dev:server    # API server on 127.0.0.1:4445 (no auth, watches cwd)

# Type-check (uses Bun's built-in Rust checker, multicore)
bun check             # whole project
bun check -b          # monorepo refs
bun --check           # force typecheck even if package.json has "check" script

# Lint & format
bun run lint          # oxlint (fast, Rust-based)
bun run lint:fix      # auto-fix
bun run format        # prettier (@involvex/prettier-config)

# Build
bun run build         # full build: tsc -b && vite build && bun build server/cli.ts
bun run build:ui      # vite build only (outputs to dist/)
bun run build:server  # bun build server/cli.ts → dist/cli.js

# Preview production build
bun run preview       # vite preview on 0.0.0.0:4444

# Run production server
bun run serve         # runs dist/cli.js (td-code binary)
```

### CLI Usage (td-code)

```bash
td-code [dir] [-p PORT] [--host ADDR] [--no-auth] [--auth-token TOKEN] [--no-watch] [--no-terms] [--open]

# Examples
td-code .                       # serve cwd on 0.0.0.0:4444 with random token
td-code ~/myproj -p 8080 --no-auth
td-code . --host 127.0.0.1 --auth-token secret --open
```

**Environment variable overrides** (useful in Termux):

- `TD_CODE_PORT` — port (default 4444)
- `TD_CODE_HOST` — host (default 0.0.0.0)
- `TD_CODE_TOKEN` — fixed auth token

### Termux Quickstart

```bash
pkg install bun git
git clone <this-repo> td-code
cd td-code
bun i
bun run build
bun link
td-code .                 # serves cwd on 0.0.0.0:4444 with random token

# In a second Termux session:
opencode serve --port 4096
# Then in td-code open 🌐 Browser tab → http://localhost:4096
```

---

## 3. Technologies & Stack

| Layer          | Technology   | Version | Notes                                                        |
| -------------- | ------------ | ------- | ------------------------------------------------------------ |
| **Runtime**    | Bun          | ≥1.3    | Primary; Node 20+ also supported                             |
| **Language**   | TypeScript   | ~5.9    | Strict mode, `bun check` for type-checking                   |
| **Build**      | Vite         | ^8.3    | React plugin, proxy for `/api`, `/ws`, `/term`               |
| **Frontend**   | React        | ^19.2   | Functional components, hooks, Zustand state                  |
| **Editor**     | CodeMirror 6 | ^6.0    | Modular: `@codemirror/*` packages                            |
| **Terminal**   | xterm.js     | ^6.0    | `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links` |
| **State**      | Zustand      | ^5.0    | Single store (`useAppStore`)                                 |
| **File Watch** | chokidar     | ^4.0    | Debounced WebSocket broadcasts                               |
| **Lint**       | oxlint       | ^1.81   | Rust-based, ~100x faster than ESLint                         |
| **Format**     | Prettier     | ^3.9    | `@involvex/prettier-config`                                  |
| **WS**         | ws           | ^8.18   | WebSocket server (file watcher + terminal)                   |
| **Git**        | Native `git` | System  | Spawned via `child_process`, zero deps                       |

---

## 4. Architecture

### High-Level

```
┌─────────────────────────────────────────────────────────────┐
│                      td-code Server (Bun)                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ HTTP Server  │  │ WS /ws       │  │ WS /term         │  │
│  │ (API + SPA)  │  │ (file watch) │  │ (xterm sessions) │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
│         │                 │                    │            │
│         ▼                 ▼                    ▼            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                  TermManager                          │  │
│  │  - spawns shells via child_process                    │  │
│  │  - PTY via script(1) when available                   │  │
│  │  - max 8 sessions, jailed to rootDir                  │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                            ▲
                            │ HTTP/WS
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Browser UI (React + Vite)                 │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌──────────────┐   │
│  │Activity │  │ Sidebar │  │ Editor  │  │ Terminal     │   │
│  │ Bar     │  │(Explorer│  │(CodeMir │  │ Drawer       │   │
│  │         │  │ Search  │  │ r6)     │  │ (xterm.js)   │   │
│  │         │  │ Git)    │  │         │  │              │   │
│  └─────────┘  └─────────┘  └─────────┘  └──────────────┘   │
│         │         │           │              │               │
│         └─────────┴───────────┴──────────────┘               │
│                           │                                  │
│                    Zustand Store                              │
└─────────────────────────────────────────────────────────────┘
```

### Key Directories

```
vite-termux-code/
├── src/                    # Frontend (React + TypeScript)
│   ├── components/         # UI components
│   │   ├── BrowserFrame.tsx   # iframe wrapper for external tools
│   │   ├── CodeEditor.tsx     # CodeMirror 6 editor
│   │   ├── EditorTabs.tsx     # Tab bar + editor area
│   │   ├── FileTree.tsx       # File explorer (lazy load, virtualized)
│   │   ├── GitPanel.tsx       # Source control UI
│   │   ├── SearchPanel.tsx    # Full-text search
│   │   ├── StatusBar.tsx      # Bottom status bar (branch, dirty count, connection)
│   │   ├── TerminalPanel.tsx  # xterm.js terminal drawer
│   │   └── ...
│   ├── lib/
│   │   ├── api.ts             # Typed API client + WS helpers
│   │   └── lazy.ts            # Dynamic import helper (Reloadable)
│   ├── store/
│   │   └── useAppStore.ts     # Zustand store (all UI state)
│   ├── App.tsx                # Root component, layout, effects
│   ├── main.tsx               # Entry point
│   └── index.css / App.css    # Styles
├── server/                   # Backend (Bun/Node, TypeScript)
│   ├── cli.ts                 # CLI entry, arg parsing, token gen
│   ├── server.ts              # HTTP + WS server, API handlers
│   ├── terminal.ts            # TermManager (PTY/pipes, sessions)
│   ├── git.ts                 # Git operations (spawns git CLI)
│   ├── paths.ts               # Path resolution (jail), findOnPath
│   └── mime.ts                # MIME type lookup
├── dist/                      # Build output (gitignored)
│   ├── *.js, *.html, assets/ # Vite UI build
│   └── cli.js                 # Bundled server (bun build)
├── package.json
├── tsconfig.json / tsconfig.app.json / tsconfig.node.json
├── vite.config.ts
└── README.md
```

---

## 5. Best Practices & Guidelines

### TypeScript

- **Strict mode enabled** — no `any`, prefer `unknown` + narrowing
- **Use `bun check`** for type-checking (not `tsc --noEmit`)
- **Path aliases**: `@/*` → `src/*` (configured in tsconfig.app.json)
- **Interface over type** for object shapes; `type` for unions/primitives
- **Explicit return types** on exported functions and store actions

### React

- **Functional components only** — hooks, no classes
- **Zustand for global state** — single store `useAppStore` with typed actions
- **Lazy-load heavy components** — `TerminalPanel` via `Reloadable` + dynamic import
- **Event cleanup** — always return cleanup functions in `useEffect`
- **No inline styles** — use CSS classes (App.css, index.css)

### Code Style

- **Prettier** via `@involvex/prettier-config` — run `bun run format`
- **oxlint** for linting — run `bun run lint` / `bun run lint:fix`
- **Tabs for indentation** (per package.json `"type": "module"` + Prettier config)
- **Single quotes**, trailing commas, 100 char line width (Prettier defaults)

### Backend Patterns

- **Path jailing** — all user paths resolved via `resolveSafe(root, rel)` → `null` on escape
- **Atomic writes** — write to `.td-code-tmp-<pid>` then `rename`
- **Token auth** — query `?token=`, header `Authorization: Bearer`, or `x-auth-token`
- **WebSocket sharing** — single `WebSocketServer({noServer: true})` + manual `upgrade` routing for `/ws` and `/term`
- **Error responses** — consistent `{error: string}` JSON with proper HTTP status
- **Resource limits** — max file preview 2MB, max write 5MB, max search results 200, max 8 terminal sessions

### Git Integration

- **Spawns real `git` binary** — uses your config/credentials, no library deps
- **All paths jailed** to served root
- **Friendly empty state** — returns `{repo: false}` when not a git repo (not an error)

### Terminal (PTY)

- **Real PTY via `script(1)`** (util-linux) when available → colors, TUIs work
- **Fallback to pipes** — fine for builds/git/CLI, no `vim`/`htop`
- **Session limits** — max 8, jailed `cwd`, bare command name only
- **Scrollback replay** — 200KB buffer replayed on reconnect

---

## 6. Development Workflow

### Adding a New Feature

1. **Type-first** — define interfaces in `src/lib/api.ts` (client) and `server/*.ts` (server)
2. **API endpoint** — add handler in `server/server.ts` under `handleApi()`
3. **Client wrapper** — add typed function to `api` object in `src/lib/api.ts`
4. **Store updates** — add state/actions to `useAppStore` if needed
5. **UI component** — create in `src/components/`, follow existing patterns
6. **Wire up** — import in `App.tsx` or relevant parent

### Testing Changes

```bash
# Quick iteration
bun run dev        # UI with HMR
bun run dev:server # API server (restart on server changes)

# Full verification before commit
bun run check      # type-check
bun run lint       # lint
bun run format     # format
bun run build      # production build
```

### Commit & PR Guidelines

- **Conventional commits** — `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`
- **Small, focused commits** — one logical change per commit
- **Run checks locally** — `bun check && bun lint && bun build` must pass
- **Update README** if CLI flags, env vars, or behavior change

---

## 7. Common Pitfalls & Gotchas

| Issue                                | Cause                           | Fix                                                                     |
| ------------------------------------ | ------------------------------- | ----------------------------------------------------------------------- |
| `bun check` passes but `tsc` fails   | Different TS versions           | Use `bun check` only; `tsc` only for `.d.ts` emit                       |
| WebSocket 401 on `/ws` or `/term`    | Token mismatch                  | Ensure `authQuery()` / `wsUrl()` includes token from URL/sessionStorage |
| Terminal shows "pty not available"   | `script(1)` missing             | `pkg install util-linux` (Termux)                                       |
| Git tab shows "not a git repository" | No `.git` in served root        | Expected behavior — serve a git repo root                               |
| File watcher not firing              | `chokidar` ignored paths        | Check `ignored` array in `server.ts` (node_modules, .git, dist)         |
| Large file opens read-only           | >2MB limit                      | By design — increase `MAX_FILE_BYTES` in `server.ts` if needed          |
| Search returns no results            | Query < 2 chars or >512KB files | Min 2 chars, files >512KB skipped                                       |

---

## 8. Key Files Reference

| File                       | Purpose                                                   |
| -------------------------- | --------------------------------------------------------- |
| `src/store/useAppStore.ts` | Global Zustand state + actions                            |
| `src/lib/api.ts`           | Typed API client, WS URLs, auth                           |
| `src/App.tsx`              | Root layout, effects (WS, keyboard, init)                 |
| `server/server.ts`         | HTTP server, API routes, WS upgrade routing               |
| `server/terminal.ts`       | TermManager, PTY/pipes, session lifecycle                 |
| `server/git.ts`            | Git CLI wrappers (status, log, diff, stage, commit, etc.) |
| `server/paths.ts`          | `resolveSafe()` (path jail), `findOnPath()`               |
| `vite.config.ts`           | Vite config, dev proxy to API server                      |
| `package.json`             | Scripts, deps, bin entry (`td-code`)                      |

---

## 9. Security Considerations

- **Path traversal** — `resolveSafe()` prevents escape; all API endpoints use it
- **Token auth** — random 24-char hex by default; `--no-auth` only for trusted networks
- **File size limits** — prevent DoS via large uploads (5MB) or reads (10MB hard, 2MB preview)
- **Shell injection prevention** — terminal `shell` must be bare command name (no paths/args)
- **Session limits** — max 8 terminal sessions, auto-cleanup of dead ones

---

## 10. Performance Notes

- **Initial bundle ~238KB JS** (~75KB gzip) — app shell only
- **CodeMirror (~621KB)** loads on first file open
- **xterm.js (~341KB)** loads on first terminal open
- **File watcher** ignores `node_modules`, `.git`, `dist` by default
- **Search** skips files >512KB and binary files

---

## 11. Extending the Project

### Adding a New Language to CodeMirror

```bash
# 1. Install language package
bun add @codemirror/lang-<language>

# 2. Import and add to extensions in CodeEditor.tsx
import {<language>} from '@codemirror/lang-<language>'
// Add to languageSupport array
```

### Adding a New API Endpoint

1. Define request/response types in `src/lib/api.ts`
2. Add handler in `server/server.ts` → `handleApi()`
3. Add client method to `api` object
4. Update store/UI as needed

### Adding a Sidebar Panel

1. Add panel type to `Panel` union in `useAppStore.ts`
2. Add button in `App.tsx` activity bar
3. Create component in `src/components/`
4. Wire into sidebar render logic in `App.tsx`

---

## 12. Troubleshooting

### Dev Server Won't Start

```bash
# Check ports free
netstat -tlnp | grep -E '4444|4445'

# Kill existing
pkill -f "vite\|td-code"

# Clean rebuild
rm -rf dist node_modules
bun i
bun run build
```

### Type Errors After Dependency Update

```bash
bun check  # shows exact errors
# Fix types, then:
bun run build
```

### Terminal Not Working on Termux

```bash
pkg install util-linux  # provides script(1) for PTY
# Verify:
which script
```

---

## 13. License

MIT — see LICENSE file.

---

_Generated for agent context. Keep this file updated as the project evolves._
