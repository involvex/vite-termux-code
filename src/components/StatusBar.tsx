import {nextThemeId, themeById, THEMES} from '../lib/themes'
import {useAppStore} from '../store/useAppStore'

export default function StatusBar() {
	const {
		workspaces,
		activeWorkspace,
		connected,
		saving,
		status,
		tabs,
		activePath,
		terminalOpen,
		setTerminalOpen,
		gitBranch,
		gitDirty,
		setPanel,
		setSidebarOpen,
		settings,
		setSettings,
		debug,
	} = useAppStore()
	const active = tabs.find(t => t.path === activePath)
	const dirty = active ? active.content !== active.savedContent : false
	const currentWs = workspaces[activeWorkspace]
	const wsName = currentWs ? currentWs.name : 'no workspace'
	const wsPath = currentWs ? currentWs.rootDir : '…'
	return (
		<footer className="statusbar">
			<span
				className={`dot ${connected ? 'on' : 'off'}`}
				title={connected ? 'watcher connected' : 'watcher offline'}
			/>
			<span
				className="status-item"
				title="served directory"
			>
				{wsName}: {wsPath || '…'}
			</span>
			{gitBranch && (
				<button
					className="status-term"
					title="Source Control"
					onClick={() => {
						setPanel('git')
						setSidebarOpen(true)
					}}
				>
					⎇ {gitBranch}
					{gitDirty > 0 ? ` +${gitDirty}` : ''}
				</button>
			)}
			<span className="status-item">
				{active ? `${active.path}${dirty ? ' ●' : ''}` : 'no file'}
			</span>
			{debug.active && (
				<button
					className="status-term"
					title={`${debug.adapter ?? ''} ${debug.program ?? 'debugging'}`}
					onClick={() => {
						setPanel('debug')
						setSidebarOpen(true)
					}}
				>
					🐞 {debug.program?.split('/').pop()}
					{debug.stopped ? ` ⏸ ${debug.stopped.reason}` : ' ▶'}
				</button>
			)}
			<span className="spacer" />
			<button
				className="status-term"
				title={`Theme: ${themeById(settings.theme).label} (click to switch: ${THEMES.map(t => t.label).join(' → ')})`}
				onClick={() => setSettings({theme: nextThemeId(settings.theme)})}
			>
				◐ {themeById(settings.theme).label}
			</button>
			<button
				className="status-term"
				title="Toggle terminal (Ctrl+`)"
				onClick={() => setTerminalOpen(!terminalOpen)}
			>
				⌨ terminal
			</button>
			<span className="status-item">{saving ? 'saving…' : status}</span>
		</footer>
	)
}
