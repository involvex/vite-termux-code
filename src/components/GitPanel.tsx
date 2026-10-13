import {useCallback, useEffect, useState} from 'react'
import {api, type GitBranch, type GitCommit, type GitStatus} from '../lib/api'
import {useAppStore} from '../store/useAppStore'

export default function GitPanel() {
	const {activeWorkspace, setStatus, setGit} = useAppStore()
	const [status, setStatusState] = useState<GitStatus | null>(null)
	const [commits, setCommits] = useState<GitCommit[]>([])
	const [branches, setBranches] = useState<GitBranch[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState('')
	const [message, setMessage] = useState('')
	const [name, setName] = useState('')
	const [email, setEmail] = useState('')
	const [committing, setCommitting] = useState(false)
	const [expanded, setExpanded] = useState<Record<string, string>>({})
	const [loadingDiff, setLoadingDiff] = useState<string | null>(null)

	const refresh = useCallback(async () => {
		setLoading(true)
		setError('')
		try {
			const s = await api.gitStatus(activeWorkspace)
			setStatusState(s)
			if (s.repo) {
				const dirty =
					(s.staged?.length ?? 0) +
					(s.unstaged?.length ?? 0) +
					(s.untracked?.length ?? 0)
				setGit(s.branch ?? null, dirty)
				const [log, br] = await Promise.all([
					api.gitLog(15, activeWorkspace),
					api.gitBranches(activeWorkspace),
				])
				setCommits(log.commits)
				setBranches(br.branches)
			} else {
				setGit(null, 0)
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : 'git failed'
			setError(msg)
			setStatus(`git: ${msg}`)
		} finally {
			setLoading(false)
		}
	}, [activeWorkspace, setGit, setStatus])

	useEffect(() => {
		void refresh()
	}, [refresh])

	const mutate = async (fn: () => Promise<unknown>, label: string) => {
		try {
			await fn()
			setError('')
			await refresh()
		} catch (e) {
			const msg = e instanceof Error ? e.message : `${label} failed`
			setError(msg)
			setStatus(`git: ${msg}`)
		}
	}

	const toggleDiff = async (file: string, staged: boolean) => {
		const key = `${staged ? 's' : 'u'}:${file}`
		if (expanded[key]) {
			setExpanded(prev => {
				const next = {...prev}
				delete next[key]
				return next
			})
			return
		}
		setLoadingDiff(key)
		try {
			const d = await api.gitDiff(file, staged, activeWorkspace)
			setExpanded(prev => ({
				...prev,
				[key]:
					d.diff || '(no textual diff)' + (d.truncated ? '\n…truncated' : ''),
			}))
		} catch (e) {
			setError(e instanceof Error ? e.message : 'diff failed')
		} finally {
			setLoadingDiff(null)
		}
	}

	const commit = async () => {
		if (!message.trim()) {
			setError('commit message is empty')
			return
		}
		setCommitting(true)
		try {
			const r = await api.gitCommit(
				message.trim(),
				name.trim() || undefined,
				email.trim() || undefined,
				activeWorkspace,
			)
			setMessage('')
			setError('')
			setStatus(`committed ${r.hash.slice(0, 7)}`)
			await refresh()
		} catch (e) {
			const msg = e instanceof Error ? e.message : 'commit failed'
			setError(msg)
		} finally {
			setCommitting(false)
		}
	}

	const checkout = async (ref: string) => {
		if (!ref) return
		await mutate(() => api.gitCheckout(ref, activeWorkspace), 'checkout')
	}

	if (loading && !status)
		return <div className="muted">loading git status…</div>

	return (
		<div className="panel-col">
			<div className="panel-toolbar">
				<span className="panel-title">Source Control</span>
				<button
					className="icon-btn"
					title="Refresh"
					onClick={() => void refresh()}
				>
					↻
				</button>
			</div>
			{error && <div className="error">{error}</div>}
			{status && !status.repo && (
				<div className="muted">
					Not a git repository.
					<br />
					Run <code>git init</code> in the terminal to start one.
				</div>
			)}
			{status?.repo && (
				<div className="git-wrap">
					<div className="git-branch-row">
						<span
							className="git-branch"
							title="current branch"
						>
							⎇{' '}
							{status.detached
								? `(detached ${status.branch ?? ''})`
								: (status.branch ?? '?')}
						</span>
						{(status.ahead ?? 0) > 0 && (
							<span className="git-count">↑{status.ahead}</span>
						)}
						{(status.behind ?? 0) > 0 && (
							<span className="git-count">↓{status.behind}</span>
						)}
						<select
							className="git-select"
							title="Switch branch"
							defaultValue=""
							onChange={e => {
								void checkout(e.target.value)
								e.target.value = ''
							}}
						>
							<option value="">checkout…</option>
							{branches
								.filter(b => !b.current)
								.map(b => (
									<option
										key={b.name}
										value={b.name}
									>
										{b.name}
									</option>
								))}
						</select>
					</div>

					<GitSection
						title={`Staged (${status.staged?.length ?? 0})`}
						actionLabel="unstage all"
						onAction={() =>
							void mutate(
								() =>
									api.gitUnstage(
										(status.staged ?? []).map(f => f.path),
										activeWorkspace,
									),
								'unstage',
							)
						}
					>
						{(status.staged ?? []).map(f => (
							<GitFileRow
								key={f.path}
								kind={f.kind}
								path={f.path}
								button="+"
								buttonTitle="Unstage"
								onButton={() =>
									void mutate(
										() => api.gitUnstage([f.path], activeWorkspace),
										'unstage',
									)
								}
								onDiff={() => void toggleDiff(f.path, true)}
								diff={expanded[`s:${f.path}`]}
								diffLoading={loadingDiff === `s:${f.path}`}
							/>
						))}
					</GitSection>

					<GitSection
						title={`Changes (${status.unstaged?.length ?? 0})`}
						actionLabel="stage all"
						onAction={() =>
							void mutate(
								() =>
									api.gitStage(
										[
											...(status.unstaged ?? []).map(f => f.path),
											...(status.untracked ?? []),
										],
										activeWorkspace,
									),
								'stage',
							)
						}
					>
						{(status.unstaged ?? []).map(f => (
							<GitFileRow
								key={f.path}
								kind={f.kind}
								path={f.path}
								button="+"
								buttonTitle="Stage"
								onButton={() =>
									void mutate(
										() => api.gitStage([f.path], activeWorkspace),
										'stage',
									)
								}
								onDiff={() => void toggleDiff(f.path, false)}
								diff={expanded[`u:${f.path}`]}
								diffLoading={loadingDiff === `u:${f.path}`}
							/>
						))}
						{(status.untracked ?? []).map(p => (
							<GitFileRow
								key={p}
								kind="?"
								path={p}
								button="+"
								buttonTitle="Stage"
								onButton={() =>
									void mutate(() => api.gitStage([p], activeWorkspace), 'stage')
								}
								onDiff={undefined}
								diff={undefined}
								diffLoading={false}
							/>
						))}
					</GitSection>

					<div className="git-commit">
						<textarea
							className="git-input"
							value={message}
							onChange={e => setMessage(e.target.value)}
							placeholder="Commit message"
							rows={2}
						/>
						<div className="git-identity">
							<input
								className="git-input"
								value={name}
								onChange={e => setName(e.target.value)}
								placeholder="Name (optional)"
							/>
							<input
								className="git-input"
								value={email}
								onChange={e => setEmail(e.target.value)}
								placeholder="Email (optional)"
							/>
						</div>
						<button
							className="save-btn git-commit-btn"
							disabled={committing || !message.trim()}
							onClick={() => void commit()}
						>
							{committing ? 'Committing…' : 'Commit staged'}
						</button>
					</div>

					<div className="git-log-title">Recent commits</div>
					<ul className="git-log">
						{commits.map(c => (
							<li key={c.hash}>
								<span
									className="git-hash"
									title={c.hash}
								>
									{c.short}
								</span>{' '}
								{c.subject}
								<span className="git-meta">
									{' '}
									— {c.author}, {c.date}
								</span>
							</li>
						))}
						{commits.length === 0 && <li className="muted">no commits yet</li>}
					</ul>
				</div>
			)}
		</div>
	)
}

function GitSection({
	title,
	actionLabel,
	onAction,
	children,
}: {
	title: string
	actionLabel: string
	onAction: () => void
	children: React.ReactNode
}) {
	return (
		<div className="git-section">
			<div className="git-section-head">
				<span>{title}</span>
				<button
					className="git-link"
					onClick={onAction}
				>
					{actionLabel}
				</button>
			</div>
			{children}
		</div>
	)
}

function GitFileRow({
	kind,
	path,
	button,
	buttonTitle,
	onButton,
	onDiff,
	diff,
	diffLoading,
}: {
	kind: string
	path: string
	button: string
	buttonTitle: string
	onButton: () => void
	onDiff?: () => void
	diff?: string
	diffLoading: boolean
}) {
	return (
		<div className="git-file">
			<div className="git-file-row">
				<span
					className={`git-kind k-${kind}`}
					title={kind}
				>
					{kind}
				</span>
				<button
					className="git-path"
					title={onDiff ? `Show diff: ${path}` : path}
					onClick={onDiff}
					disabled={!onDiff}
				>
					{path.split('/').pop()}
				</button>
				<button
					className="icon-btn git-act"
					title={buttonTitle}
					onClick={onButton}
				>
					{button}
				</button>
			</div>
			{diffLoading && <div className="muted small">loading diff…</div>}
			{diff !== undefined && <pre className="git-diff">{diff}</pre>}
		</div>
	)
}
