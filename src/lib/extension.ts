/**
 * Extension System Types for td-code
 *
 * Defines the extension manifest, API surface, and core types.
 * Extensions are loaded via dynamic import() with an activate(ctx) entry point.
 */

export interface ExtensionManifest {
	name: string
	version: string
	publisher?: string
	displayName?: string
	description?: string
	categories?: ExtensionCategory[]
	main: string
	activationEvents?: ActivationEvent[]
	contributes?: ExtensionContributes
	engines?: {tdCode: string}
	repository?: {type: string; url: string}
	license?: string
	icon?: string
	keywords?: string[]
}

export type ExtensionCategory =
	| 'Themes'
	| 'Snippets'
	| 'Language Packs'
	| 'Debuggers'
	| 'Formatters'
	| 'Linters'
	| 'Other'

export type ActivationEvent =
	| 'onStartup'
	| `onCommand:${string}`
	| `onLanguage:${string}`
	| `onFileSystem:${string}`
	| `workspaceContains:${string}`
	| `onView:${string}`

export interface ExtensionContributes {
	commands?: CommandContribution[]
	views?: ViewContribution[]
	languages?: LanguageContribution[]
	themes?: ThemeContribution[]
	keybindings?: KeybindingContribution[]
	configuration?: ConfigurationContribution
	snippets?: SnippetContribution[]
	debuggers?: DebuggerContribution[]
	grammars?: GrammarContribution[]
}

export interface CommandContribution {
	command: string
	title: string
	category?: string
	icon?: string
	enablement?: string
}

export interface ViewContribution {
	id: string
	title: string
	icon?: string
	panel?: 'sidebar' | 'panel' | 'terminal'
	when?: string
}

export interface LanguageContribution {
	id: string
	extensions: string[]
	aliases?: string[]
	configuration?: string
	icon?: {light: string; dark: string}
}

export interface ThemeContribution {
	label: string
	uiTheme: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light'
	path: string
}

export interface KeybindingContribution {
	command: string
	key: string
	mac?: string
	when?: string
}

export interface ConfigurationContribution {
	title: string
	properties: Record<string, ConfigurationProperty>
}

export interface ConfigurationProperty {
	type: 'string' | 'number' | 'boolean' | 'array' | 'object'
	default?: any
	description?: string
	enum?: any[]
	enumDescriptions?: string[]
}

export interface SnippetContribution {
	language: string
	path: string
}

export interface DebuggerContribution {
	type: string
	label: string
	program?: string
	runtime?: string
	configurationAttributes?: Record<string, any>
}

export interface GrammarContribution {
	language: string
	scopeName: string
	path: string
	embeddedLanguages?: Record<string, string>
}

export interface Extension {
	id: string
	manifest: ExtensionManifest
	path: string
	isActive: boolean
	exports?: ExtensionExports
	error?: string
}

export interface ExtensionExports {
	activate?: (context: ExtensionContext) => Promise<void> | void
	deactivate?: () => Promise<void> | void
}

export interface Disposable {
	dispose(): void
}

export interface ExtensionContext {
	// Unique extension identifier
	readonly extensionId: string
	readonly extensionPath: string
	readonly storagePath: string

	// Subscriptions for auto-cleanup
	readonly subscriptions: Disposable[]

	// Storage (namespaced per extension)
	readonly globalStorage: ExtensionStorage
	readonly workspaceStorage: ExtensionStorage

	// Workspace info
	readonly workspaces: WorkspaceInfo[]
	readonly activeWorkspace: number

	// Commands
	registerCommand(
		command: string,
		handler: (...args: any[]) => any,
		thisArg?: any,
	): Disposable

	// Views (sidebar/panel)
	registerView(id: string, provider: ViewProvider): Disposable

	// Events
	onDidSaveFile(listener: FileChangeListener): Disposable
	onDidChangeFile(listener: FileChangeListener): Disposable
	onDidCreateFile(listener: FileChangeListener): Disposable
	onDidDeleteFile(listener: FileChangeListener): Disposable
	onDidOpenTab(listener: TabChangeListener): Disposable
	onDidCloseTab(listener: TabChangeListener): Disposable
	onDidChangeActiveTab(listener: TabChangeListener): Disposable
	onDidChangeActiveWorkspace(listener: WorkspaceChangeListener): Disposable
	onDidChangeConfiguration(listener: ConfigurationChangeListener): Disposable

	// File operations
	readFile(path: string, workspace?: number): Promise<string>
	writeFile(path: string, content: string, workspace?: number): Promise<void>
	listFiles(path: string, workspace?: number): Promise<FileItem[]>
	deleteFile(path: string, workspace?: number): Promise<void>
	createDirectory(path: string, workspace?: number): Promise<void>

	// Terminal
	createTerminal(options: TerminalOptions): Promise<TerminalSession>
	sendTerminalText(sessionId: string, text: string): Promise<void>

	// UI
	showMessage(message: string, type: MessageType): void
	showInputBox(options: InputBoxOptions): Promise<string | undefined>
	showQuickPick<T extends QuickPickItem>(items: T[]): Promise<T | undefined>
	showWorkspaceFolderPick(): Promise<number | undefined>

	// Environment
	asAbsolutePath(relativePath: string): string
}

export interface ExtensionStorage {
	get<T>(key: string): T | undefined
	set<T>(key: string, value: T): void
	delete(key: string): void
	keys(): string[]
	clear(): void
}

export interface WorkspaceInfo {
	rootDir: string
	name: string
	index: number
}

export interface FileItem {
	name: string
	path: string
	type: 'file' | 'dir'
	size: number
	mtime: number
}

export interface TerminalOptions {
	cwd?: string
	shell?: string
	cols?: number
	rows?: number
	name?: string
}

export interface TerminalSession {
	id: string
	cwd: string
	shell: string
}

export interface FileChangeEvent {
	path: string
	workspace: number
}

export type FileChangeListener = (
	event: FileChangeEvent,
) => void | Promise<void>

export interface TabChangeListener {
	(tab: OpenTab): void | Promise<void>
}

export interface WorkspaceChangeListener {
	(index: number): void | Promise<void>
}

export interface ConfigurationChangeEvent {
	affectsConfiguration: (section: string) => boolean
}

export interface ConfigurationChangeListener {
	(event: ConfigurationChangeEvent): void | Promise<void>
}

export interface ViewProvider {
	readonly id: string
	readonly title: string
	readonly icon?: string
	readonly panel?: 'sidebar' | 'panel' | 'terminal'
	render(): React.ReactNode
	dispose?(): void
}

export interface OpenTab {
	path: string
	content: string
	savedContent: string
	mtime: number
	truncated?: boolean
	binary?: boolean
	workspace?: number
}

export type MessageType = 'info' | 'warn' | 'error'

export interface InputBoxOptions {
	title?: string
	placeHolder?: string
	value?: string
	password?: boolean
	ignoreFocusOut?: boolean
	validateInput?: (value: string) => string | undefined
}

export interface QuickPickItem {
	label: string
	description?: string
	detail?: string
	icon?: string
	picked?: boolean
	alwaysShow?: boolean
}

export interface ExtensionInstallOptions {
	url: string // GitHub repo URL, npm package, or direct .zip/.tar.gz
	name?: string
}

export interface ExtensionMarketplaceEntry {
	name: string
	publisher: string
	version: string
	displayName: string
	description: string
	categories: ExtensionCategory[]
	icon?: string
	repository: string
	downloads: number
	rating: number
	updatedAt: string
}
