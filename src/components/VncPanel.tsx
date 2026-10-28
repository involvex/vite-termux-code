import {useAppStore} from '../store/useAppStore'

/**
 * Sidebar controls for the bottom VNC drawer: URL, password, open/close.
 */
export default function VncPanel() {
	const {
		vncOpen,
		vncUrl,
		vncPassword,
		setVncOpen,
		setVncUrl,
		setVncPassword,
		setStatus,
	} = useAppStore()

	return (
		<div className="panel-col">
			<div className="panel-toolbar">
				<span className="panel-title">VNC</span>
				<button
					className="icon-btn"
					title={vncOpen ? 'Hide VNC drawer' : 'Show VNC drawer'}
					onClick={() => {
						const next = !vncOpen
						setVncOpen(next)
						setStatus(next ? 'VNC drawer open' : 'VNC drawer closed')
					}}
				>
					{vncOpen ? 'Hide' : 'Show'}
				</button>
			</div>

			<label className="vnc-field">
				<span className="muted small">WebSocket URL</span>
				<input
					className="vnc-input"
					value={vncUrl}
					onChange={e => setVncUrl(e.target.value)}
					placeholder="ws://127.0.0.1:5901"
					spellCheck={false}
					autoCapitalize="off"
					autoCorrect="off"
				/>
			</label>

			<label className="vnc-field">
				<span className="muted small">Password (optional)</span>
				<input
					className="vnc-input"
					type="password"
					value={vncPassword}
					onChange={e => setVncPassword(e.target.value)}
					placeholder="VNC password"
					autoComplete="off"
				/>
			</label>

			<div className="vnc-actions">
				<button
					disabled={!vncUrl.trim()}
					onClick={() => {
						setVncOpen(true)
						setStatus(`VNC → ${vncUrl.trim()}`)
					}}
				>
					Connect / Show
				</button>
				<button
					disabled={!vncOpen}
					onClick={() => {
						setVncOpen(false)
						setStatus('VNC drawer closed')
					}}
				>
					Disconnect
				</button>
			</div>

			<p className="muted small vnc-hint">
				Needs a websockify (or compatible) endpoint in front of the VNC server.
				On Termux that is often <code>ws://127.0.0.1:5901</code>.
			</p>
		</div>
	)
}
