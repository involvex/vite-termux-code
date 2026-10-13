import {useCallback, useEffect, useState} from 'react'
import {api, type FileItem} from '../lib/api'
import {useAppStore} from '../store/useAppStore'

export default function FileTree() {
	const {showHidden, setShowHidden, openTab, setStatus} = useAppStore()
	const [root, setRoot] = useState<FileItem[]>([])
	const [expanded, setExpanded] = useState<Record<string, FileItem[]>>({
		'|': [],
	})
	const [openDirs, setOpenDirs] = useState<Set<string>>(new Set(['']))
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState('')

	const loadDir = useCallback(
		async (dirPath: string) => {
			setLoading(true)
			try {
				const res = await api.list(dirPath, showHidden)
				setExpanded(prev => ({...prev, [dirPath]: res.items}))
				if (dirPath === '') setRoot(res.items)
				setError('')
			} catch (e) {
				setError(e instanceof Error ? e.message : 'failed to list')
			} finally {
				setLoading(false)
			}
		},
		[showHidden],
	)

	useEffect(() => {
		void loadDir('')
		// reload all open dirs when hidden toggle changes
		for (const d of openDirs) void loadDir(d)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [showHidden])

	const toggle = (dirPath: string) => {
		setOpenDirs(prev => {
			const next = new Set(prev)
			if (next.has(dirPath)) next.delete(dirPath)
			else {
				next.add(dirPath)
				void loadDir(dirPath)
			}
			return next
		})
	}

	const openFile = async (item: FileItem) => {
		try {
			setStatus(`opening ${item.path}…`)
			const data = await api.read(item.path)
			if (data.binary) {
				openTab({
					path: item.path,
					content: '',
					savedContent: '',
					mtime: data.mtime,
					binary: true,
				})
			} else {
				openTab({
					path: item.path,
					content: data.content ?? '',
					savedContent: data.content ?? '',
					mtime: data.mtime,
					truncated: data.truncated,
				})
			}
			setStatus(data.truncated ? 'large file: read-only preview' : 'ready')
		} catch (e) {
			setStatus(e instanceof Error ? e.message : 'open failed')
		}
	}

	const refresh = () => {
		for (const d of openDirs) void loadDir(d)
		void loadDir('')
	}

	const createEntry = async (kind: 'file' | 'dir') => {
		const name = window.prompt(
			kind === 'file'
				? 'New file path (relative):'
				: 'New folder path (relative):',
		)
		if (!name) return
		try {
			if (kind === 'file') await api.save(name.replace(/^\//, ''), '')
			else await api.mkdir(name.replace(/^\//, ''))
			refresh()
			setStatus('created')
		} catch (e) {
			setStatus(e instanceof Error ? e.message : 'create failed')
		}
	}

	const renameEntry = async (item: FileItem) => {
		const to = window.prompt('Rename to (relative path):', item.path)
		if (!to || to === item.path) return
		try {
			await api.rename(item.path, to)
			refresh()
		} catch (e) {
			setStatus(e instanceof Error ? e.message : 'rename failed')
		}
	}

	const deleteEntry = async (item: FileItem) => {
		if (!window.confirm(`Delete ${item.path}?`)) return
		try {
			await api.remove(item.path)
			refresh()
		} catch (e) {
			setStatus(e instanceof Error ? e.message : 'delete failed')
		}
	}

	const renderItems = (items: FileItem[], depth: number) => (
		<ul className={depth === 0 ? 'tree' : 'tree nested'}>
			{items.map(item => {
				const isDir = item.type === 'dir'
				const isOpen = openDirs.has(item.path)
				const children = expanded[item.path] ?? []
				return (
					<li key={item.path}>
						<div
							className="tree-row"
							style={{paddingLeft: 8 + depth * 14}}
							onClick={() => (isDir ? toggle(item.path) : void openFile(item))}
							onContextMenu={e => {
								e.preventDefault()
								const action = window.prompt(
									`Actions for ${item.path}:\n1=rename  2=delete  3=new file here  4=new folder here`,
									'1',
								)
								if (action === '1') void renameEntry(item)
								else if (action === '2') void deleteEntry(item)
								else if (action === '3') {
									const n = window.prompt(
										'New file name:',
										`${item.type === 'dir' ? item.path : item.path.split('/').slice(0, -1).join('/')}/untitled.txt`,
									)
									if (n) void api.save(n, '').then(refresh)
								} else if (action === '4') {
									const n = window.prompt(
										'New folder name:',
										`${item.path}/new-folder`,
									)
									if (n) void api.mkdir(n).then(refresh)
								}
							}}
						>
							<span className="tree-icon">
								{isDir ? (isOpen ? '📂' : '📁') : '📄'}
							</span>
							<span
								className="tree-name"
								title={item.path}
							>
								{item.name}
							</span>
						</div>
						{isDir && isOpen && renderItems(children, depth + 1)}
					</li>
				)
			})}
		</ul>
	)

	return (
		<div className="panel-col">
			<div className="panel-toolbar">
				<span className="panel-title">Explorer</span>
				<button
					className="icon-btn"
					title="Refresh"
					onClick={refresh}
				>
					↻
				</button>
				<button
					className="icon-btn"
					title="New file"
					onClick={() => void createEntry('file')}
				>
					+📄
				</button>
				<button
					className="icon-btn"
					title="New folder"
					onClick={() => void createEntry('dir')}
				>
					+📁
				</button>
			</div>
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
				{renderItems(root.length ? root : (expanded[''] ?? []), 0)}
			</div>
			<div className="muted small">
				long-press / right-click a file for rename/delete
			</div>
		</div>
	)
}
