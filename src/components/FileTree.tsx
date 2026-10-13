import {useCallback, useEffect, useRef, useState} from 'react'
import {api, type FileItem, type Workspace} from '../lib/api'
import {notifyFileCreated, notifyFileDeleted} from '../lib/extensionApi'
import {fileBadge} from '../lib/icons'
import {useAppStore} from '../store/useAppStore'

interface GitMark {
	letter: string
	title: string
}

const EXPAND_SKIP = new Set([
	'node_modules',
	'.git',
	'dist',
	'__pycache__',
	'.hg',
])

export default function FileTree() {
	const {
		workspaces,
		activeWorkspace,
		setActiveWorkspace,
		showHidden,
		setShowHidden,
		openTab,
		setStatus,
		gitDirty,
		gitBranch,
		removeWorkspace,
	} = useAppStore()

	const [expanded, setExpanded] = useState<Record<string, FileItem[]>>({'': []})
	const [openDirs, setOpenDirs] = useState<Set<string>>(new Set(['']))
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState('')
	const [filter, setFilter] = useState('')
	const [gitMap, setGitMap] = useState<Record<string, GitMark>>({})
	const [dirDirty, setDirDirty] = useState<Set<string>>(new Set())
	const [draggedWorkspace, setDraggedWorkspace] = useState<number | null>(null)
	const [dragOverWorkspace, setDragOverWorkspace] = useState<number | null>(
		null,
	)
	const [contextMenu, setContextMenu] = useState<{
		x: number
		y: number
		wsIndex: number
	} | null>(null)
	const contextMenuRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		const handleClick = () => setContextMenu(null)
		window.addEventListener('click', handleClick)
		return () => window.removeEventListener('click', handleClick)
	}, [])

	const loadDir = useCallback(
		async (dirPath: string, wsIndex?: number) => {
			setLoading(true)
			try {
				const res = await api.list(dirPath, showHidden, wsIndex)
				setExpanded(prev => ({...prev, [dirPath]: res.items}))
				setError('')
				return res.items
			} catch (e) {
				setError(e instanceof Error ? e.message : 'failed to list')
				return null
			} finally {
				setLoading(false)
			}
		},
		[showHidden],
	)

	useEffect(() => {
		void loadDir('', activeWorkspace)
		// reload all open dirs when hidden toggle changes
		for (const d of openDirs) void loadDir(d, activeWorkspace)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [showHidden, activeWorkspace])

	const refreshGit = useCallback(async (wsIndex?: number) => {
		try {
			const s = await api.gitStatus(wsIndex)
			if (!s.repo) {
				setGitMap({})
				setDirDirty(new Set())
				return
			}
			const map: Record<string, GitMark> = {}
			for (const f of s.staged ?? []) {
				map[f.path] = {letter: f.kind, title: `staged ${f.kind}`}
			}
			for (const f of s.unstaged ?? []) {
				map[f.path] = {letter: f.kind, title: `unstaged ${f.kind}`}
			}
			for (const p of s.untracked ?? []) {
				if (!map[p]) map[p] = {letter: '?', title: 'untracked'}
			}
			setGitMap(map)
			// mark ancestor dirs so collapsed folders hint at changes inside
			const dirs = new Set<string>()
			for (const p of Object.keys(map)) {
				const parts = p.split('/')
				for (let i = 1; i < parts.length; i++) {
					dirs.add(parts.slice(0, i).join('/'))
				}
			}
			setDirDirty(dirs)
		} catch {
			/* not a repo or git missing — no badges */
		}
	}, [])

	// refresh badges on mount, on manual refresh, and whenever the
	// Source Control tab reports a new dirty count / branch
	useEffect(() => {
		void refreshGit(activeWorkspace)
	}, [refreshGit, gitDirty, gitBranch, activeWorkspace])

	const toggle = (dirPath: string, wsIndex?: number) => {
		setOpenDirs(prev => {
			const next = new Set(prev)
			if (next.has(dirPath)) next.delete(dirPath)
			else {
				next.add(dirPath)
				void loadDir(dirPath, wsIndex)
			}
			return next
		})
	}

	const openFile = async (item: FileItem, wsIndex?: number) => {
		try {
			setStatus(`opening ${item.path}…`)
			const data = await api.read(item.path, wsIndex)
			if (data.binary) {
				openTab({
					path: item.path,
					content: '',
					savedContent: '',
					mtime: data.mtime,
					binary: true,
					workspace: wsIndex,
				})
			} else {
				openTab({
					path: item.path,
					content: data.content ?? '',
					savedContent: data.content ?? '',
					mtime: data.mtime,
					truncated: data.truncated,
					workspace: wsIndex,
				})
			}
			setStatus(data.truncated ? 'large file: read-only preview' : 'ready')
		} catch (e) {
			setStatus(e instanceof Error ? e.message : 'open failed')
		}
	}

	const refresh = () => {
		for (const d of openDirs) void loadDir(d, activeWorkspace)
		void loadDir('', activeWorkspace)
		void refreshGit(activeWorkspace)
	}

	const collapseAll = () => {
		setOpenDirs(new Set(['']))
		void loadDir('', activeWorkspace)
	}

	const expandAll = async () => {
		setLoading(true)
		try {
			const queue: {p: string; d: number}[] = [{p: '', d: 0}]
			const opened = new Set<string>([''])
			const next: Record<string, FileItem[]> = {}
			let count = 0
			while (queue.length > 0 && count < 60) {
				const cur = queue.shift()
				if (!cur || cur.d >= 3) continue
				const res = await api
					.list(cur.p, showHidden, activeWorkspace)
					.catch(() => null)
				if (!res) continue
				next[cur.p] = res.items
				opened.add(cur.p)
				count++
				for (const it of res.items) {
					if (
						it.type === 'dir' &&
						!EXPAND_SKIP.has(it.name) &&
						!opened.has(it.path)
					) {
						queue.push({p: it.path, d: cur.d + 1})
					}
				}
			}
			setExpanded(prev => ({...prev, ...next}))
			setOpenDirs(opened)
			setError('')
		} catch (e) {
			setError(e instanceof Error ? e.message : 'expand failed')
		} finally {
			setLoading(false)
		}
	}

	const createEntry = async (kind: 'file' | 'dir', wsIndex?: number) => {
		const name = window.prompt(
			kind === 'file'
				? 'New file path (relative):'
				: 'New folder path (relative):',
		)
		if (!name) return
		try {
			if (kind === 'file') {
				await api.save(name.replace(/^\//, ''), '', wsIndex)
				notifyFileCreated(name.replace(/^\//, ''), wsIndex ?? activeWorkspace)
			} else {
				await api.mkdir(name.replace(/^\//, ''), wsIndex)
				notifyFileCreated(name.replace(/^\//, ''), wsIndex ?? activeWorkspace)
			}
			refresh()
			setStatus('created')
		} catch (e) {
			setStatus(e instanceof Error ? e.message : 'create failed')
		}
	}

	const renameEntry = async (item: FileItem, wsIndex?: number) => {
		const to = window.prompt('Rename to (relative path):', item.path)
		if (!to || to === item.path) return
		try {
			await api.rename(item.path, to, wsIndex)
			notifyFileDeleted(item.path, wsIndex ?? activeWorkspace)
			notifyFileCreated(to, wsIndex ?? activeWorkspace)
			refresh()
		} catch (e) {
			setStatus(e instanceof Error ? e.message : 'rename failed')
		}
	}

	const deleteEntry = async (item: FileItem, wsIndex?: number) => {
		if (!window.confirm(`Delete ${item.path}?`)) return
		try {
			await api.remove(item.path, wsIndex)
			notifyFileDeleted(item.path, wsIndex ?? activeWorkspace)
			refresh()
		} catch (e) {
			setStatus(e instanceof Error ? e.message : 'delete failed')
		}
	}

	// Drag and drop handlers for workspace reordering
	const handleDragStart = (e: React.DragEvent, index: number) => {
		setDraggedWorkspace(index)
		e.dataTransfer.effectAllowed = 'move'
		e.dataTransfer.setData('text/plain', index.toString())
	}

	const handleDragOver = (e: React.DragEvent, index: number) => {
		e.preventDefault()
		e.dataTransfer.dropEffect = 'move'
		if (index !== draggedWorkspace) {
			setDragOverWorkspace(index)
		}
	}

	const handleDragLeave = () => {
		setDragOverWorkspace(null)
	}

	const handleDrop = (e: React.DragEvent, targetIndex: number) => {
		e.preventDefault()
		const sourceIndex = draggedWorkspace
		if (sourceIndex === null || sourceIndex === targetIndex) {
			setDraggedWorkspace(null)
			setDragOverWorkspace(null)
			return
		}

		// Reorder workspaces
		const newWorkspaces = [...workspaces]
		const [removed] = newWorkspaces.splice(sourceIndex, 1)
		newWorkspaces.splice(targetIndex, 0, removed)

		// Update indices
		const updatedWorkspaces = newWorkspaces.map((w, i) => ({...w, index: i}))

		// Update store and localStorage
		useAppStore.getState().setWorkspaces(updatedWorkspaces)

		// Adjust active workspace if needed
		let newActive = activeWorkspace
		if (activeWorkspace === sourceIndex) {
			newActive = targetIndex
		} else if (
			activeWorkspace > sourceIndex &&
			activeWorkspace <= targetIndex
		) {
			newActive = activeWorkspace - 1
		} else if (
			activeWorkspace < sourceIndex &&
			activeWorkspace >= targetIndex
		) {
			newActive = activeWorkspace + 1
		}
		if (newActive !== activeWorkspace) {
			setActiveWorkspace(newActive)
		}

		setDraggedWorkspace(null)
		setDragOverWorkspace(null)
	}

	const handleDragEnd = () => {
		setDraggedWorkspace(null)
		setDragOverWorkspace(null)
	}

	const handleWorkspaceContextMenu = (e: React.MouseEvent, wsIndex: number) => {
		e.preventDefault()
		e.stopPropagation()
		setContextMenu({x: e.clientX, y: e.clientY, wsIndex})
	}

	const handleRenameWorkspace = (wsIndex: number) => {
		const ws = workspaces[wsIndex]
		const newName = window.prompt('Rename workspace:', ws.name || '')
		if (!newName || newName === ws.name) {
			setContextMenu(null)
			return
		}
		api
			.updateWorkspace(wsIndex, {name: newName})
			.then(() => {
				// Update local store
				useAppStore
					.getState()
					.setWorkspaces(
						workspaces.map((w, i) =>
							i === wsIndex ? {...w, name: newName} : w,
						),
					)
				setStatus('workspace renamed')
			})
			.catch(e => {
				setStatus(e instanceof Error ? e.message : 'rename workspace failed')
			})
			.finally(() => {
				setContextMenu(null)
			})
	}

	const handleRemoveWorkspace = (wsIndex: number) => {
		if (workspaces.length <= 1) {
			setStatus('Cannot remove the last workspace')
			return
		}
		const ws = workspaces[wsIndex]
		if (!window.confirm(`Remove workspace "${ws.name}" (${ws.rootDir})?`)) {
			setContextMenu(null)
			return
		}

		// Call API to remove workspace
		api
			.removeWorkspace(wsIndex)
			.then(() => {
				// Update local store
				removeWorkspace(wsIndex)
				setStatus('workspace removed')
			})
			.catch(e => {
				setStatus(e instanceof Error ? e.message : 'remove workspace failed')
			})
			.finally(() => {
				setContextMenu(null)
			})
	}

	const q = filter.trim().toLowerCase()
	const matches = (item: FileItem) => !q || item.name.toLowerCase().includes(q)
	const dirHasMatch = (dirPath: string, depth: number): boolean => {
		if (depth > 8) return false
		for (const c of expanded[dirPath] ?? []) {
			if (matches(c)) return true
			if (c.type === 'dir' && dirHasMatch(c.path, depth + 1)) return true
		}
		return false
	}

	// Render a single workspace tree
	const renderWorkspace = (ws: Workspace, index: number, isActive: boolean) => {
		const items = expanded[''] ?? []
		const wsRootName =
			ws.name || ws.rootDir.split(/[/\\]/).pop() || `Workspace ${index + 1}`

		const renderItems = (items: FileItem[], depth: number) => (
			<ul className={depth === 0 ? 'tree' : 'tree nested'}>
				{items.map(item => {
					const isDir = item.type === 'dir'
					if (!matches(item) && !(isDir && dirHasMatch(item.path, 0)))
						return null
					const isOpen = openDirs.has(item.path)
					const children = expanded[item.path] ?? []
					const badge = !isDir ? fileBadge(item.name) : null
					const mark = !isDir ? gitMap[item.path] : undefined
					const dirty = isDir && dirDirty.has(item.path)
					return (
						<li key={`${index}:${item.path}`}>
							<div
								className="tree-row"
								style={{paddingLeft: 8 + depth * 14}}
								onClick={() =>
									isDir ? toggle(item.path, index) : void openFile(item, index)
								}
								onContextMenu={e => {
									e.preventDefault()
									const action = window.prompt(
										`Actions for ${item.path}:\n1=rename  2=delete  3=new file here  4=new folder here`,
										'1',
									)
									if (action === '1') void renameEntry(item, index)
									else if (action === '2') void deleteEntry(item, index)
									else if (action === '3') {
										const n = window.prompt(
											'New file name:',
											`${item.type === 'dir' ? item.path : item.path.split('/').slice(0, -1).join('/')}/untitled.txt`,
										)
										if (n) void api.save(n, '', index).then(refresh)
									} else if (action === '4') {
										const n = window.prompt(
											'New folder name:',
											`${item.path}/new-folder`,
										)
										if (n) void api.mkdir(n, index).then(refresh)
									}
								}}
							>
								<span className="tree-icon">
									{isDir ? (
										isOpen ? (
											'📂'
										) : (
											'📁'
										)
									) : badge ? (
										<span
											className={`fbadge ${badge.className}`}
											title={item.name}
										>
											{badge.text}
										</span>
									) : (
										'📄'
									)}
								</span>
								<span
									className="tree-name"
									title={mark ? `${item.path} (${mark.title})` : item.path}
								>
									{item.name}
								</span>
								{mark && (
									<span
										className={`git-kind k-${mark.letter}`}
										title={mark.title}
									>
										{mark.letter}
									</span>
								)}
								{dirty && (
									<span
										className="tree-dirty"
										title="contains changes"
									>
										•
									</span>
								)}
							</div>
							{isDir && isOpen && renderItems(children, depth + 1)}
						</li>
					)
				})}
			</ul>
		)

		const isDragged = draggedWorkspace === index
		const isDragOver = dragOverWorkspace === index

		return (
			<div className="workspace-root">
				<div
					className={`tree-row workspace-header ${isActive ? 'active' : ''} ${isDragged ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''}`}
					onClick={() => setActiveWorkspace(index)}
					onDragStart={e => handleDragStart(e, index)}
					onDragOver={e => handleDragOver(e, index)}
					onDragLeave={handleDragLeave}
					onDrop={e => handleDrop(e, index)}
					onDragEnd={handleDragEnd}
					onContextMenu={e => handleWorkspaceContextMenu(e, index)}
					draggable
					style={{
						paddingLeft: 8,
						fontWeight: isActive ? 600 : 400,
						opacity: isDragged ? 0.5 : 1,
						backgroundColor: isDragOver
							? 'var(--drag-over-bg, rgba(100, 150, 255, 0.2))'
							: 'transparent',
					}}
				>
					<span className="tree-icon">📦</span>
					<span
						className="tree-name"
						title={ws.rootDir}
					>
						{wsRootName}
					</span>
					<span className="workspace-path muted small">{ws.rootDir}</span>
					{workspaces.length > 1 && (
						<span
							className="drag-handle"
							title="Drag to reorder"
						>
							⋮⋮
						</span>
					)}
				</div>
				{isActive && renderItems(items, 0)}
			</div>
		)
	}

	return (
		<div className="panel-col">
			<div className="panel-toolbar">
				<span className="panel-title">Explorer</span>
				<button
					className="icon-btn"
					title="Add workspace folder"
					onClick={async () => {
						const path = window.prompt('Enter workspace folder path:')
						if (path) {
							try {
								await api.addWorkspace(path)
								await api.workspaces().then(ws => {
									useAppStore.getState().setWorkspaces(ws.workspaces)
								})
								setStatus('workspace added')
							} catch (e) {
								setStatus(
									e instanceof Error ? e.message : 'add workspace failed',
								)
							}
						}
					}}
				>
					+📦
				</button>
				<button
					className="icon-btn"
					title="Refresh"
					onClick={refresh}
				>
					↻
				</button>
				<button
					className="icon-btn"
					title="Expand all (3 levels)"
					onClick={() => void expandAll()}
				>
					⏵
				</button>
				<button
					className="icon-btn"
					title="Collapse all"
					onClick={collapseAll}
				>
					⏷
				</button>
				<button
					className="icon-btn"
					title="New file"
					onClick={() => void createEntry('file', activeWorkspace)}
				>
					+📄
				</button>
				<button
					className="icon-btn"
					title="New folder"
					onClick={() => void createEntry('dir', activeWorkspace)}
				>
					+📁
				</button>
			</div>
			<input
				className="tree-filter"
				value={filter}
				onChange={e => setFilter(e.target.value)}
				placeholder="filter files…"
				spellCheck={false}
			/>
			<label className="hidden-toggle">
				<input
					type="checkbox"
					checked={showHidden}
					onChange={e => setShowHidden(e.target.checked)}
				/>{' '}
				show hidden
			</label>
			{loading && <div className="muted">loading…</div>}
			{error && <div className="error">{error}</div>}
			<div className="tree-wrap">
				{workspaces.map((ws, i) =>
					renderWorkspace(ws, i, i === activeWorkspace),
				)}
			</div>
			{contextMenu && (
				<div
					ref={contextMenuRef}
					className="workspace-context-menu"
					style={{
						left: contextMenu.x,
						top: contextMenu.y,
					}}
				>
					<button
						className="context-menu-item"
						onClick={() => handleRenameWorkspace(contextMenu.wsIndex)}
					>
						Rename workspace
					</button>
					<button
						className="context-menu-item danger"
						onClick={() => handleRemoveWorkspace(contextMenu.wsIndex)}
					>
						Remove workspace
					</button>
					<button
						className="context-menu-item"
						onClick={() => setContextMenu(null)}
					>
						Cancel
					</button>
				</div>
			)}
			<div className="muted small">
				long-press / right-click a file for rename/delete; right-click workspace
				header to remove
			</div>
		</div>
	)
}
