import {useCallback, useEffect, useRef, useState} from 'react'
import {api} from '../lib/api'
import {openAt} from '../lib/nav'
import {
	dapClient,
	type DapFrame,
	type DapScope,
	type DapThread,
	type DapVariable,
} from '../lib/dap'
import {useAppStore} from '../store/useAppStore'

interface VarNode {
	variable: DapVariable
	children: DapVariable[] | null
	open: boolean
}

function frameLabel(f: DapFrame): string {
	const src = f.source?.path?.split('/').pop() ?? f.source?.name ?? '?'
	return `${f.name} — ${src}:${f.line}`
}

export default function DebugPanel() {
	const {
		debug,
		setDebug,
		resetDebug,
		breakpoints,
		setStatus,
		setPanel,
		tabs,
		activePath,
	} = useAppStore()
	const [program, setProgram] = useState('')
	const [starting, setStarting] = useState(false)
	const [threads, setThreads] = useState<DapThread[]>([])
	const [frames, setFrames] = useState<DapFrame[]>([])
	const [activeFrame, setActiveFrame] = useState<number | null>(null)
	const [scopes, setScopes] = useState<DapScope[]>([])
	const [vars, setVars] = useState<VarNode[]>([])
	const [output, setOutput] = useState<string[]>([])
	const [error, setError] = useState('')
	const outRef = useRef<HTMLDivElement>(null)

	// default program = active .py/.js tab
	const DEBUG_EXTS = ['.py', '.js', '.mjs', '.cjs']
	useEffect(() => {
		if (!program) {
			const active = tabs.find(t => t.path === activePath)
			if (active && DEBUG_EXTS.some(e => active.path.endsWith(e)))
				setProgram(active.path)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activePath])

	// initial sync + connect WS
	useEffect(() => {
		dapClient.ensureConnected()
		api
			.dapStatus()
			.then(s => {
				if (s.active)
					setDebug({active: true, program: s.program, stopped: s.stopped})
			})
			.catch(() => {})
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	const refreshStack = useCallback(async (threadId: number) => {
		try {
			const th = await dapClient.request<{threads: DapThread[]}>('threads', {})
			setThreads(th.threads ?? [])
			const st = await dapClient.request<{stackFrames: DapFrame[]}>(
				'stackTrace',
				{threadId, startFrame: 0, levels: 20},
			)
			const list = st.stackFrames ?? []
			setFrames(list)
			const top = list[0]
			setActiveFrame(top?.id ?? null)
			if (top) {
				const sc = await dapClient.request<{scopes: DapScope[]}>('scopes', {
					frameId: top.id,
				})
				setScopes(sc.scopes ?? [])
				const first = (sc.scopes ?? [])[0]
				if (first) {
					const vs = await dapClient.request<{variables: DapVariable[]}>(
						'variables',
						{variablesReference: first.variablesReference},
					)
					setVars(
						(vs.variables ?? []).map(v => ({
							variable: v,
							children: null,
							open: false,
						})),
					)
				} else {
					setVars([])
				}
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : 'stack fetch failed')
		}
	}, [])

	const clearRun = useCallback(() => {
		setThreads([])
		setFrames([])
		setActiveFrame(null)
		setScopes([])
		setVars([])
	}, [])

	// DAP events
	useEffect(() => {
		const off = dapClient.onEvent((event, body) => {
			if (event === 'stopped') {
				const b = body as {
					threadId?: number
					reason?: string
					file?: string | null
					line?: number | null
				}
				setDebug({
					stopped: {
						threadId: b.threadId ?? 0,
						reason: String(b.reason ?? 'unknown'),
						file: (b.file as string | null) ?? null,
						line: typeof b.line === 'number' ? b.line : null,
					},
				})
				if (typeof b.threadId === 'number') void refreshStack(b.threadId)
				if (b.file && typeof b.line === 'number') void openAt(b.file, b.line)
			} else if (event === 'continued') {
				setDebug({stopped: null})
				clearRun()
			} else if (event === 'terminated' || event === 'exited') {
				resetDebug()
				clearRun()
				setStatus(
					event === 'terminated' ? 'debug session ended' : 'program exited',
				)
			} else if (event === 'started') {
				setStatus(`debugging ${(body as {program?: string}).program ?? ''}`)
			} else if (event === 'output') {
				const text = String((body as {output?: unknown}).output ?? '')
				if (text) {
					setOutput(prev => {
						const next = [...prev, ...text.split('\n')]
						return next.length > 300 ? next.slice(next.length - 300) : next
					})
					requestAnimationFrame(() => {
						outRef.current?.scrollTo(0, outRef.current.scrollHeight)
					})
				}
			}
		})
		return off
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	const start = async () => {
		const prog = program.trim()
		if (!prog) {
			setError('enter a program path (relative .py/.js)')
			return
		}
		setStarting(true)
		setError('')
		try {
			// push all known breakpoints before launch; backend also reapplies
			for (const [p, lines] of Object.entries(breakpoints)) {
				dapClient.sendBreakpoints(p, lines)
			}
			const s = await api.dapStart(prog.replace(/^\//, ''))
			setDebug({active: true, program: s.program, stopped: null})
			setOutput([])
			clearRun()
			setPanel('debug')
		} catch (e) {
			setError(e instanceof Error ? e.message : 'start failed')
		} finally {
			setStarting(false)
		}
	}

	const stop = async () => {
		try {
			await api.dapStop()
		} catch {
			/* already dead */
		}
		resetDebug()
		clearRun()
	}

	const step = async (
		command: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause',
	) => {
		const threadId = debug.stopped?.threadId
		try {
			if (command === 'pause') {
				// pause all threads when nothing stopped
				const th = await dapClient.request<{threads: DapThread[]}>(
					'threads',
					{},
				)
				for (const t of th.threads ?? []) {
					await dapClient.request('pause', {threadId: t.id}).catch(() => {})
				}
				return
			}
			if (threadId === undefined || threadId === null) {
				setError('nothing stopped')
				return
			}
			await dapClient.request(command, {threadId})
			if (command === 'continue') {
				setDebug({stopped: null})
				clearRun()
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : `${command} failed`)
		}
	}

	const openFrame = async (f: DapFrame) => {
		setActiveFrame(f.id)
		try {
			const sc = await dapClient.request<{scopes: DapScope[]}>('scopes', {
				frameId: f.id,
			})
			setScopes(sc.scopes ?? [])
			setVars([])
		} catch (e) {
			setError(e instanceof Error ? e.message : 'scopes failed')
		}
		const p = f.source?.path
		if (!p) return
		// Backend already relativizes stopped-frame paths; other frames may
		// carry absolute paths — strip the served root when present.
		const root = useAppStore
			.getState()
			.root.replace(/\\/g, '/')
			.replace(/\/+$/, '')
		const norm = p.replace(/\\/g, '/')
		let rel: string | null = norm
		if (root && norm.startsWith(root + '/')) rel = norm.slice(root.length + 1)
		else if (/^[A-Za-z]:\//.test(norm) || norm.startsWith('/')) rel = null
		if (rel) void openAt(rel, f.line)
		else setStatus(`${p}:${f.line} (outside workspace)`)
	}

	const toggleVar = async (idx: number) => {
		const node = vars[idx]
		if (!node) return
		if (node.open) {
			setVars(prev => prev.map((v, i) => (i === idx ? {...v, open: false} : v)))
			return
		}
		if (node.variable.variablesReference <= 0) return
		try {
			const r = await dapClient.request<{variables: DapVariable[]}>(
				'variables',
				{
					variablesReference: node.variable.variablesReference,
				},
			)
			setVars(prev =>
				prev.map((v, i) =>
					i === idx ? {...v, open: true, children: r.variables ?? []} : v,
				),
			)
		} catch (e) {
			setError(e instanceof Error ? e.message : 'variables failed')
		}
	}

	const stopped = debug.stopped

	return (
		<div className="panel-col">
			<div className="panel-toolbar">
				<span className="panel-title">Debug</span>
				{debug.active ? (
					<button
						className="icon-btn"
						title="Stop"
						onClick={() => void stop()}
					>
						⏹
					</button>
				) : null}
			</div>
			{error && <div className="error">{error}</div>}
			{!debug.active ? (
				<div className="git-commit">
					<input
						className="git-input"
						value={program}
						onChange={e => setProgram(e.target.value)}
						placeholder="program (relative .py/.js path)"
						spellCheck={false}
					/>
					<button
						className="save-btn git-commit-btn"
						disabled={starting || !program.trim()}
						onClick={() => void start()}
					>
						{starting ? 'Starting…' : '▶ Start debugging'}
					</button>
					<div className="muted small">
						.py needs <code>debugpy</code> (<code>pip install debugpy</code>
						). .js needs node + js-debug via <code>TD_CODE_JS_DEBUG</code>.
						Click the editor gutter to set breakpoints first.
					</div>
				</div>
			) : (
				<div className="git-wrap">
					<div className="git-branch-row">
						<span
							className="git-branch"
							title={`${debug.adapter ?? ''} ${debug.program ?? ''}`}
						>
							🐞 [{debug.adapter ?? '?'}] {debug.program?.split('/').pop()}
						</span>
						{stopped ? (
							<span className="git-count">
								⏸ {stopped.reason}
								{stopped.file
									? ` · ${stopped.file.split('/').pop()}:${stopped.line}`
									: ''}
							</span>
						) : (
							<span className="muted small">running…</span>
						)}
					</div>
					<div className="dbg-controls">
						<button
							className="chip"
							title="Continue (F5)"
							disabled={!stopped}
							onClick={() => void step('continue')}
						>
							▶
						</button>
						<button
							className="chip"
							title="Step over (F10)"
							disabled={!stopped}
							onClick={() => void step('next')}
						>
							⤵
						</button>
						<button
							className="chip"
							title="Step into (F11)"
							disabled={!stopped}
							onClick={() => void step('stepIn')}
						>
							⤵·
						</button>
						<button
							className="chip"
							title="Step out"
							disabled={!stopped}
							onClick={() => void step('stepOut')}
						>
							⤴
						</button>
						<button
							className="chip"
							title="Pause"
							disabled={!!stopped}
							onClick={() => void step('pause')}
						>
							⏸
						</button>
						<button
							className="chip ghost"
							title="Stop"
							onClick={() => void stop()}
						>
							⏹
						</button>
					</div>

					<div className="git-log-title">Call stack</div>
					{threads.length > 1 && (
						<div className="dbg-controls">
							{threads.map(t => (
								<button
									key={t.id}
									className="chip"
									title={`Thread ${t.id}`}
									onClick={() => void refreshStack(t.id)}
								>
									{t.name || `T${t.id}`}
								</button>
							))}
						</div>
					)}
					<ul className="git-log">
						{frames.map(f => (
							<li key={f.id}>
								<button
									className={`git-path ${f.id === activeFrame ? 'dbg-active-frame' : ''}`}
									onClick={() => void openFrame(f)}
								>
									{frameLabel(f)}
								</button>
							</li>
						))}
						{frames.length === 0 && (
							<li className="muted">{stopped ? 'loading…' : '—'}</li>
						)}
					</ul>

					<div className="git-log-title">Variables</div>
					<ul className="git-log">
						{scopes.map(s => (
							<li
								key={s.name}
								className="muted small"
							>
								{s.name}
							</li>
						))}
						{vars.map((n, i) => (
							<li key={`${n.variable.name}:${i}`}>
								<button
									className="git-path"
									onClick={() => void toggleVar(i)}
								>
									{n.variable.variablesReference > 0
										? n.open
											? '▾ '
											: '▸ '
										: '· '}
									{n.variable.name}
									{n.variable.type ? `: ${n.variable.type}` : ''} ={' '}
									{n.variable.value.length > 80
										? n.variable.value.slice(0, 80) + '…'
										: n.variable.value}
								</button>
								{n.open && n.children && (
									<ul className="git-log dbg-nested">
										{n.children.map((c, j) => (
											<li
												key={`${c.name}:${j}`}
												className="muted"
											>
												{c.name} ={' '}
												{c.value.length > 80
													? c.value.slice(0, 80) + '…'
													: c.value}
											</li>
										))}
									</ul>
								)}
							</li>
						))}
						{vars.length === 0 && <li className="muted">—</li>}
					</ul>

					<div className="git-log-title">Console</div>
					<div
						ref={outRef}
						className="git-diff dbg-console"
					>
						{output.join('\n') || '(no output)'}
					</div>
					<div className="muted small">
						{Object.values(breakpoints).reduce((a, b) => a + b.length, 0)}{' '}
						breakpoint(s) set
					</div>
				</div>
			)}
		</div>
	)
}
