import {spawn, type ChildProcess} from 'node:child_process'
import type {WebSocket} from 'ws'
import {findOnPath, resolveSafe} from './paths.ts'

export interface TermInfo {
	id: string
	cwd: string
	shell: string
	/** true when running under a real PTY via script(1); false = pipes */
	pty: boolean
	cols: number
	rows: number
	alive: boolean
	exitCode: number | null
	createdAt: number
}

interface Session extends TermInfo {
	proc: ChildProcess | null
	buf: string
	sockets: Set<WebSocket>
}

const MAX_SESSIONS = 8
const MAX_BUF_CHARS = 200_000
const CHUNK = 32_000

let idCounter = 0
function nextId(): string {
	idCounter += 1
	return `t${Date.now().toString(36)}${(idCounter % 1296).toString(36)}`
}

export class TermManager {
	private sessions = new Map<string, Session>()
	private scriptBin: string | null | undefined
	readonly rootDirs: string[]
	readonly maxSessions: number

	constructor(rootDirs: string | string[], maxSessions = MAX_SESSIONS) {
		this.rootDirs = Array.isArray(rootDirs) ? rootDirs : [rootDirs]
		this.maxSessions = maxSessions
	}

	/** @deprecated Use rootDirs instead */
	get rootDir(): string {
		return this.rootDirs[0]
	}

	/** Path to script(1) if a real PTY can be allocated, else null. Cached. */
	get ptyAvailable(): boolean {
		if (this.scriptBin === undefined) {
			if (process.platform === 'win32') this.scriptBin = null
			else this.scriptBin = findOnPath('script')
		}
		return this.scriptBin !== null
	}

	defaultShell(): string {
		if (process.platform === 'win32') return 'powershell.exe'
		const env = (process.env.SHELL ?? '').split('/').pop() ?? ''
		if (env && findOnPath(env)) return env
		if (findOnPath('bash')) return 'bash'
		return 'sh'
	}

	list(): TermInfo[] {
		return [...this.sessions.values()].map(publicInfo)
	}

	create(
		opts: {cwd?: string; shell?: string; cols?: number; rows?: number} = {},
	): TermInfo {
		// evict dead sessions first so a refresh-loop can't leak slots
		for (const [id, s] of this.sessions) {
			if (!s.alive && s.sockets.size === 0) this.sessions.delete(id)
		}
		if (this.sessions.size >= this.maxSessions) {
			throw Object.assign(
				new Error(`too many terminal sessions (max ${this.maxSessions})`),
				{
					status: 429,
				},
			)
		}
		const abs = resolveSafe(this.rootDirs, opts.cwd ?? '')
		if (!abs) throw Object.assign(new Error('cwd escapes root'), {status: 403})
		let shell = (opts.shell ?? '').trim() || this.defaultShell()
		if (shell.includes('/') || shell.includes('\\')) {
			throw Object.assign(new Error('shell must be a bare command name'), {
				status: 400,
			})
		}
		if (!findOnPath(shell)) {
			throw Object.assign(new Error(`shell not found on PATH: ${shell}`), {
				status: 400,
			})
		}
		const cols = clampInt(opts.cols ?? 80, 20, 500)
		const rows = clampInt(opts.rows ?? 24, 5, 200)

		const id = nextId()
		const session: Session = {
			id,
			cwd: (opts.cwd ?? '').replace(/\\/g, '/'),
			shell,
			pty: false,
			cols,
			rows,
			alive: true,
			exitCode: null,
			createdAt: Date.now(),
			proc: null,
			buf: '',
			sockets: new Set(),
		}

		const env = {
			...process.env,
			TERM: 'xterm-256color',
			COLORTERM: 'truecolor',
			COLUMNS: String(cols),
			LINES: String(rows),
		}
		try {
			if (this.ptyAvailable && process.platform === 'darwin') {
				session.proc = spawn(
					this.scriptBin as string,
					['-q', '/dev/null', shell],
					{
						cwd: abs,
						env,
					},
				)
				session.pty = true
			} else if (this.ptyAvailable) {
				session.proc = spawn(
					this.scriptBin as string,
					['-qec', shell, '/dev/null'],
					{
						cwd: abs,
						env,
					},
				)
				session.pty = true
			} else {
				session.proc = spawn(shell, [], {cwd: abs, env})
			}
		} catch (err) {
			throw Object.assign(
				new Error(
					`failed to spawn: ${err instanceof Error ? err.message : err}`,
				),
				{status: 500},
			)
		}
		const proc = session.proc as ChildProcess
		proc.stdout?.on('data', d => this.push(id, d.toString('utf-8')))
		proc.stderr?.on('data', d => this.push(id, d.toString('utf-8')))
		proc.on('error', err => {
			this.push(id, `\r\n[td-code] spawn error: ${err.message}\r\n`)
			this.markExit(id, -1)
		})
		proc.on('exit', (code, signal) => {
			if (session.alive) {
				if (code !== 0 && code !== null) {
					this.push(id, `\r\n[exit ${code}${signal ? ` (${signal})` : ''}]\r\n`)
				}
				this.markExit(id, code)
			}
		})
		this.sessions.set(id, session)
		return publicInfo(session)
	}

