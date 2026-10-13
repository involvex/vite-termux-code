/**
 * Extensions Panel Component
 *
 * Sidebar panel for managing installed extensions.
 */

import {useEffect, useState} from 'react'
import {
	getExtensionConfiguration,
	getInstalledExtensions,
	installExtension,
	setExtensionEnabled,
	uninstallExtension,
} from '../lib/extensionHost'
import {useAppStore} from '../store/useAppStore'
import ExtensionSettings from './ExtensionSettings'

interface ExtensionListItem {
	id: string
	name: string
	displayName?: string
	version: string
	description?: string
	publisher?: string
	isActive: boolean
	error?: string
	categories?: string[]
}

export default function ExtensionsPanel() {
	const {setStatus} = useAppStore()
	const [extensions, setExtensions] = useState<ExtensionListItem[]>([])
	const [loading, setLoading] = useState(true)
	const [installing, setInstalling] = useState(false)
	const [installUrl, setInstallUrl] = useState('')
	const [searchQuery, setSearchQuery] = useState('')
	const [settingsExtensionId, setSettingsExtensionId] = useState<string | null>(
		null,
	)

	const refreshExtensions = () => {
		const exts = getInstalledExtensions()
		setExtensions(
			exts.map(ext => ({
				id: ext.id,
				name: ext.manifest.name,
				displayName: ext.manifest.displayName,
				version: ext.manifest.version,
				description: ext.manifest.description,
				publisher: ext.manifest.publisher,
				isActive: ext.isActive,
				error: ext.error,
				categories: ext.manifest.categories,
			})),
		)
		setLoading(false)
	}

	useEffect(() => {
		refreshExtensions()
	}, [])

	const handleInstall = async () => {
		if (!installUrl.trim()) return
		setInstalling(true)
		setStatus('Installing extension...')
		try {
			await installExtension(installUrl.trim())
			setInstallUrl('')
			setStatus('Extension installed')
			refreshExtensions()
		} catch (e) {
			setStatus(e instanceof Error ? e.message : 'Install failed')
		} finally {
			setInstalling(false)
		}
	}

	const handleUninstall = async (id: string) => {
		if (!window.confirm('Uninstall this extension?')) return
		setStatus('Uninstalling...')
		try {
			await uninstallExtension(id)
			setStatus('Extension uninstalled')
			refreshExtensions()
		} catch (e) {
			setStatus(e instanceof Error ? e.message : 'Uninstall failed')
		}
	}

	const handleToggle = async (id: string, enabled: boolean) => {
		setStatus(enabled ? 'Activating...' : 'Deactivating...')
		try {
			await setExtensionEnabled(id, enabled)
			setStatus(enabled ? 'Extension activated' : 'Extension deactivated')
			refreshExtensions()
		} catch (e) {
			setStatus(e instanceof Error ? e.message : 'Toggle failed')
		}
	}

	const filteredExtensions = extensions.filter(ext => {
		if (!searchQuery) return true
		const q = searchQuery.toLowerCase()
		return (
			ext.name.toLowerCase().includes(q) ||
			ext.displayName?.toLowerCase().includes(q) ||
			ext.description?.toLowerCase().includes(q)
		)
	})

	return (
		<div className="panel-col">
			<div className="panel-toolbar">
				<span className="panel-title">Extensions</span>
				<button
					className="icon-btn"
					title="Refresh"
					onClick={refreshExtensions}
					disabled={loading}
				>
					↻
				</button>
			</div>

			<div
				style={{padding: '8px 10px', borderBottom: '1px solid var(--border)'}}
			>
				<input
					type="text"
					className="tree-filter"
					placeholder="Search extensions..."
					value={searchQuery}
					onChange={e => setSearchQuery(e.target.value)}
					style={{marginBottom: 8, width: '100%'}}
				/>
				<div style={{display: 'flex', gap: 8}}>
					<input
						type="text"
						className="tree-filter"
						placeholder="GitHub URL, npm:package, or extension URL"
						value={installUrl}
						onChange={e => setInstallUrl(e.target.value)}
						style={{flex: 1}}
						onKeyDown={e => e.key === 'Enter' && handleInstall()}
					/>
					<button
						className="icon-btn"
						onClick={handleInstall}
						disabled={installing || !installUrl.trim()}
						title="Install from URL"
					>
						{installing ? '⏳' : '⬇'}
					</button>
				</div>
				<div
					className="muted small"
					style={{marginTop: 4}}
				>
					Examples: <code>github:user/repo</code>, <code>npm:package-name</code>
					, <code>https://example.com/ext/</code>
				</div>
			</div>

			{loading && (
				<div
					className="muted"
					style={{padding: '0 10px'}}
				>
					loading…
				</div>
			)}

			<div
				className="tree-wrap"
				style={{flex: 1, overflow: 'auto'}}
			>
				{filteredExtensions.length === 0 ? (
					<div
						className="muted"
						style={{padding: 20, textAlign: 'center'}}
					>
						No extensions installed.{searchQuery && ' Try clearing search.'}
					</div>
				) : (
					<ul className="tree">
						{filteredExtensions.map(ext => (
							<li
								key={ext.id}
								className="extension-item"
							>
								<div className="extension-header">
									<div className="extension-info">
										<div className="extension-name-row">
											<span className="extension-name">
												{ext.displayName || ext.name}
											</span>
											<span className="extension-version">{ext.version}</span>
											{ext.error && (
												<span
													className="extension-error"
													title={ext.error}
												>
													⚠
												</span>
											)}
										</div>
										<div className="extension-meta">
											{ext.publisher && (
												<span className="extension-publisher">
													{ext.publisher}
												</span>
											)}
											{ext.categories?.length && (
												<span className="extension-categories">
													{ext.categories.join(', ')}
												</span>
											)}
										</div>
										{ext.description && (
											<div className="extension-description">
												{ext.description}
											</div>
										)}
									</div>
									<div className="extension-actions">
										{ext.isActive ? (
											<button
												className="icon-btn small"
												onClick={() => handleToggle(ext.id, false)}
												title="Disable"
											>
												⏸
											</button>
										) : (
											<button
												className="icon-btn small"
												onClick={() => handleToggle(ext.id, true)}
												title="Enable"
												disabled={!!ext.error}
											>
												▶
											</button>
										)}
										{getExtensionConfiguration(ext.id) && (
											<button
												className="icon-btn small"
												onClick={() => setSettingsExtensionId(ext.id)}
												title="Settings"
											>
												⚙
											</button>
										)}
										<button
											className="icon-btn small"
											onClick={() => handleUninstall(ext.id)}
											title="Uninstall"
										>
											🗑
										</button>
									</div>
								</div>
							</li>
						))}
					</ul>
				)}
			</div>

			{settingsExtensionId && (
				<ExtensionSettings
					extensionId={settingsExtensionId}
					onClose={() => setSettingsExtensionId(null)}
				/>
			)}

			<div
				className="muted small"
				style={{padding: '8px 10px', borderTop: '1px solid var(--border)'}}
			>
				{extensions.length} installed,{' '}
				{extensions.filter(e => e.isActive).length} active
			</div>
		</div>
	)
}
