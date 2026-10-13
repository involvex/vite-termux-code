/**
 * Extension Host
 *
 * Loads, activates, and manages extensions lifecycle.
 * Extensions are ES modules with an `activate(ctx)` export.
 */

import type {Extension, ExtensionManifest} from './extension'
import {
	createExtensionContext,
	createExtensionStorage,
	executeCommand,
	extensionEvents,
	getRegisteredCommands,
	getRegisteredViews,
	getViewProvider,
	notifyActiveTabChanged,
	notifyActiveWorkspaceChanged,
	notifyConfigurationChanged,
	notifyFileChanged,
	notifyFileCreated,
	notifyFileDeleted,
	notifyFileSaved,
	notifyTabClosed,
	notifyTabOpened,
} from './extensionApi'

// Extension state
const extensions = new Map<string, Extension>()
const activationPromises = new Map<string, Promise<void>>()
let isInitialized = false

/**
 * Initialize the extension system
 * - Load installed extensions from localStorage
 * - Activate extensions with 'onStartup' activation event
 */
export async function initializeExtensions(): Promise<void> {
	if (isInitialized) return
	isInitialized = true

	// Load installed extensions from localStorage
	const installed = loadInstalledExtensions()
	for (const extInfo of installed) {
		await loadExtension(extInfo.path, extInfo.manifest)
	}

	// Activate extensions marked for onStartup
	for (const [id, ext] of extensions) {
		if (shouldActivateOnStartup(ext.manifest)) {
			activateExtension(id).catch(err => {
				console.error(`Failed to activate extension ${id}:`, err)
				setExtensionError(id, err instanceof Error ? err.message : String(err))
			})
		}
	}

	console.log('[ExtensionHost] Initialized with', extensions.size, 'extensions')
}

/**
 * Load an extension from disk (via HTTP in browser)
 * In browser, we fetch the manifest and main entry point
 */
async function loadExtension(
	extensionPath: string,
	manifest: ExtensionManifest,
): Promise<Extension> {
	const id = `${manifest.publisher ?? 'local'}.${manifest.name}`

	const ext: Extension = {
		id,
		manifest,
		path: extensionPath,
		isActive: false,
	}

	extensions.set(id, ext)

	// Try to load the module
	try {
		// In browser, we need to fetch the JS module
		// For local extensions, we use dynamic import with a virtual path
		const moduleUrl = `${extensionPath}/${manifest.main}`
		const module = await importModule(moduleUrl)
		ext.exports = module
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		ext.error = `Failed to load module: ${msg}`
		console.error(`[ExtensionHost] Failed to load extension ${id}:`, err)
	}

	return ext
}

/**
 * Import a module from a URL (browser-compatible)
 */
async function importModule(url: string): Promise<any> {
	// In development, we can use dynamic import if served by Vite
	// In production, extensions would be bundled and served from dist/
	// For now, we'll fetch and eval (not ideal but works for prototype)

	// Check if it's a local extension served by our dev server
	if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) {
		// Use dynamic import for local modules
		return import(/* @vite-ignore */ url)
	}

	// For external URLs, we'd need a different approach (fetch + eval, or importmap)
	// This is a limitation of browser-based extension loading
	throw new Error(
		`Cannot import module from ${url}. Use local paths or bundling.`,
	)
}

/**
 * Activate an extension
 */
export async function activateExtension(extensionId: string): Promise<void> {
	const ext = extensions.get(extensionId)
	if (!ext) throw new Error(`Extension not found: ${extensionId}`)
	if (ext.isActive) return

	// Prevent duplicate activation
	if (activationPromises.has(extensionId)) {
		return activationPromises.get(extensionId)!
	}

	const promise = (async () => {
		if (!ext.exports?.activate) {
			throw new Error('Extension has no activate() export')
		}

		const context = createExtensionContext(ext.id, ext.path, ext.manifest)

		try {
			await ext.exports.activate(context)
			ext.isActive = true
			saveInstalledExtensions()
			console.log(`[ExtensionHost] Activated extension: ${extensionId}`)
		} catch (err) {
			ext.isActive = false
			throw err
		}
	})()

	activationPromises.set(extensionId, promise)

	try {
		await promise
	} finally {
		activationPromises.delete(extensionId)
	}
}

