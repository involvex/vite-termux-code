import {useCallback, useEffect, useState} from 'react'
import {api, type FileItem} from '../lib/api'
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
	const {showHidden, setShowHidden, openTab, setStatus, gitDirty, gitBranch} =
		useAppStore()
	const [root, setRoot] = useState<FileItem[]>([])
	const [expanded, setExpanded] = useState<Record<string, FileItem[]>>({
		'|': [],
	})
	const [openDirs, setOpenDirs] = useState<Set<string>>(new Set(['']))
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState('')
	const [filter, setFilter] = useState('')
	const [gitMap, setGitMap] = useState<Record<string, GitMark>>({})
	const [dirDirty, setDirDirty] = useState<Set<string>>(new Set())

	const loadDir = useCallback(
		async (dirPath: string) => {
			setLoading(true)
			try {
				const res = await api.list(dirPath, showHidden)
				setExpanded(prev => ({...prev, [dirPath]: res.items}))
				if (dirPath === '') setRoot(res.items)
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
		void loadDir('')
		// reload all open dirs when hidden toggle changes
		for (const d of openDirs) void loadDir(d)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [showHidden])

	const refreshGit = useCallback(async () => {
		try {
			const s = await api.gitStatus()
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
		void refreshGit()
	}, [refreshGit, gitDirty, gitBranch])

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
		void refreshGit()
	}

	const collapseAll = () => {
		setOpenDirs(new Set(['']))
		void loadDir('')
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
				const res = await api.list(cur.p, showHidden).catch(() => null)
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
			if (next['']) setRoot(next[''])
			setError('')
		} catch (e) {
			setError(e instanceof Error ? e.message : 'expand failed')
		} finally {
			setLoading(false)
		}
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

	const renderItems = (items: FileItem[], depth: number) => (
		<ul className={depth === 0 ? 'tree' : 'tree nested'}>
			{items.map(item => {
				const isDir = item.type === 'dir'
				if (!matches(item) && !(isDir && dirHasMatch(item.path, 0))) return null
				const isOpen = openDirs.has(item.path)
				const children = expanded[item.path] ?? []
				const badge = !isDir ? fileBadge(item.name) : null
				const mark = !isDir ? gitMap[item.path] : undefined
				const dirty = isDir && dirDirty.has(item.path)
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
				{renderItems(root.length ? root : (expanded[''] ?? []), 0)}
			</div>
			<div className="muted small">
				long-press / right-click a file for rename/delete
			</div>
		</div>
	)
}
