/**
 * Extension API Implementation
 *
 * Provides the actual implementations for the ExtensionContext API.
 * Uses the existing td-code infrastructure (api, store, etc.)
 */

import {useAppStore} from '../store/useAppStore'
import {api, wsUrl} from './api'
import type {
	ConfigurationChangeEvent,
	Disposable,
	ExtensionContext,
	ExtensionManifest,
	ExtensionStorage,
	FileChangeEvent,
	OpenTab,
	QuickPickItem,
	ViewProvider,
	WorkspaceInfo,
} from './extension'

// Event emitter for extension events
class EventEmitter<T> {
	private listeners = new Set<(arg: T) => void>()

	on(listener: (arg: T) => void): Disposable {
		this.listeners.add(listener)
		return {dispose: () => this.listeners.delete(listener)}
	}

	emit(arg: T) {
		for (const listener of this.listeners) {
			try {
				listener(arg)
			} catch (e) {
				console.error('Extension event listener error:', e)
			}
		}
	}

	clear() {
		this.listeners.clear()
	}
}

// Global event emitters (shared across all extensions)
const onDidSaveFileEmitter = new EventEmitter<{
	path: string
	workspace: number
}>()
const onDidChangeFileEmitter = new EventEmitter<{
	path: string
	workspace: number
}>()
const onDidCreateFileEmitter = new EventEmitter<FileChangeEvent>()
const onDidDeleteFileEmitter = new EventEmitter<FileChangeEvent>()
const onDidOpenTabEmitter = new EventEmitter<OpenTab>()
const onDidCloseTabEmitter = new EventEmitter<OpenTab>()
const onDidChangeActiveTabEmitter = new EventEmitter<OpenTab | null>()
const onDidChangeActiveWorkspaceEmitter = new EventEmitter<number>()
const onDidChangeConfigurationEmitter =
	new EventEmitter<ConfigurationChangeEvent>()

// Export for internal use (e.g., from App.tsx, EditorTabs, etc.)
export const extensionEvents = {
	onDidSaveFile: onDidSaveFileEmitter,
	onDidChangeFile: onDidChangeFileEmitter,
	onDidCreateFile: onDidCreateFileEmitter,
	onDidDeleteFile: onDidDeleteFileEmitter,
	onDidOpenTab: onDidOpenTabEmitter,
	onDidCloseTab: onDidCloseTabEmitter,
	onDidChangeActiveTab: onDidChangeActiveTabEmitter,
	onDidChangeActiveWorkspace: onDidChangeActiveWorkspaceEmitter,
	onDidChangeConfiguration: onDidChangeConfigurationEmitter,
}

// Storage implementation using localStorage with namespace
export function createExtensionStorage(namespace: string): ExtensionStorage {
	const prefix = `td-code-ext:${namespace}:`
	return {
		get<T>(key: string): T | undefined {
			try {
				const raw = localStorage.getItem(prefix + key)
				return raw ? JSON.parse(raw) : undefined
			} catch {
				return undefined
			}
		},
		set<T>(key: string, value: T): void {
			try {
				localStorage.setItem(prefix + key, JSON.stringify(value))
			} catch {
				// ignore quota exceeded
			}
		},
		delete(key: string): void {
			localStorage.removeItem(prefix + key)
		},
		keys(): string[] {
			const result: string[] = []
			for (let i = 0; i < localStorage.length; i++) {
				const key = localStorage.key(i)
				if (key?.startsWith(prefix)) {
					result.push(key.slice(prefix.length))
				}
			}
			return result
		},
		clear(): void {
			const toDelete: string[] = []
			for (let i = 0; i < localStorage.length; i++) {
				const key = localStorage.key(i)
				if (key?.startsWith(prefix)) toDelete.push(key)
			}
			for (const key of toDelete) localStorage.removeItem(key)
		},
	}
}

// Subscription manager for each extension
function createSubscriptionManager(): Disposable[] {
	const subs: Disposable[] = []
	return subs
}

// View registry (maps view ID to provider)
const viewRegistry = new Map<string, ViewProvider>()

// Command registry
const commandRegistry = new Map<
	string,
	{
		handler: (...args: any[]) => any
		thisArg?: any
		title: string
		category?: string
		/** id of the extension that registered it, for the palette hint */
		extension?: string
	}
>()

/**
 * Create an ExtensionContext for a specific extension
 */
