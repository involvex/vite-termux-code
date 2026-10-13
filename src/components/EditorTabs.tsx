import {api} from '../lib/api'
import {useAppStore} from '../store/useAppStore'
import Reloadable from './Reloadable'

export default function EditorTabs() {
	const {
		tabs,
		activePath,
		setActive,
		closeTab,
		updateTab,
		setSaving,
		setStatus,
	} = useAppStore()

	const save = async (path: string) => {
		const tab = tabs.find(t => t.path === path)
		if (!tab || tab.binary || tab.truncated) return
		if (tab.content === tab.savedContent) return
		setSaving(true)
		try {
			const res = await api.save(path, tab.content)
			updateTab(path, {savedContent: tab.content, mtime: res.mtime})
			setStatus(`saved ${path}`)
		} catch (e) {
			setStatus(e instanceof Error ? e.message : 'save failed')
		} finally {
			setSaving(false)
		}
	}

	if (tabs.length === 0) {
		return (
			<div className="editor-empty">
				<h2>td-code</h2>
				<p>
					Pick a file from the Explorer, or open the Browser tab for opencode.
				</p>
				<p className="muted">Ctrl/Cmd+S saves the active file.</p>
			</div>
		)
	}

	const active = tabs.find(t => t.path === activePath) ?? tabs[0]

	return (
		<div className="editor-col">
			<div
				className="tabbar"
				onKeyDown={e => {
					if ((e.ctrlKey || e.metaKey) && e.key === 's') {
						e.preventDefault()
						if (active) void save(active.path)
					}
				}}
			>
				{tabs.map(t => {
					const dirty = t.content !== t.savedContent
					return (
						<div
							key={t.path}
							className={`tab ${t.path === active?.path ? 'active' : ''}`}
							onClick={() => setActive(t.path)}
						>
							<span
								className="tab-name"
								title={t.path}
							>
								{t.path.split('/').pop()}
								{dirty ? ' ●' : ''}
							</span>
							<button
								className="tab-close"
								title="Close"
								onClick={e => {
									e.stopPropagation()
									if (
										dirty &&
										!window.confirm(`Close ${t.path} with unsaved changes?`)
									)
										return
									closeTab(t.path)
								}}
							>
								×
							</button>
						</div>
					)
				})}
				{active && (
					<button
						className="save-btn"
						disabled={active.content === active.savedContent}
						onClick={() => void save(active.path)}
						title="Save (Ctrl+S)"
					>
						Save
					</button>
				)}
			</div>
			<div
				className="editor-host"
				tabIndex={-1}
			>
				{active && (
					<Reloadable
						factory={() => import('./CodeEditor')}
						loading={<div className="muted">loading editor…</div>}
						failed={retry => (
							<div className="editor-empty">
								<p>Editor failed to load (network?).</p>
								<button
									className="save-btn"
									onClick={retry}
								>
									Retry
								</button>
							</div>
						)}
						childKey={active.path}
						props={{filePath: active.path}}
					/>
				)}
			</div>
		</div>
	)
}
