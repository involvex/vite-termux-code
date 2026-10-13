import {Suspense, lazy, useEffect, useState} from 'react'
import './App.css'
import BrowserFrame from './components/BrowserFrame'
import EditorTabs from './components/EditorTabs'
import FileTree from './components/FileTree'
import SearchPanel from './components/SearchPanel'
import StatusBar from './components/StatusBar'
import {api, wsUrl} from './lib/api'
import {useAppStore} from './store/useAppStore'

// xterm is heavy: split it out and don't even mount the drawer until the
// user first opens the terminal. Sessions survive because we keep it mounted
// afterwards (visibility is CSS-driven inside).
const TerminalPanel = lazy(() => import('./components/TerminalPanel'))

export default function App() {
	const {
		panel,
		setPanel,
		setRoot,
		setConnected,
		setStatus,
		sidebarOpen,
		setSidebarOpen,
		terminalOpen,
		setTerminalOpen,
		tabs,
		updateTab,
	} = useAppStore()
	const [termMounted, setTermMounted] = useState(terminalOpen)

	useEffect(() => {
		if (terminalOpen) setTermMounted(true)
	}, [terminalOpen])

	useEffect(() => {
		api
			.health()
			.then(h => {
				setRoot(h.root)
				setStatus(`td-code v${h.version}`)
			})
			.catch(e => setStatus(e instanceof Error ? e.message : 'offline'))
	}, [setRoot, setStatus])

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
					}
					if (msg.type === 'change' && msg.path) {
						const open = tabs.find(t => t.path === msg.path)
						// auto-reload only if user has no unsaved edits
						if (open && open.content === open.savedContent) {
							api
								.read(msg.path as string)
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

	// global Ctrl+S + Ctrl+` (terminal)
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
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [setTerminalOpen])

	return (
		<div className="ide">
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
					{panel === 'explorer' ? <FileTree /> : <SearchPanel />}
				</aside>
			)}

			<main className="main">
				<div className="workarea">
					{panel === 'browser' ? <BrowserFrame /> : <EditorTabs />}
				</div>
				{termMounted && (
					<Suspense fallback={null}>
						<TerminalPanel visible={terminalOpen} />
					</Suspense>
				)}
			</main>

			<StatusBar />
		</div>
	)
}