	input(id: string, data: string): boolean {
		const s = this.sessions.get(id)
		if (!s || !s.alive || !s.proc?.stdin) return false
		try {
			s.proc.stdin.write(data)
			return true
		} catch {
			return false
		}
	}

	resize(id: string, cols: number, rows: number): boolean {
		const s = this.sessions.get(id)
		if (!s) return false
		s.cols = clampInt(cols, 20, 500)
		s.rows = clampInt(rows, 5, 200)
		// NOTE: PTY size is fixed at spawn (script(1) offers no resize API and
		// pipes have no size at all). The client re-fits its own viewport.
		return true
	}

	kill(id: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
		const s = this.sessions.get(id)
		if (!s) return false
		if (s.alive && s.proc) {
			try {
				s.proc.kill(signal)
			} catch {
				/* already gone */
			}
			// escalate if it ignores SIGTERM
			setTimeout(() => {
				if (s.alive && s.proc) {
					try {
						s.proc.kill('SIGKILL')
					} catch {
						/* ignore */
					}
				}
			}, 3000).unref?.()
		}
		return true
	}

	/** Kill (if alive) and forget the session. Returns false when unknown. */
	remove(id: string): boolean {
		const s = this.sessions.get(id)
		if (!s) return false
		this.kill(id)
		for (const ws of s.sockets) {
			try {
				ws.close(1000, 'session removed')
			} catch {
				/* ignore */
			}
		}
		this.sessions.delete(id)
		return true
	}

	killAll() {
		for (const id of [...this.sessions.keys()]) this.remove(id)
	}

	/** Attach a /term websocket: replay scrollback, then stream live output. */
	attach(ws: WebSocket, id: string) {
		const s = this.sessions.get(id)
		if (!s) {
			ws.close(4404, 'unknown session')
			return
		}
		s.sockets.add(ws)
		ws.on('close', () => s.sockets.delete(ws))
		ws.on('error', () => {
			try {
				ws.close()
			} catch {
				/* ignore */
			}
		})
		ws.on('message', raw => {
			let msg: {type?: string; data?: string; cols?: number; rows?: number}
			try {
				msg = JSON.parse(raw.toString()) as typeof msg
			} catch {
				return
			}
			if (msg.type === 'input' && typeof msg.data === 'string') {
				this.input(id, msg.data)
			} else if (msg.type === 'resize') {
				this.resize(id, Number(msg.cols) || 80, Number(msg.rows) || 24)
			}
		})
		this.send(ws, {type: 'replay', data: s.buf})
		if (!s.alive) this.send(ws, {type: 'exit', code: s.exitCode})
	}

	private push(id: string, text: string) {
		const s = this.sessions.get(id)
		if (!s) return
		s.buf += text
		if (s.buf.length > MAX_BUF_CHARS) {
			s.buf = s.buf.slice(s.buf.length - MAX_BUF_CHARS)
		}
		for (let i = 0; i < text.length; i += CHUNK) {
			this.sendAll(s, {type: 'data', data: text.slice(i, i + CHUNK)})
		}
	}

	private markExit(id: string, code: number | null) {
		const s = this.sessions.get(id)
		if (!s || !s.alive) return
		s.alive = false
		s.exitCode = code
		this.sendAll(s, {type: 'exit', code})
	}

	private sendAll(s: Session, msg: unknown) {
		const body = JSON.stringify(msg)
		for (const ws of s.sockets) {
			try {
				if (ws.readyState === 1) ws.send(body)
			} catch {
				/* ignore */
			}
		}
	}

	private send(ws: WebSocket, msg: unknown) {
		try {
			if (ws.readyState === 1) ws.send(JSON.stringify(msg))
		} catch {
			/* ignore */
		}
	}
}

function publicInfo(s: Session): TermInfo {
	return {
		id: s.id,
		cwd: s.cwd,
		shell: s.shell,
		pty: s.pty,
		cols: s.cols,
		rows: s.rows,
		alive: s.alive,
		exitCode: s.exitCode,
		createdAt: s.createdAt,
	}
}

function clampInt(v: number, min: number, max: number): number {
	if (!Number.isFinite(v)) return min
	return Math.max(min, Math.min(max, Math.floor(v)))
}