export function createExtensionContext(
	extensionId: string,
	extensionPath: string,
	_manifest: ExtensionManifest,
): ExtensionContext {
	const subscriptions = createSubscriptionManager()

	const addSubscription = (d: Disposable) => {
		subscriptions.push(d)
		return d
	}

	const context: ExtensionContext = {
		extensionId,
		extensionPath,
		storagePath: `${extensionPath}/.storage`, // conceptual

		get subscriptions() {
			return subscriptions
		},

		get globalStorage() {
			return createExtensionStorage(`${extensionId}.global`)
		},

		get workspaceStorage() {
			return createExtensionStorage(`${extensionId}.ws`)
		},

		get workspaces(): WorkspaceInfo[] {
			const state = useAppStore.getState()
			return state.workspaces.map((ws, i) => ({
				rootDir: ws.rootDir,
				name: ws.name,
				index: i,
			}))
		},

		get activeWorkspace(): number {
			return useAppStore.getState().activeWorkspace
		},

		registerCommand(command, handler, thisArg) {
			if (commandRegistry.has(command)) {
				console.warn(`Command ${command} already registered`)
			}
			// Prefer the title/category declared in the extension manifest so the
			// Command Palette shows "Category: Title" like built-in commands.
			const contributed = _manifest.contributes?.commands?.find(
				c => c.command === command,
			)
			commandRegistry.set(command, {
				handler,
				thisArg,
				title: contributed?.title ?? command,
				category: contributed?.category ?? extensionId,
				extension: extensionId,
			})
			return addSubscription({
				dispose: () => commandRegistry.delete(command),
			})
		},

		registerView(id, provider) {
			viewRegistry.set(id, provider)
			return addSubscription({
				dispose: () => viewRegistry.delete(id),
			})
		},

		onDidSaveFile(listener) {
			return addSubscription(onDidSaveFileEmitter.on(listener))
		},

		onDidChangeFile(listener) {
			return addSubscription(onDidChangeFileEmitter.on(listener))
		},

		onDidCreateFile(listener) {
			return addSubscription(onDidCreateFileEmitter.on(listener))
		},

		onDidDeleteFile(listener) {
			return addSubscription(onDidDeleteFileEmitter.on(listener))
		},

		onDidOpenTab(listener) {
			return addSubscription(onDidOpenTabEmitter.on(listener))
		},

		onDidCloseTab(listener) {
			return addSubscription(onDidCloseTabEmitter.on(listener))
		},

		onDidChangeActiveTab(listener) {
			return addSubscription(onDidChangeActiveTabEmitter.on(listener))
		},

		onDidChangeActiveWorkspace(listener) {
			return addSubscription(onDidChangeActiveWorkspaceEmitter.on(listener))
		},

		onDidChangeConfiguration(listener) {
			return addSubscription(onDidChangeConfigurationEmitter.on(listener))
		},

		async readFile(path, workspace) {
			const res = await api.read(path, workspace)
			if (res.binary) throw new Error('Cannot read binary file as text')
			return res.content ?? ''
		},

		async writeFile(path, content, workspace) {
			await api.save(path, content, workspace)
		},

		async listFiles(path, workspace) {
			const res = await api.list(path, false, workspace)
			return res.items
		},

		async deleteFile(path, workspace) {
			await api.remove(path, workspace)
		},

		async createDirectory(path, workspace) {
			await api.mkdir(path, workspace)
		},

		async createTerminal(options) {
			const res = await api.createTerm(options)
			return res
		},

		async sendTerminalText(sessionId, text) {
			// Send text to terminal via WebSocket
			const ws = new WebSocket(
				`${wsUrl().replace('/ws', '/term')}?id=${encodeURIComponent(sessionId)}`,
			)
			await new Promise<void>((resolve, reject) => {
				ws.onopen = () => {
					ws.send(JSON.stringify({type: 'input', data: text}))
					resolve()
				}
				ws.onerror = reject
			})
			ws.close()
		},

		showMessage(message, type) {
			useAppStore.getState().setStatus(`[${type.toUpperCase()}] ${message}`)
			// Could also show a toast notification
		},

		async showInputBox(options) {
			// Simple implementation using browser prompt
			// TODO: Replace with custom modal for better UX
			const result = window.prompt(
				options.title ?? 'Input',
				options.value ?? '',
			)
			if (result === null) return undefined
			if (options.validateInput) {
				const err = options.validateInput(result)
				if (err) {
					alert(err)
					return context.showInputBox(options) // retry
				}
			}
			return result
		},

		async showQuickPick<T extends QuickPickItem>(
			items: T[],
			options?: {title?: string},
		): Promise<T | undefined> {
			// Simple implementation using a custom modal
			// For now, use a simple approach
			const labels = items.map(
				(i, idx) =>
					`${idx + 1}. ${i.label}${i.description ? ` - ${i.description}` : ''}`,
			)
			const choice = window.prompt(
				`${options?.title ?? 'Select'}\n\n${labels.join('\n')}\n\nEnter number:`,
			)
			if (!choice) return undefined
			const idx = parseInt(choice, 10) - 1
			if (idx >= 0 && idx < items.length) return items[idx]
			return undefined
		},

		async showWorkspaceFolderPick() {
			const state = useAppStore.getState()
			if (state.workspaces.length <= 1) return 0
			const labels = state.workspaces.map(
				(ws, i) => `${i + 1}. ${ws.name} (${ws.rootDir})`,
			)
			const choice = window.prompt(
				`Select workspace:\n\n${labels.join('\n')}\n\nEnter number:`,
			)
			if (!choice) return undefined
			const idx = parseInt(choice, 10) - 1
			if (idx >= 0 && idx < state.workspaces.length) return idx
			return undefined
		},

		asAbsolutePath(relativePath) {
			// In browser context, this is just the extension path + relative
			return `${extensionPath}/${relativePath}`
		},
	}

	return context
}