/**
 * Deactivate an extension
 */
export async function deactivateExtension(extensionId: string): Promise<void> {
	const ext = extensions.get(extensionId)
	if (!ext || !ext.isActive) return

	if (ext.exports?.deactivate) {
		try {
			await ext.exports.deactivate()
		} catch (err) {
			console.error(`[ExtensionHost] Error deactivating ${extensionId}:`, err)
		}
	}

	ext.isActive = false
	saveInstalledExtensions()
	console.log(`[ExtensionHost] Deactivated extension: ${extensionId}`)
}

/**
 * Check if extension should activate on startup
 */
function shouldActivateOnStartup(manifest: ExtensionManifest): boolean {
	return manifest.activationEvents?.includes('onStartup') ?? false
}

/**
 * Check if extension should activate for a command
 */
export function shouldActivateForCommand(
	manifest: ExtensionManifest,
	command: string,
): boolean {
	return (
		manifest.activationEvents?.some(
			e => e === `onCommand:${command}` || e === `onCommand:*`,
		) ?? false
	)
}

/**
 * Check if extension should activate for a language
 */
export function shouldActivateForLanguage(
	manifest: ExtensionManifest,
	language: string,
): boolean {
	return (
		manifest.activationEvents?.some(
			e => e === `onLanguage:${language}` || e === 'onLanguage:*',
		) ?? false
	)
}

/**
 * Check if extension should activate for a view
 */
export function shouldActivateForView(
	manifest: ExtensionManifest,
	viewId: string,
): boolean {
	return manifest.activationEvents?.some(e => e === `onView:${viewId}`) ?? false
}

/**
 * Install an extension from a URL (GitHub, npm, etc.)
 */
export async function installExtension(
	url: string,
	_name?: string,
): Promise<Extension> {
	// Fetch manifest from the URL
	// Supports: GitHub repo (https://github.com/user/repo), npm package, direct URL to package.json

	let manifestUrl: string

	if (url.includes('github.com')) {
		// GitHub repo - fetch package.json from raw.githubusercontent.com
		const match = url.match(/github\.com\/([^/]+)\/([^/]+)/)
		if (!match) throw new Error('Invalid GitHub URL')
		const [, owner, repo] = match
		manifestUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/package.json`
	} else if (url.startsWith('npm:')) {
		// npm package - use unpkg
		const pkg = url.slice(4)
		manifestUrl = `https://unpkg.com/${pkg}@latest/package.json`
	} else {
		// Direct URL to package.json or extension directory
		manifestUrl = url.endsWith('package.json')
			? url
			: `${url.replace(/\/$/, '')}/package.json`
	}

	const response = await fetch(manifestUrl)
	if (!response.ok)
		throw new Error(`Failed to fetch manifest: ${response.statusText}`)

	const manifest = (await response.json()) as ExtensionManifest

	// Validate td-code field
	if (!manifest['td-code']) {
		throw new Error(
			'Not a td-code extension (missing td-code field in package.json)',
		)
	}

	// Merge td-code field into manifest
	const tdCodeField = manifest['td-code'] as Record<string, any>
	Object.assign(manifest, tdCodeField)

	// Determine extension path
	let extensionPath: string
	if (url.includes('github.com')) {
		// For GitHub, we'd need to download the release or clone
		// For now, use a CDN approach
		const match = url.match(/github\.com\/([^/]+)\/([^/]+)/)
		if (!match) throw new Error('Invalid GitHub URL')
		const [, owner, repo] = match
		extensionPath = `https://cdn.jsdelivr.net/gh/${owner}/${repo}@latest`
	} else if (url.startsWith('npm:')) {
		const pkg = url.slice(4)
		extensionPath = `https://unpkg.com/${pkg}@latest`
	} else {
		extensionPath = url.replace(/package\.json$/, '')
	}

	// Load and activate
	const ext = await loadExtension(extensionPath, manifest)
	await activateExtension(ext.id)

	// Save to installed list
	saveInstalledExtensions()

	return ext
}

