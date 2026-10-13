import {FitAddon} from '@xterm/addon-fit'
import {WebLinksAddon} from '@xterm/addon-web-links'
import {Terminal} from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import {useCallback, useEffect, useRef, useState} from 'react'
import {api, termWsUrl, type TermSession} from '../lib/api'
import {themeById} from '../lib/themes'
import {useAppStore} from '../store/useAppStore'

interface Live {
	term: Terminal
	fit: FitAddon
	ws: WebSocket | null
	initialized: boolean
	closed: boolean
	reconnectTimer: number | null
}

const MOBILE_KEYS: {label: string; data: string; title: string}[] = [
	{label: 'Tab', data: '\t', title: 'Tab'},
	{label: 'Ctrl+C', data: '\x03', title: 'Interrupt (Ctrl+C)'},
	{label: 'Esc', data: '\x1b', title: 'Escape'},
	{label: '↑', data: '\x1b[A', title: 'Arrow up'},
	{label: '↓', data: '\x1b[B', title: 'Arrow down'},
	{label: '|', data: '|', title: 'Pipe'},
	{label: '~', data: '~', title: 'Tilde'},
	{label: '/', data: '/', title: 'Slash'},
	{label: '-', data: '-', title: 'Dash'},
]

export default function TerminalPanel({visible}: {visible: boolean}) {
	const {setStatus, settings, setSettings} = useAppStore()
	const [sessions, setSessions] = useState<TermSession[]>([])
	const [activeId, setActiveId] = useState<string | null>(null)
	const [creating, setCreating] = useState(false)
	const [loaded, setLoaded] = useState(false)
	const [disabled, setDisabled] = useState(false)
	const [error, setError] = useState('')
	const fontSize = settings.termFontSize
	const xt = themeById(settings.theme).xterm
	const divRefs = useRef(new Map<string, HTMLDivElement>())
	const liveRefs = useRef(new Map<string, Live>())
	const backoffRef = useRef(new Map<string, number>())

	const sendInput = useCallback((id: string, data: string) => {
		const live = liveRefs.current.get(id)
		if (live?.ws && live.ws.readyState === 1) {
			live.ws.send(JSON.stringify({type: 'input', data}))
		}
	}, [])

	const sendResize = useCallback((id: string) => {
		const live = liveRefs.current.get(id)
		if (!live) return
		try {
			live.fit.fit()
			const cols = live.term.cols
			const rows = live.term.rows
			if (live.ws && live.ws.readyState === 1) {
				live.ws.send(JSON.stringify({type: 'resize', cols, rows}))
			}
		} catch {
			/* hidden or not laid out yet */
		}
	}, [])

	const markDead = useCallback((id: string, code: number | null) => {
		setSessions(prev =>
			prev.map(s => (s.id === id ? {...s, alive: false, exitCode: code} : s)),
		)
	}, [])

	const connect = useCallback(
		(id: string) => {
			const live = liveRefs.current.get(id)
			if (!live || live.closed) return
			let ws: WebSocket
			try {
				ws = new WebSocket(termWsUrl(id))
			} catch {
				return
			}
			live.ws = ws
			ws.onopen = () => {
				backoffRef.current.set(id, 1000)
				sendResize(id)
			}
			ws.onmessage = ev => {
				try {
					const msg = JSON.parse(ev.data as string) as {
						type: string
						data?: string
						code?: number | null
					}
					if (
						(msg.type === 'replay' || msg.type === 'data') &&
						typeof msg.data === 'string'
					) {
						if (msg.type === 'replay' && live.initialized) live.term.clear()
						live.term.write(msg.data)
						live.initialized = true
					} else if (msg.type === 'exit') {
						live.term.write(
							`\r\n\x1b[90m[process exited${msg.code !== null && msg.code !== undefined ? ` with code ${msg.code}` : ''}]\x1b[0m\r\n`,
						)
						markDead(id, msg.code ?? null)
					}
				} catch {
					/* ignore malformed */
				}
			}
			ws.onclose = ev => {
				if (live.closed) return
				live.ws = null
				// Don't reconnect when the server deliberately closed us:
				// 1000 = session removed, 44xx = app-level refusal
				// (unknown/disabled/unauthorized session).
				if (ev.code === 1000 || (ev.code >= 4400 && ev.code <= 4499)) {
					markDead(id, null)
					return
				}
				// Network drop: reconnect with backoff to pick up the
				// scrollback replay (server keeps the buffer).
				const backoff = Math.min(
					10000,
					(backoffRef.current.get(id) ?? 1000) * 2,
				)
				backoffRef.current.set(id, backoff)
				live.reconnectTimer = window.setTimeout(() => connect(id), backoff)
			}
			ws.onerror = () => {
				try {
					ws.close()
				} catch {
					/* ignore */
				}
			}
		},
		[markDead, sendResize],
	)

	const initLive = useCallback(
		(id: string) => {
			if (liveRefs.current.has(id)) return
			const el = divRefs.current.get(id)
			if (!el) return
			const term = new Terminal({
				cursorBlink: true,
				fontSize,
				scrollback: 3000,
				theme: {
					background: xt.background,
					foreground: xt.foreground,
					cursor: xt.cursor,
					selectionBackground: xt.selectionBackground,
				},
			})
			const fit = new FitAddon()
			term.loadAddon(fit)
			term.loadAddon(
				new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener')),
			)
			const live: Live = {
				term,
				fit,
				ws: null,
				initialized: false,
				closed: false,
				reconnectTimer: null,
			}
			liveRefs.current.set(id, live)
			term.open(el)
			term.onData(d => sendInput(id, d))
			connect(id)
			try {
				sendResize(id)
			} catch {
				/* will fit when shown */
			}
		},
		[connect, fontSize, sendInput, sendResize, xt],
	)

	// initial list
	useEffect(() => {
		let cancelled = false
		api
			.terms()
			.then(r => {
				if (cancelled) return
				setSessions(r.terms)
				setActiveId(prev => prev ?? r.terms[0]?.id ?? null)
				setError('')
				setLoaded(true)
			})
			.catch(e => {
				if (cancelled) return
				const msg = e instanceof Error ? e.message : 'failed'
				if (msg.includes('403')) setDisabled(true)
				else if (msg.includes('404'))
					setError(
						'server too old: restart td-code from a build with terminal support',
					)
				else setError(msg)
				setStatus(`terminal: ${msg}`)
				setLoaded(true)
			})
		return () => {
			cancelled = true
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// dispose everything on unmount
	useEffect(
		() => () => {
			for (const live of liveRefs.current.values()) {
				live.closed = true
				if (live.reconnectTimer !== null)
					window.clearTimeout(live.reconnectTimer)
				try {
					live.ws?.close()
				} catch {
					/* ignore */
				}
				try {
					live.term.dispose()
				} catch {
					/* ignore */
				}
			}
			liveRefs.current.clear()
		},
		[],
	)

	// attach xterm to newly rendered session divs
	useEffect(() => {
		for (const s of sessions) {
			if (!liveRefs.current.has(s.id) && divRefs.current.get(s.id)) {
				initLive(s.id)
			}
		}
	}, [sessions, initLive])

	// refit active terminal when shown / switched
	useEffect(() => {
		if (!visible || !activeId) return
		const t = window.setTimeout(() => sendResize(activeId), 30)
		return () => window.clearTimeout(t)
	}, [visible, activeId, sendResize])

	// refit on window resize
	useEffect(() => {
		const onResize = () => {
			if (activeId) sendResize(activeId)
		}
		window.addEventListener('resize', onResize)
		return () => window.removeEventListener('resize', onResize)
	}, [activeId, sendResize])

	// apply font size + theme to all live terminals
	useEffect(() => {
		for (const live of liveRefs.current.values()) {
			try {
				live.term.options.fontSize = fontSize
				live.term.options.theme = {
					background: xt.background,
					foreground: xt.foreground,
					cursor: xt.cursor,
					selectionBackground: xt.selectionBackground,
				}
				live.fit.fit()
			} catch {
				/* ignore */
			}
		}
	}, [fontSize, xt])

	const create = useCallback(async () => {
		setCreating(true)
		try {
			const info = await api.createTerm({cols: 80, rows: 24})
			setSessions(prev => [...prev, info])
			setActiveId(info.id)
			setError('')
		} catch (e) {
			const msg = e instanceof Error ? e.message : 'create failed'
			if (msg.includes('403')) setDisabled(true)
			else setError(msg)
			setStatus(`terminal: ${msg}`)
		} finally {
			setCreating(false)
		}
	}, [setStatus])

	// auto-open first shell when the drawer is shown and empty
	useEffect(() => {
		if (visible && loaded && !disabled && sessions.length === 0 && !creating) {
			void create()
		}
	}, [visible, loaded, disabled, sessions.length, creating, create])

	const kill = useCallback(
		async (id: string) => {
			const live = liveRefs.current.get(id)
			if (live) {
				live.closed = true
				if (live.reconnectTimer !== null)
					window.clearTimeout(live.reconnectTimer)
				try {
					live.ws?.close()
				} catch {
					/* ignore */
				}
				try {
					live.term.dispose()
				} catch {
					/* ignore */
				}
				liveRefs.current.delete(id)
			}
			divRefs.current.delete(id)
			try {
				await api.killTerm(id)
			} catch (e) {
				setStatus(e instanceof Error ? e.message : 'kill failed')
			}
			setSessions(prev => {
				const next = prev.filter(s => s.id !== id)
				setActiveId(cur => {
					if (cur !== id) return cur
					return next.length ? (next[next.length - 1]?.id ?? null) : null
				})
				return next
			})
		},
		[setStatus],
	)

	const switchTo = (id: string) => {
		setActiveId(id)
		if (!window.matchMedia('(pointer: coarse)').matches) {
			window.setTimeout(() => {
				try {
					liveRefs.current.get(id)?.term.focus()
				} catch {
					/* ignore */
				}
			}, 50)
		}
	}

	const active = sessions.find(s => s.id === activeId) ?? null

	return (
		<section
			className={visible ? 'term-drawer' : 'term-drawer off'}
			aria-label="Terminal"
		>
			<div className="term-head">
				<div className="term-tabs">
					{sessions.map(s => (
						<div
							key={s.id}
							className={`term-tab ${s.id === activeId ? 'active' : ''} ${s.alive ? '' : 'dead'}`}
							onClick={() => switchTo(s.id)}
							title={`${s.shell} · ${s.cwd || '/'} · ${s.pty ? 'pty' : 'pipes'}${s.alive ? '' : ` · exited (${s.exitCode})`}`}
						>
							<span className="term-tab-name">
								{s.shell}
								{s.alive ? '' : ' ✕'}
							</span>
							<button
								className="term-tab-x"
								title="Kill session"
								onClick={e => {
									e.stopPropagation()
									void kill(s.id)
								}}
							>
								×
							</button>
						</div>
					))}
					<button
						className="term-tab new"
						title="New terminal"
						disabled={creating || disabled}
						onClick={() => void create()}
					>
						+ new
					</button>
				</div>
				<div className="term-head-right">
					{active && (
						<span
							className="term-meta"
							title={active.cwd || '/'}
						>
							{active.pty ? 'pty' : 'pipes'} · {active.cwd || '/'}
						</span>
					)}
					<button
						className="icon-btn"
						title="Smaller font"
						onClick={() =>
							setSettings({termFontSize: Math.max(10, fontSize - 1)})
						}
					>
						A-
					</button>
					<button
						className="icon-btn"
						title="Bigger font"
						onClick={() =>
							setSettings({termFontSize: Math.min(22, fontSize + 1)})
						}
					>
						A+
					</button>
				</div>
			</div>
			{disabled ? (
				<div className="muted">
					Terminal is disabled by the server (--no-terms).
				</div>
			) : (
				<div className="term-views">
					{sessions.map(s => (
						<div
							key={s.id}
							ref={el => {
								if (el) divRefs.current.set(s.id, el)
								else divRefs.current.delete(s.id)
							}}
							className={`term-view ${s.id === activeId ? 'on' : ''}`}
						/>
					))}
					{sessions.length === 0 && loaded && (
						<div className="muted">
							{creating
								? 'starting shell…'
								: error
									? `error: ${error}`
									: 'no sessions'}
						</div>
					)}
					{error && sessions.length > 0 && (
						<div className="error">error: {error}</div>
					)}
				</div>
			)}
			{!disabled && (
				<div className="term-keys">
					{MOBILE_KEYS.map(k => (
						<button
							key={k.label}
							className="chip"
							title={k.title}
							onClick={() => activeId && sendInput(activeId, k.data)}
						>
							{k.label}
						</button>
					))}
					<button
						className="chip ghost"
						title="Clear screen"
						onClick={() => activeId && sendInput(activeId, '\x0c')}
					>
						clear
					</button>
				</div>
			)}
		</section>
	)
}