/**
 * Execute a registered command
 */
export async function executeCommand(
	command: string,
	...args: any[]
): Promise<any> {
	const cmd = commandRegistry.get(command)
	if (!cmd) {
		throw new Error(`Command not found: ${command}`)
	}
	return cmd.handler.apply(cmd.thisArg, args)
}

/**
 * Get all registered commands (for Command Palette)
 */
export function getRegisteredCommands(): Array<{
	id: string
	title: string
	category: string
	extension: string
}> {
	const result: Array<{
		id: string
		title: string
		category: string
		extension: string
	}> = []
	for (const [id, cmd] of commandRegistry) {
		result.push({
			id,
			title: cmd.title,
			category: cmd.category ?? 'Extension',
			extension: cmd.extension ?? 'extension',
		})
	}
	return result.sort((a, b) => a.title.localeCompare(b.title))
}

/**
 * Get all registered views
 */
export function getRegisteredViews(): ViewProvider[] {
	return Array.from(viewRegistry.values())
}

/**
 * Get a specific view provider
 */
export function getViewProvider(id: string): ViewProvider | undefined {
	return viewRegistry.get(id)
}

/**
 * Notify file save event
 */
export function notifyFileSaved(path: string, workspace: number) {
	onDidSaveFileEmitter.emit({path, workspace})
}

/**
 * Notify file change event
 */
export function notifyFileChanged(path: string, workspace: number) {
	onDidChangeFileEmitter.emit({path, workspace})
}

/**
 * Notify file create event
 */
export function notifyFileCreated(path: string, workspace: number) {
	onDidCreateFileEmitter.emit({path, workspace})
}

/**
 * Notify file delete event
 */
export function notifyFileDeleted(path: string, workspace: number) {
	onDidDeleteFileEmitter.emit({path, workspace})
}

/**
 * Notify tab opened
 */
export function notifyTabOpened(tab: OpenTab) {
	onDidOpenTabEmitter.emit(tab)
}

/**
 * Notify tab closed
 */
export function notifyTabClosed(tab: OpenTab) {
	onDidCloseTabEmitter.emit(tab)
}

/**
 * Notify active tab changed
 */
export function notifyActiveTabChanged(tab: OpenTab | null) {
	onDidChangeActiveTabEmitter.emit(tab)
}

/**
 * Notify active workspace changed
 */
export function notifyActiveWorkspaceChanged(index: number) {
	onDidChangeActiveWorkspaceEmitter.emit(index)
}

/**
 * Notify configuration changed
 */
export function notifyConfigurationChanged(section: string) {
	onDidChangeConfigurationEmitter.emit({
		affectsConfiguration: (s: string) =>
			s === section || s.startsWith(section + '.'),
	})
}
