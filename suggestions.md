# td-code Feature Suggestions

> Status (2026-10-13): ✅ Implemented — Command Palette, Settings Persistence, Theme System, Task Runner (bun/npm/make), LSP Support (TypeScript), Debug Adapter (Python via debugpy; Node.js via js-debug behind TD_CODE_JS_DEBUG; conditional breakpoints; watch expressions; .ts via node runtime args). See README for usage.

This document outlines potential features and improvements for the td-code editor, categorized by effort and impact.

---

## 🎯 High Impact, Low Effort

### 1. Keyboard Shortcuts Overlay

- **Description**: Press `?` or `F1` to show a modal with all available keyboard shortcuts
- **Implementation**: Add a `ShortcutsModal` component, register global handler in `App.tsx`
- **Shortcuts to document**: Ctrl+S (save), Ctrl+` (terminal), Ctrl+P (command palette - see below), Ctrl+B (toggle sidebar)

### 2. Command Palette (Ctrl+P / Ctrl+Shift+P)

- **Description**: VSCode-style command palette for quick actions
- **Commands to include**:
  - File: New File, Open File, Save, Save All, Close Tab, Close All
  - Edit: Undo, Redo, Find, Replace
  - View: Toggle Sidebar, Toggle Terminal, Toggle Panel (Explorer/Search/Git/Browser)
  - Terminal: New Terminal, Kill Terminal, Clear Screen
  - Git: Stage All, Unstage All, Commit, Push, Pull, Checkout Branch
  - Developer: Reload Window, Toggle DevTools

### 3. File Tabs: Drag to Reorder

- **Description**: Allow dragging tabs in the tab bar to reorder them
- **Implementation**: Add `onDragStart`, `onDragOver`, `onDrop` handlers in `EditorTabs.tsx`
- **Store update**: Reorder `tabs` array in `useAppStore.ts`

### 4. Split Editor (Horizontal/Vertical)

- **Description**: Split the editor area to view two files side-by-side
- **Implementation**:
  - Add `splitDirection: 'horizontal' | 'vertical' | null` and `secondaryActivePath` to store
  - Modify `EditorTabs` to render two editor panes when split
  - Add split actions to tab context menu and command palette

### 5. Settings Persistence (localStorage)

- **Description**: Persist user preferences across sessions
- **Settings to persist**:
  - Font size (editor + terminal)
  - Theme (light/dark/auto)
  - Tab size / indent style
  - Word wrap on/off
  - Show hidden files
  - Sidebar width
  - Terminal font size
- **Implementation**: Add `settings` slice to `useAppStore`, load/save to localStorage

---

## 🎯 High Impact, Medium Effort

### 6. Language Server Protocol (LSP) Support

- **Description**: Add code intelligence (go to definition, hover, diagnostics, completions)
- **Approach**: Use `vscode-languageserver-protocol` + `monaco-editor` or CodeMirror LSP wrappers
- **Languages to prioritize**: TypeScript/JavaScript (via `typescript-language-server`), Python (via `pylsp`), JSON, HTML, CSS
- **Architecture**: Spawn LSP servers as child processes, communicate via stdio/JSON-RPC

### 7. Multi-Cursor Editing

- **Description**: Alt+Click to add cursors, Ctrl+D for next occurrence
- **Implementation**: CodeMirror 6 supports this via `StateField` and `EditorView` extensions
- **Add**: `multiCursorSelection` extension, keymaps for `addCursorAbove`/`addCursorBelow`

### 8. Minimap

- **Description**: Code minimap on the right side of editor (like VSCode/Sublime)
- **Implementation**: Use `@codemirror/view` `drawSelection` or separate minimap component
- **Alternative**: `codemirror-minimap` package

### 9. File Icons & Tree Customization ✅ Done

- **Description**: Better file type icons (zero-dep letter badges), customizable tree
- **Features**:
  - Per-extension badges (TS/JS/PY/JSON/MD/HTML/CSS/YAML/RS/GO/...)
  - Git status badges on tree items (A/D/U/?), dirty dots on folded folders
  - Expand/collapse all (3-level depth), filter input
  - Context menu: new file/folder, rename, delete (right-click / long-press)

### 10. Workspace / Multi-Root Support ✅ **DONE**

- **Description**: Open multiple folders in one window
- **API changes**: `/api/workspaces` endpoint (GET/POST/DELETE), modify `resolveSafe` to handle multiple roots
- **UI**: Workspace selector in activity bar, combined file tree with root labels
- **Implementation**:
  - Backend: `resolveSafe`, `findRootForPath`, `getRelativePath` in paths.ts handle multiple roots
  - Server: `/api/workspaces` endpoint for listing/adding/removing workspaces
  - All file/git/search/task/dap/lsp APIs accept optional `workspace` parameter
  - File watcher broadcasts changes with root context
  - Frontend: Zustand store manages `workspaces[]` and `activeWorkspace` index
  - Activity bar shows workspace dropdown when multiple workspaces exist
  - FileTree shows each workspace as a collapsible root with label and path
  - Persisted in localStorage (`td-code-workspaces-v1`)

---

## 🎯 High Impact, High Effort

### 11. Debug Adapter Protocol (DAP) Integration

- **Description**: Full debugging support (breakpoints, call stack, variables, watch, console)
- **Implementation**:
  - Add DAP client in frontend (WebSocket to debug adapter)
  - Backend: spawn debug adapters (Node, Python, etc.)
  - UI: Debug panel with breakpoints, variables, call stack, watch, console
  - Breakpoint gutter in editor

### 12. Extension/Plugin System

- **Description**: Allow third-party extensions (themes, language support, tools)
- **Architecture**:
  - Define extension manifest format (`package.json` with `td-code` field)
  - Extension API: `registerCommand`, `registerView`, `registerLanguage`, `onDidSave`, etc.
  - Sandbox: load extensions in separate WebWorker or iframe
  - Marketplace: simple JSON index, install from URL/GitHub

### 13. Real-time Collaboration

- **Description**: Multiple users editing same files simultaneously
- **Approach**: Yjs + WebRTC or central WebSocket server
- **Features**: Presence (cursors, selections), conflict-free editing, voice/chat
- **Challenge**: Terminal sharing, git operations coordination

### 14. AI Assistant Integration

- **Description**: Inline AI chat, code generation, explanation, refactoring
- **Providers**: OpenAI, Anthropic, local (Ollama), or pluggable
- **UI**: Chat panel, inline diffs for suggestions, `/commands` in editor
- **Context**: Current file, project structure, git history, terminal output

---

## 🎯 Medium Impact, Low Effort

### 15. Theme System

- **Description**: Multiple themes (One Dark, Dracula, GitHub Light, Solarized, etc.)
- **Implementation**:
  - Add `theme` setting, CSS variables for colors
  - CodeMirror themes: `@codemirror/theme-one-dark`, `@codemirror/theme-dracula`, etc.
  - Terminal themes: sync with editor theme

### 16. Bracket Pair Colorization

- **Description**: Colorize matching brackets for easier nesting visualization
- **Implementation**: CodeMirror 6 has built-in support via `bracketMatching` + custom style

### 17. Inlay Hints

- **Description**: Show parameter names, types, return types inline (TypeScript, Python)
- **Implementation**: Requires LSP (see #6) or TypeScript service

### 18. Sticky Scroll / Breadcrumbs

- **Description**: Show current function/class context at top of editor
- **Implementation**: CodeMirror `syntaxTree` traversal, render as sticky header

### 19. Better Search & Replace

- **Description**:
  - Replace in files (with preview)
  - Regex support
  - File include/exclude patterns
  - Case sensitive/whole word toggles
- **Backend**: Extend `/api/search` with `replace` parameter, add `/api/replace` endpoint

### 20. Outline / Symbols Panel

- **Description**: Show file structure (functions, classes, imports) in sidebar
- **Implementation**: CodeMirror `syntaxTree` or LSP `documentSymbol` request

---

## 🎯 Medium Impact, Medium Effort

### 21. Integrated Terminal Improvements

- **Session persistence**: Save/restore terminal sessions across restarts
- **Session naming**: Rename tabs (double-click tab name)
- **Split terminals**: Horizontal/vertical split panes in terminal drawer
- **Send text to terminal**: Right-click in editor → "Send Selection to Terminal"
- **Terminal profiles**: Predefined shells (bash, zsh, fish, node, python, custom)

### 22. Git Enhancements

- **Stash management**: List, apply, drop, pop stashes
- **Remote operations**: Fetch, Pull, Push (with upstream tracking), Push tags
- **Merge/Rebase**: Interactive rebase UI, merge conflict resolver (3-way diff)
- **Blame/Annotate**: Inline git blame in editor gutter
- **History view**: File-specific log, line history
- **Submodules**: Detect and manage submodules

### 23. Task Runner / Scripts Panel

- **Description**: Run npm scripts, make targets, custom tasks
- **Detection**: `package.json` scripts, `Makefile`, `justfile`, `Taskfile.yml`, `.vscode/tasks.json`
- **UI**: Panel with script list, run/stop, output terminal, problem matchers

### 24. Problems / Diagnostics Panel

- **Description**: Aggregate errors/warnings from linters, TypeScript, build tools
- **Sources**: ESLint, TypeScript, Stylelint, custom regex patterns
- **UI**: List with file/line/column, click to jump, filter by severity

### 25. Code Snippets

- **Description**: User-defined and built-in snippets (Tab to expand)
- **Format**: VSCode-compatible `.json` snippets
- **Scope**: Per-language, global, project-level

---

## 🎯 Nice to Have (Polish)

### 26. Welcome / Start Page

- **Description**: Show on empty workspace: recent folders, new file, clone repo, open folder
- **Implementation**: New component shown when `tabs.length === 0` and no root

### 27. Zen Mode / Focus Mode

- **Description**: Hide all UI except editor (Esc Esc to exit)
- **Implementation**: Add `zenMode` to store, conditional rendering in `App.tsx`

### 28. Mini Map Scrollbar

- **Description**: Enhanced scrollbar with code overview (like VSCode minimap but in scrollbar)
- **Implementation**: CodeMirror `Scrollbar` extension with custom renderer

### 29. Export / Print

- **Description**: Export file as PDF, HTML (with syntax highlighting), or print
- **Implementation**: Use `@codemirror/view` `EditorView.print` or generate HTML

### 30. Time Travel / Local History

- **Description**: Automatic local snapshots of files on save, browse/restore history
- **Storage**: `.td-code/history/` with timestamped copies
- **UI**: Timeline panel, diff against current

### 31. Remote Development (SSH/Container)

- **Description**: Connect to remote server via SSH, edit files, run terminal
- **Architecture**: td-code server runs on remote, UI connects via WebSocket tunnel
- **Challenge**: File watcher, terminal, git over SSH

### 32. Mobile/Touch Optimizations

- **Description**: Better touch targets, swipe gestures, virtual keyboard handling
- **Specifics**:
  - Swipe from left edge → open sidebar
  - Swipe from right edge → open terminal
  - Long-press context menus (already partially done)
  - Better virtual keyboard avoidance for editor/terminal
  - Haptic feedback on actions

### 33. Accessibility (a11y)

- **Description**: Screen reader support, keyboard navigation, high contrast
- **ARIA**: Proper roles, labels, live regions for status
- **Focus management**: Trap focus in modals, visible focus indicators
- **Color contrast**: Meet WCAG AA in all themes

### 34. Performance Monitoring

- **Description**: Built-in profiler for editor, terminal, file operations
- **Metrics**: Frame time, memory, WebSocket latency, API response times
- **UI**: DevTools-style performance panel

---

## 🛠 Technical Debt / Infrastructure

### 35. Test Coverage

- **Unit tests**: Store actions, API client, path utilities
- **Integration tests**: API endpoints, git operations, terminal lifecycle
- **E2E tests**: Playwright/Cypress for critical user flows
- **CI**: GitHub Actions for typecheck, lint, test, build

### 36. Error Boundaries & Recovery

- **Description**: Graceful degradation when components crash
- **Current**: Basic `ErrorBoundary` exists
- **Improve**: Per-panel error boundaries, auto-retry, error reporting

### 37. Offline Support (PWA)

- **Description**: Service worker for offline file editing, sync on reconnect
- **Challenge**: Git, terminal, search need server

### 38. Configuration File (td-code.json)

- **Description**: Project-level settings (like `.vscode/settings.json`)
- **Settings**: Exclude patterns, custom tasks, language overrides, terminal profiles

### 39. Telemetry / Crash Reporting (Opt-in)

- **Description**: Anonymous usage stats, crash reports
- **Privacy**: Local-first, explicit opt-in, no code content

### 40. Documentation Site

- **Description**: VitePress/Nextra site with guides, API reference, contributing
- **Deploy**: GitHub Pages or Cloudflare Pages

---

## 📋 Prioritization Matrix

| Feature              | Impact | Effort | Priority  |
| -------------------- | ------ | ------ | --------- |
| Command Palette      | High   | Low    | 🔥 P0     |
| Keyboard Shortcuts   | High   | Low    | 🔥 P0     |
| Settings Persistence | High   | Low    | 🔥 P0     |
| Split Editor         | High   | Medium | 🔥 P1     |
| Drag Tab Reorder     | Medium | Low    | 🔥 P1     |
| Theme System         | Medium | Low    | 🔥 P1     |
| LSP Support          | High   | High   | 🔥 P2     |
| Multi-Cursor         | High   | Medium | 🔥 P2     |
| Git Enhancements     | High   | Medium | 🔥 P2     |
| Task Runner          | Medium | Medium | 🔥 P3     |
| Debug Support        | High   | High   | 🔥 P3     |
| Extension System     | High   | High   | 🔮 Future |
| Collaboration        | High   | High   | 🔮 Future |
| AI Assistant         | High   | High   | 🔮 Future |
| Remote Dev           | High   | High   | 🔮 Future |

---

## 🚀 Quick Wins (Can Implement Today)

1. **Command Palette** - Core VSCode UX pattern, ~200 lines
2. **Keyboard Shortcuts Modal** - Pure UI, ~100 lines
3. **Settings Persistence** - localStorage + store slice, ~150 lines
4. **Theme Switcher** - CSS variables + 3-4 themes, ~100 lines
5. **Drag-to-Reorder Tabs** - Native HTML5 DnD API, ~80 lines
6. **Better Search** - Regex, case-sensitive, replace preview, ~200 lines
7. **Terminal Session Names** - Double-click to rename, ~50 lines
8. **Sticky Header Breadcrumbs** - CodeMirror syntax tree, ~150 lines

---

## 💡 Implementation Tips

### For LSP (High Impact):

Start with TypeScript only. Use `typescript-language-server` (npm package) which speaks LSP. The protocol is JSON-RPC over stdio. CodeMirror has `@codemirror/lsp` but it's experimental; consider a custom thin wrapper.

### For Extensions:

Keep it simple initially: extensions are just JS modules loaded via dynamic `import()` with a defined `activate(ctx)` function. No sandbox needed for v1 — trust model like VSCode.

### For AI:

Use the existing Browser tab as a starting point. Embed an AI chat UI (iframe to a hosted service or local Ollama WebUI). Later add inline completions via CodeMirror `autocompletion` extension with custom source.

### For Mobile:

Test on actual Termux + Chrome/Edge mobile. Key pain points: virtual keyboard covering editor, touch targets too small, swipe gestures conflicting with browser.

---

## 📝 Contributing

When implementing a feature:

1. Create an issue first (discuss design)
2. Follow existing code patterns (TypeScript strict, functional React, Zustand)
3. Add types to `src/lib/api.ts` for any new API endpoints
4. Update `AGENTS.md` if architecture changes
5. Run `bun check && bun lint && bun build` before PR

---

_Last updated: 2026-10-13_
_Generated from codebase analysis of td-code v0.1.0_
