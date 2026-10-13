import {useEffect, useState} from 'react'
import './App.css'
import BrowserFrame from './components/BrowserFrame'
import CommandPalette from './components/CommandPalette'
import DebugPanel from './components/DebugPanel'
import EditorTabs from './components/EditorTabs'
import FileTree from './components/FileTree'
import GitPanel from './components/GitPanel'
import Reloadable from './components/Reloadable'
import SearchPanel from './components/SearchPanel'
import StatusBar from './components/StatusBar'
import TasksPanel from './components/TasksPanel'
import {api, wsUrl} from './lib/api'
import {dapClient} from './lib/dap'
import {useAppStore} from './store/useAppStore'

export default function App() {
	const {
		workspaces,
		activeWorkspace,
		setActiveWorkspace,
		panel,
		setPanel,
		setConnected,
		setStatus,
		sidebarOpen,
		setSidebarOpen,
		terminalOpen,
		setTerminalOpen,
		setGit,
		tabs,
		updateTab,
		settings,
	} = useAppStore()
	const [termMounted, setTermMounted] = useState(terminalOpen)

	useEffect(() => {
		if (terminalOpen) setTermMounted(true)
	}, [terminalOpen])

	useEffect(() => {
		api
			.health()
			.then(h => {
				// Update workspaces if available
				if (h.roots && Array.isArray(h.roots)) {
					const ws = h.roots.map((rootDir, index) => ({
						rootDir,
						name: rootDir.split(/[/\\]/).pop() || `Workspace ${index + 1}`,
						index,
					}))
					useAppStore.getState().setWorkspaces(ws)
				}
				setStatus(`td-code v${h.version}`)
			})
			.catch(e => setStatus(e instanceof Error ? e.message : 'offline'))
		// best-effort branch indicator for the status bar (GitPanel refreshes it too)
		api
			.gitStatus(activeWorkspace)
			.then(s => {
				if (s.repo) {
					setGit(
						s.branch ?? null,
						(s.staged?.length ?? 0) +
							(s.unstaged?.length ?? 0) +
							(s.untracked?.length ?? 0),
					)
				}
			})
			.catch(() => {})
	}, [setStatus, setGit, activeWorkspace])

	// file watcher socket
	useEffect(() => {
		let ws: WebSocket | null = null
		let retry = 0
		let closed = false
		const connect = () => {
			try {
				ws = new WebSocket(wsUrl())
			} catch {
				return
			}
			ws.onopen = () => {
				setConnected(true)
				retry = 0
			}
			ws.onclose = () => {
				setConnected(false)
				if (!closed && retry < 10) {
					retry++
					setTimeout(connect, Math.min(5000, 500 * retry))
				}
			}
			ws.onerror = () => ws?.close()
			ws.onmessage = ev => {
				try {
					const msg = JSON.parse(ev.data as string) as {
						type: string
						path?: string
						root?: string
					}
					if (msg.type === 'change' && msg.path) {
						// Find which workspace this change belongs to
						const wsIndex = workspaces.findIndex(w => w.rootDir === msg.root)
						const open = tabs.find(
							t => t.path === msg.path && t.workspace === wsIndex,
						)
						// auto-reload only if user has no unsaved edits
						if (open && open.content === open.savedContent) {
							api
								.read(msg.path as string, wsIndex)
								.then(d => {
									if (!d.binary && d.content !== undefined) {
										updateTab(msg.path as string, {
											content: d.content,
											savedContent: d.content,
											mtime: d.mtime,
										})
									}
								})
								.catch(() => {})
						}
					}
				} catch {
					/* ignore */
				}
			}
		}
		connect()
		return () => {
			closed = true
			ws?.close()
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// global Ctrl+S + Ctrl+` (terminal) + Ctrl+Shift+P / F1 / Ctrl+P (palette)
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
				// handled inside EditorTabs tabbar; prevent browser save dialog globally
				if ((e.target as HTMLElement)?.closest?.('.browser-frame')) return
				e.preventDefault()
			}
			if (e.ctrlKey && e.key === '`') {
				if ((e.target as HTMLElement)?.closest?.('.browser-frame')) return
				e.preventDefault()
				setTerminalOpen(!useAppStore.getState().terminalOpen)
			}
			const inFrame = (e.target as HTMLElement)?.closest?.(
				'.browser-frame, .xterm',
			)
			if (e.key === 'F1' && !inFrame) {
				e.preventDefault()
				useAppStore.getState().setPaletteOpen(true)
			}
			const dbg = useAppStore.getState().debug
			if (
				dbg.active &&
				(e.key === 'F5' || e.key === 'F10' || e.key === 'F11') &&
				!inFrame
			) {
				e.preventDefault()
				const threadId = dbg.stopped?.threadId
				if (threadId === undefined || threadId === null) return
				const cmd =
					e.key === 'F5' ? 'continue' : e.key === 'F10' ? 'next' : 'stepIn'
				dapClient
					.request(cmd, {threadId})
					.catch(err =>
						useAppStore
							.getState()
							.setStatus(err instanceof Error ? err.message : 'step failed'),
					)
				return
			}
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p' && !inFrame) {
				// Ctrl+P and Ctrl+Shift+P both open the palette
				e.preventDefault()
				useAppStore.getState().setPaletteOpen(true)
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [setTerminalOpen])

	return (
		<div
			className="ide"
			data-theme={settings.theme}
			style={{
				['--editor-font-size' as string]: `${settings.fontSize}px`,
			}}
		>
			<div className="activitybar">
				<button
					className={`act ${panel === 'explorer' ? 'active' : ''}`}
					title="Explorer"
					onClick={() => {
						setPanel('explorer')
						setSidebarOpen(true)
					}}
				>
					📁
				</button>
				<button
					className={`act ${panel === 'search' ? 'active' : ''}`}
					title="Search"
					onClick={() => {
						setPanel('search')
						setSidebarOpen(true)
					}}
				>
					🔍
				</button>
				<button
					className={`act ${panel === 'git' ? 'active' : ''}`}
					title="Source Control"
					onClick={() => {
						setPanel('git')
						setSidebarOpen(true)
					}}
				>
					⎇
				</button>
				<button
					className={`act ${panel === 'tasks' ? 'active' : ''}`}
					title="Tasks (bun/npm)"
					onClick={() => {
						setPanel('tasks')
						setSidebarOpen(true)
					}}
				>
					▶
				</button>
				<button
					className={`act ${panel === 'debug' ? 'active' : ''}`}
					title="Run and Debug"
					onClick={() => {
						setPanel('debug')
						setSidebarOpen(true)
					}}
				>
					🐞
				</button>
				<button
					className={`act ${panel === 'browser' ? 'active' : ''}`}
					title="Browser (opencode etc.)"
					onClick={() => setPanel('browser')}
				>
					🌐
				</button>
				<button
					className={`act ${terminalOpen ? 'active' : ''}`}
					title="Terminal (Ctrl+`)"
					onClick={() => setTerminalOpen(!terminalOpen)}
				>
					⌨
				</button>
				<button
					className="act"
					title="Command Palette (Ctrl+Shift+P)"
					onClick={() => useAppStore.getState().setPaletteOpen(true)}
				>
					⌘
				</button>
				{workspaces.length > 1 && (
					<select
						className="workspace-selector"
						value={activeWorkspace}
						onChange={e => setActiveWorkspace(parseInt(e.target.value, 10))}
						title="Switch workspace"
					>
						{workspaces.map((ws, i) => (
							<option
								key={i}
								value={i}
							>
								{ws.name}
							</option>
						))}
					</select>
				)}
				<div className="act-spacer" />
				<button
					className="act"
					title="Toggle sidebar"
					onClick={() => setSidebarOpen(!sidebarOpen)}
				>
					◧
				</button>
			</div>

			{sidebarOpen && panel !== 'browser' && (
				<aside className="sidebar">
					{panel === 'explorer' ? (
						<FileTree />
					) : panel === 'search' ? (
						<SearchPanel />
					) : panel === 'tasks' ? (
						<TasksPanel />
					) : panel === 'debug' ? (
						<DebugPanel />
					) : (
						<GitPanel />
					)}
				</aside>
			)}

			<main className="main">
				<div className="workarea">
					{panel === 'browser' ? <BrowserFrame /> : <EditorTabs />}
				</div>
				{termMounted && (
					<Reloadable
						factory={() => import('./components/TerminalPanel')}
						loading={
							<div className="term-drawer">
								<div className="muted">loading terminal…</div>
							</div>
						}
						failed={retry => (
							<div className="term-drawer">
								<div className="error">
									Terminal failed to load (network?).{' '}
									<button
										className="chip"
										onClick={retry}
									>
										Retry
									</button>
								</div>
							</div>
						)}
						props={{visible: terminalOpen}}
					/>
				)}
			</main>

			<StatusBar />
			<CommandPalette />
		</div>
	)
}
