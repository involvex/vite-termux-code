import {useAppStore} from '../store/useAppStore'

export default function StatusBar() {
	const {
		root,
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
	} = useAppStore()
	const active = tabs.find(t => t.path === activePath)
	const dirty = active ? active.content !== active.savedContent : false
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
				{root || '…'}
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
			<span className="spacer" />
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
