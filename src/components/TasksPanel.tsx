import {useCallback, useEffect, useState} from 'react'
import {api, type TaskDef} from '../lib/api'
import {useAppStore} from '../store/useAppStore'

export default function TasksPanel() {
	const {activeWorkspace, setStatus, setTerminalOpen} = useAppStore()
	const [tasks, setTasks] = useState<TaskDef[]>([])
	const [runners, setRunners] = useState<{
		bun: string | null
		npm: string | null
		make: string | null
	}>({
		bun: null,
		npm: null,
		make: null,
	})
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState('')
	const [running, setRunning] = useState<string | null>(null)

	const refresh = useCallback(async () => {
		setLoading(true)
		setError('')
		try {
			const r = await api.tasks(activeWorkspace)
			setTasks(r.tasks)
			setRunners(r.runners)
		} catch (e) {
			setError(e instanceof Error ? e.message : 'failed to list tasks')
		} finally {
			setLoading(false)
		}
	}, [activeWorkspace])

	useEffect(() => {
		void refresh()
	}, [refresh])

	const run = async (t: TaskDef) => {
		if (t.id.startsWith('missing:')) return
		setRunning(t.id)
		try {
			const r = await api.runTask(t.id, activeWorkspace)
			setStatus(`running ${r.task.command} in terminal`)
			setTerminalOpen(true)
		} catch (e) {
			setError(e instanceof Error ? e.message : 'run failed')
			setStatus(e instanceof Error ? e.message : 'run failed')
		} finally {
			setRunning(null)
		}
	}

	return (
		<div className="panel-col">
			<div className="panel-toolbar">
				<span className="panel-title">Tasks</span>
				<button
					className="icon-btn"
					title="Refresh"
					onClick={() => void refresh()}
				>
					↻
				</button>
			</div>
			<div className="muted small">
				{runners.bun ? 'bun ✓' : 'bun —'} · {runners.npm ? 'npm ✓' : 'npm —'} ·{' '}
				{runners.make ? 'make ✓' : 'make —'}
				{!runners.bun &&
					!runners.npm &&
					!runners.make &&
					' (no runners on PATH)'}
			</div>
			{loading && <div className="muted">loading tasks…</div>}
			{error && <div className="error">{error}</div>}
			{!loading && tasks.length === 0 && (
				<div className="muted">
					No tasks found.
					<br />
					Add <code>scripts</code> to <code>package.json</code> or targets to a{' '}
					<code>Makefile</code>.
				</div>
			)}
			<ul className="search-results">
				{tasks.map(t => (
					<li key={t.id}>
						<button
							className="search-hit"
							title={t.detail ?? t.command}
							disabled={running === t.id || t.id.startsWith('missing:')}
							onClick={() => void run(t)}
						>
							<span className="search-file">
								<span
									className={`git-kind ${t.kind === 'make' ? '' : `k-${t.kind === 'bun' ? 'A' : 'M'}`}`}
									title={t.kind}
								>
									{t.kind === 'bun' ? 'b' : t.kind === 'npm' ? 'n' : 'm'}
								</span>{' '}
								{t.script}
								{running === t.id ? ' …' : ''}
							</span>
							<span className="search-preview">
								{t.label}
								{t.detail ? ` — ${t.detail}` : ''}
							</span>
						</button>
					</li>
				))}
			</ul>
		</div>
	)
}