/**
 * Uninstall an extension
 */
export async function uninstallExtension(extensionId: string): Promise<void> {
	const ext = extensions.get(extensionId)
	if (!ext) throw new Error(`Extension not found: ${extensionId}`)

	await deactivateExtension(extensionId)
	extensions.delete(extensionId)
	saveInstalledExtensions()
}

/**
 * Enable/disable an extension
 */
export async function setExtensionEnabled(
	extensionId: string,
	enabled: boolean,
): Promise<void> {
	const ext = extensions.get(extensionId)
	if (!ext) throw new Error(`Extension not found: ${extensionId}`)

	if (enabled && !ext.isActive) {
		await activateExtension(extensionId)
	} else if (!enabled && ext.isActive) {
		await deactivateExtension(extensionId)
	}
}

/**
 * Get all installed extensions
 */
export function getInstalledExtensions(): Extension[] {
	return Array.from(extensions.values())
}

/**
 * Get a specific extension
 */
export function getExtension(extensionId: string): Extension | undefined {
	return extensions.get(extensionId)
}

/**
 * Get extension configuration contribution
 */
export function getExtensionConfiguration(
	extensionId: string,
): ExtensionManifest['contributes']['configuration'] | undefined {
	const ext = extensions.get(extensionId)
	if (!ext) return undefined
	return ext.manifest.contributes?.configuration
}

/**
 * Get extension configuration value
 */
export function getExtensionConfigValue(extensionId: string, key: string): any {
	const ext = extensions.get(extensionId)
	if (!ext) return undefined
	const config = ext.manifest.contributes?.configuration?.properties?.[key]
	if (!config) return undefined
	// Try to get from workspace storage first, then global
	const wsStorage = createExtensionStorage(`${extensionId}.ws`)
	const globalStorage = createExtensionStorage(`${extensionId}.global`)
	return wsStorage.get(key) ?? globalStorage.get(key) ?? config.default
}

/**
 * Set extension configuration value
 */
export function setExtensionConfigValue(
	extensionId: string,
	key: string,
	value: any,
	scope: 'workspace' | 'global' = 'workspace',
): void {
	const ext = extensions.get(extensionId)
	if (!ext) return
	const storage =
		scope === 'workspace'
			? createExtensionStorage(`${extensionId}.ws`)
			: createExtensionStorage(`${extensionId}.global`)
	storage.set(key, value)
	notifyConfigurationChanged(`${extensionId}.${key}`)
}

/**
 * Get all active extensions
 */
export function getActiveExtensions(): Extension[] {
	return Array.from(extensions.values()).filter(e => e.isActive)
}

/**
 * Set extension error
 */
function setExtensionError(extensionId: string, error: string): void {
	const ext = extensions.get(extensionId)
	if (ext) {
		ext.error = error
		saveInstalledExtensions()
	}
}

/**
 * Load installed extensions from localStorage
 */
function loadInstalledExtensions(): Array<{
	path: string
	manifest: ExtensionManifest
}> {
	try {
		const raw = localStorage.getItem('td-code-extensions-v1')
		if (!raw) return []
		const parsed = JSON.parse(raw) as Array<{
			path: string
			manifest: ExtensionManifest
		}>
		return parsed
	} catch {
		return []
	}
}

/**
 * Save installed extensions to localStorage
 */
function saveInstalledExtensions(): void {
	try {
		const data = Array.from(extensions.values()).map(ext => ({
			path: ext.path,
			manifest: ext.manifest,
		}))
		localStorage.setItem('td-code-extensions-v1', JSON.stringify(data))
	} catch {
		// ignore quota exceeded
	}
}

// Re-export API functions for convenience
export {
	executeCommand,
	extensionEvents,
	getRegisteredCommands,
	getRegisteredViews,
	getViewProvider,
	notifyActiveTabChanged,
	notifyActiveWorkspaceChanged,
	notifyConfigurationChanged,
	notifyFileChanged,
	notifyFileCreated,
	notifyFileDeleted,
	notifyFileSaved,
	notifyTabClosed,
	notifyTabOpened,
}
