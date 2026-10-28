# Extension/Plugin System Implementation Plan

## Overview

Build a VSCode-like extension system for td-code. Extensions are JS/TS modules loaded via dynamic `import()` with an `activate(ctx)` entry point. No sandbox for v1 (trust model like VSCode).

## Architecture

### Extension Manifest (`package.json` with `td-code` field)

```json
{
	"name": "my-extension",
	"version": "1.0.0",
	"main": "dist/extension.js",
	"td-code": {
		"publisher": "my-publisher",
		"displayName": "My Extension",
		"description": "Adds awesome features",
		"categories": [
			"Themes",
			"Snippets",
			"Language Packs",
			"Debuggers",
			"Formatters"
		],
		"activationEvents": [
			"onStartup",
			"onCommand:my-command",
			"onLanguage:typescript"
		],
		"contributes": {
			"commands": [
				{
					"command": "my-command",
					"title": "My Command",
					"category": "My Extension"
				}
			],
			"views": [
				{"id": "my-view", "title": "My View", "icon": "📊", "panel": "sidebar"}
			],
			"languages": [
				{
					"id": "mylang",
					"extensions": [".my"],
					"configuration": "./language-config.json"
				}
			],
			"themes": [
				{"label": "My Theme", "uiTheme": "vs-dark", "path": "./theme.json"}
			],
			"keybindings": [
				{
					"command": "my-command",
					"key": "ctrl+shift+m",
					"when": "editorTextFocus"
				}
			]
		}
	}
}
```

### Extension Host API (`ExtensionContext`)

```typescript
interface ExtensionContext {
	// Commands
	registerCommand(id: string, handler: (...args: any[]) => any): Disposable

	// Views (sidebar panels)
	registerView(id: string, view: ViewProvider): Disposable

	// Languages
	registerLanguage(lang: LanguageExtension): Disposable

	// Events
	onDidSaveFile(listener: (path: string, workspace: number) => void): Disposable
	onDidChangeFile(
		listener: (path: string, workspace: number) => void,
	): Disposable
	onDidOpenTab(listener: (tab: OpenTab) => void): Disposable
	onDidCloseTab(listener: (path: string) => void): Disposable
	onDidChangeActiveWorkspace(listener: (index: number) => void): Disposable

	// Workspace
	workspace: {
		rootDir: string
		name: string
		index: number
	}[]
	activeWorkspace: number

	// File operations
	readFile(path: string, workspace?: number): Promise<string>
	writeFile(path: string, content: string, workspace?: number): Promise<void>
	listFiles(path: string, workspace?: number): Promise<FileItem[]>

	// Terminal
	createTerminal(options: TerminalOptions): Promise<TermSession>

	// UI
	showMessage(message: string, type: 'info' | 'warn' | 'error'): void
	showInputBox(options: InputBoxOptions): Promise<string | undefined>
	showQuickPick(items: QuickPickItem[]): Promise<QuickPickItem | undefined>

	// Storage
	globalStorage: Storage // localStorage-like but namespaced per extension
	workspaceStorage: Storage

	// Subscriptions (auto-cleanup on deactivate)
	subscriptions: Disposable[]
}
```

## Implementation Steps

### Phase 1: Core Infrastructure

1. **Extension manifest type definitions** - `src/lib/extension.ts`
2. **Extension host/runtime** - `src/lib/extensionHost.ts`
3. **Extension API surface** - `src/lib/extensionApi.ts`
4. **Extension loader** - Dynamic import, lifecycle management

### Phase 2: Built-in Extension Points

1. **Command registration** - Integrate with Command Palette
2. **View registration** - Integrate with Sidebar (Explorer/Search/Git/Tasks/Debug panels)
3. **Event system** - File watch, tab changes, workspace changes
4. **Storage API** - Namespaced localStorage

### Phase 3: Extension Management UI

1. **Extensions panel** in sidebar (new panel type)
2. **Install from URL/GitHub** - Fetch manifest, download, install
3. **Enable/disable/uninstall** extensions
4. **Extension settings** (per-extension config)

### Phase 4: Marketplace (Optional v1)

1. **Marketplace index** - Simple JSON file with extension metadata
2. **Search/browse** extensions
3. **Auto-update** checking

## File Structure

```
src/
├── lib/
│   ├── extension.ts          # Types: ExtensionManifest, ExtensionContext, etc.
│   ├── extensionHost.ts      # ExtensionHost class - loads/manages extensions
│   ├── extensionApi.ts       # API implementations (commands, views, events, etc.)
│   └── extensionStore.ts     # Zustand slice for extension state
├── components/
│   ├── ExtensionsPanel.tsx   # Sidebar panel for managing extensions
│   └── ExtensionItem.tsx     # Individual extension UI
└── store/
    └── useAppStore.ts        # Add extension state
```

## API Endpoints (Backend)

- `GET /api/extensions` - List installed extensions
- `POST /api/extensions` - Install extension (from URL/GitHub)
- `DELETE /api/extensions/:id` - Uninstall extension
- `PATCH /api/extensions/:id` - Enable/disable extension

## Extension Directory Structure

```
~/.td-code/extensions/
├── my-extension/
│   ├── package.json
│   ├── dist/
│   │   └── extension.js
│   └── node_modules/ (if bundled)
```

## Security Considerations (v1)

- Trust model: extensions have full access to Extension API
- No sandbox - runs in same JS context
- Future: WebWorker/iframe sandbox, permission system

## Testing

- Create a sample extension (e.g., "Hello World" command)
- Test activation events
- Test view registration
- Test storage persistence
