/**
 * Marketplace Panel Component
 *
 * Browse and install extensions from the marketplace.
 */

import {useCallback, useEffect, useState} from 'react'
import {getInstalledExtensions, installExtension} from '../lib/extensionHost'
import {
	fetchMarketplaceIndex,
	getMarketplaceCategories,
	searchMarketplace,
	type MarketplaceEntry,
	type MarketplaceIndex,
} from '../lib/marketplace'
import {useAppStore} from '../store/useAppStore'

export default function MarketplacePanel() {
	const {setStatus} = useAppStore()
	const [marketplace, setMarketplace] = useState<MarketplaceIndex | null>(null)
	const [filtered, setFiltered] = useState<MarketplaceEntry[]>([])
	const [loading, setLoading] = useState(true)
	const [installing, setInstalling] = useState<string | null>(null)
	const [searchQuery, setSearchQuery] = useState('')
	const [selectedCategory, setSelectedCategory] = useState<string>('All')
	const [categories, setCategories] = useState<string[]>([])
	const [error, setError] = useState<string | null>(null)

	const loadMarketplace = useCallback(async () => {
		setLoading(true)
		setError(null)
		try {
			const index = await fetchMarketplaceIndex()
			setMarketplace(index)
			setCategories(['All', ...getMarketplaceCategories(index)])
			setFiltered(index.extensions)
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Failed to load marketplace')
			// Fallback to default
			const index = await fetchMarketplaceIndex('')
			setMarketplace(index)
			setCategories(['All', ...getMarketplaceCategories(index)])
			setFiltered(index.extensions)
		} finally {
			setLoading(false)
		}
	}, [])

	useEffect(() => {
		loadMarketplace()
	}, [loadMarketplace])

	useEffect(() => {
		if (!marketplace) return
		let results = marketplace.extensions

		if (searchQuery) {
			results = searchMarketplace(
				marketplace,
				searchQuery,
				selectedCategory === 'All' ? undefined : selectedCategory,
			)
		} else if (selectedCategory !== 'All') {
			results = results.filter(ext => ext.categories.includes(selectedCategory))
		}

		setFiltered(results)
	}, [marketplace, searchQuery, selectedCategory])

	const isInstalled = (entry: MarketplaceEntry) => {
		const installed = getInstalledExtensions()
		return installed.some(
			ext =>
				ext.manifest.name === entry.name &&
				ext.manifest.publisher === entry.publisher,
		)
	}

	const handleInstall = async (entry: MarketplaceEntry) => {
		setInstalling(entry.name)
		setStatus(`Installing ${entry.displayName}...`)
		try {
			await installExtension(entry.installUrl)
			setStatus(`${entry.displayName} installed`)
			// Refresh to update installed status
			// Note: getInstalledExtensions reads from localStorage directly
		} catch (e) {
			setStatus(e instanceof Error ? e.message : 'Install failed')
		} finally {
			setInstalling(null)
		}
	}

	if (loading) {
		return (
			<div
				className="panel-col"
				style={{padding: 20, textAlign: 'center'}}
			>
				<div className="muted">Loading marketplace…</div>
			</div>
		)
	}

	if (error && !marketplace) {
		return (
			<div
				className="panel-col"
				style={{padding: 20}}
			>
				<div className="error">Failed to load marketplace: {error}</div>
				<button
					className="icon-btn"
					onClick={loadMarketplace}
					style={{marginTop: 10}}
				>
					Retry
				</button>
			</div>
		)
	}

	return (
		<div className="panel-col">
			<div className="panel-toolbar">
				<span className="panel-title">Marketplace</span>
				<button
					className="icon-btn"
					title="Refresh"
					onClick={loadMarketplace}
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
				<select
					className="tree-filter"
					value={selectedCategory}
					onChange={e => setSelectedCategory(e.target.value)}
					style={{width: '100%'}}
				>
					{categories.map(cat => (
						<option
							key={cat}
							value={cat}
						>
							{cat}
						</option>
					))}
				</select>
			</div>

			{error && (
				<div
					className="error"
					style={{padding: '8px 10px', borderBottom: '1px solid var(--border)'}}
				>
					{error}
				</div>
			)}

			<div
				className="tree-wrap"
				style={{flex: 1, overflow: 'auto'}}
			>
				{filtered.length === 0 ? (
					<div
						className="muted"
						style={{padding: 20, textAlign: 'center'}}
					>
						No extensions found.{searchQuery && ' Try a different search.'}
					</div>
				) : (
					<ul className="tree">
						{filtered.map(entry => (
							<li
								key={`${entry.publisher}.${entry.name}`}
								className="extension-item"
							>
								<div className="extension-header">
									<div className="extension-info">
										<div className="extension-name-row">
											<span className="extension-name">
												{entry.displayName}
											</span>
											<span className="extension-version">{entry.version}</span>
										</div>
										<div className="extension-meta">
											<span className="extension-publisher">
												{entry.publisher}
											</span>
											{entry.categories.length && (
												<span className="extension-categories">
													{entry.categories.join(', ')}
												</span>
											)}
											<span className="extension-rating">
												{'⭐'.repeat(Math.floor(entry.rating))} {entry.rating} (
												{entry.downloads.toLocaleString()} downloads)
											</span>
										</div>
										<div className="extension-description">
											{entry.description}
										</div>
										{entry.keywords?.length && (
											<div
												className="extension-keywords"
												style={{
													fontSize: '11px',
													color: 'var(--text-dim)',
													marginTop: 4,
												}}
											>
												{entry.keywords.map(k => (
													<span
														key={k}
														style={{marginRight: 4}}
													>
														#{k}
													</span>
												))}
											</div>
										)}
									</div>
									<div className="extension-actions">
										{isInstalled(entry) ? (
											<button
												className="icon-btn small"
												disabled
												title="Already installed"
											>
												✓
											</button>
										) : (
											<button
												className="icon-btn small"
												onClick={() => handleInstall(entry)}
												disabled={!!installing}
												title="Install"
											>
												{installing === entry.name ? '⏳' : '⬇'}
											</button>
										)}
									</div>
								</div>
							</li>
						))}
					</ul>
				)}
			</div>

			<div
				className="muted small"
				style={{padding: '8px 10px', borderTop: '1px solid var(--border)'}}
			>
				{filtered.length} of {marketplace?.extensions.length ?? 0} extensions
			</div>
		</div>
	)
}
