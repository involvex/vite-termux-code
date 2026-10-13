import {spawn, type ChildProcess} from 'node:child_process'
import path from 'node:path'
import type {WebSocket} from 'ws'
import {findOnPath, resolveSafe} from './paths.ts'

export interface DapStopped {
	threadId: number
	reason: string
	file: string | null
	line: number | null
}

export interface DapState {
	active: boolean
	program: string | null
	stopped: DapStopped | null
	error?: string
}

interface Pending {
	resolve: (v: unknown) => void
	reject: (e: Error) => void
	timer: ReturnType<typeof setTimeout>
}

interface DapSource {
	path?: string
}

function relFromAbs(rootDir: string, abs: string): string | null {
	const rel = path
		.relative(rootDir, path.normalize(abs))
		.split(path.sep)
		.join('/')
	if (!rel || rel.startsWith('..')) return null
	return rel
}

export class DapManager {
	private proc: ChildProcess | null = null
	private buf = Buffer.alloc(0)
	private seq = 1
	private pending = new Map<number, Pending>()
	private sockets = new Set<WebSocket>()
	private initWaiters: {resolve: () => void; reject: (e: Error) => void}[] = []
	breakpoints = new Map<string, number[]>()
	readonly rootDir: string
	state: DapState = {active: false, program: null, stopped: null}

	constructor(rootDir: string) {
		this.rootDir = rootDir
	}

	status(): DapState {
		return {...this.state}
	}

	private pythonBin: string | null | undefined

	/** First python on PATH that can import debugpy.adapter (cached). */
	private async resolvePython(): Promise<string> {
		if (this.pythonBin) return this.pythonBin
		const tried: string[] = []
		for (const name of ['python3', 'python', 'py']) {
			const bin = findOnPath(name)
			if (!bin || tried.includes(bin)) continue
			tried.push(bin)
			try {
				await this.checkDebugpy(bin)
				this.pythonBin = bin
				return bin
			} catch {
				/* try next interpreter */
			}
		}
		this.pythonBin = null
		throw Object.assign(
			new Error(
				'no python with debugpy found' +
					(tried.length ? ` (tried: ${tried.join(', ')})` : ' (no python on PATH)') +
					' — run: pip install debugpy; Termux: pkg install python && pip install debugpy',
			),
			{status: 501},
		)
	}

	private async checkDebugpy(bin: string): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const p = spawn(bin, ['-c', 'import debugpy.adapter'], {
				stdio: 'ignore',
			})
			const t = setTimeout(() => {
				try {
					p.kill()
				} catch {
					/* ignore */
				}
				reject(new Error('debugpy check timed out'))
			}, 10000)
			p.on('error', err => {
				clearTimeout(t)
				reject(err)
			})
			p.on('exit', code => {
				clearTimeout(t)
				if (code === 0) resolve()
				else
					reject(
						new Error(
							'debugpy is not installed for ' +
								bin +
								' (run: pip install debugpy; Termux: pkg install python && pip install debugpy)',
						),
					)
			})
		})
	}

	/** Spawn a fresh adapter and run the initialize handshake. */
	private async spawnAdapter(): Promise<void> {
		this.killProc()
		// Throws 501 with install instructions when nothing qualifies.
		const bin = await this.resolvePython()
		// Frozen modules break breakpoints on 3.11+ (debugpy warns); disable them.
		const proc = spawn(bin, ['-Xfrozen_modules=off', '-m', 'debugpy.adapter'], {
			cwd: this.rootDir,
			env: {...process.env},
			stdio: ['pipe', 'pipe', 'pipe'],
		})
		this.proc = proc
		this.buf = Buffer.alloc(0)
		proc.stdout?.on('data', d => this.onData(Buffer.from(d)))
		proc.stderr?.on('data', () => {
			/* adapter logs go here; surfaced via output events instead */
		})
		proc.on('error', err => this.failAll(err))
		proc.on('exit', () => {
			this.failAll(new Error('debug adapter exited'))
			this.proc = null
		})
		try {
			await this.request('initialize', {
				clientID: 'td-code',
				adapterID: 'debugpy',
				linesStartAt1: true,
				columnsStartAt1: true,
				pathFormat: 'path',
			})
		} catch (err) {
			this.killProc()
			throw err
		}
	}

	/** Launch a program. Resolves once configurationDone is accepted (running). */
	async start(
		relProgram: string,
		opts: {stopOnEntry?: boolean} = {},
	): Promise<DapState> {
		if (this.state.active) await this.stop()
		const abs = resolveSafe(this.rootDir, relProgram)
		if (!abs)
			throw Object.assign(new Error('program escapes root'), {status: 403})
		if (!relProgram.endsWith('.py'))
			throw Object.assign(new Error('only .py programs are supported in v1'), {
				status: 400,
			})
		const {promises: fs} = await import('node:fs')
		try {
			const st = await fs.stat(abs)
			if (!st.isFile()) throw new Error('not a file')
		} catch {
			throw Object.assign(new Error(`program not found: ${relProgram}`), {
				status: 404,
			})
		}

		await this.spawnAdapter()
		this.state = {active: true, program: relProgram, stopped: null}

		const initialized = new Promise<void>((resolve, reject) => {
			const t = setTimeout(
				() => reject(new Error('adapter init timeout')),
				20000,
			)
			this.initWaiters.push({
				resolve: () => {
					clearTimeout(t)
					resolve()
				},
				reject: (e: Error) => {
					clearTimeout(t)
					reject(e)
				},
			})
		})
		// NOTE: debugpy withholds the `launch` response until the client
		// finishes configuration (setBreakpoints + configurationDone), so the
		// launch request must NOT be awaited before the `initialized` event.
		const launchP = this.request(
			'launch',
			{
				program: abs,
				console: 'internalConsole',
				justMyCode: true,
				stopOnEntry: opts.stopOnEntry ?? false,
				cwd: this.rootDir,
			},
			60000,
		)
		// Surface async launch failures without unhandled rejections.
		launchP.catch(() => {})
		try {
			await initialized
		} catch (err) {
			this.killProc()
			this.state = {active: false, program: null, stopped: null}
			throw err
		}
		// (Re)apply all known breakpoints, then let the program run.
		for (const [p, lines] of this.breakpoints) {
			const a = resolveSafe(this.rootDir, p)
			if (a) await this.applyBreakpoints(a, lines).catch(() => {})
		}
		await this.request('configurationDone', {})
		// The launch response should arrive now that configuration is done.
		await launchP
		this.broadcast({
			type: 'event',
			event: 'started',
			body: {program: relProgram},
		})
		return this.status()
	}

	async setBreakpoints(relPath: string, lines: number[]): Promise<unknown> {
		const clean = [...new Set(lines.filter(n => Number.isInteger(n) && n > 0))]
			.sort((a, b) => a - b)
			.slice(0, 100)
		this.breakpoints.set(relPath, clean)
		const abs = resolveSafe(this.rootDir, relPath)
		if (!abs || !this.proc) return {verified: false, stored: true}
		return this.applyBreakpoints(abs, clean).catch(err => ({
			error: err instanceof Error ? err.message : String(err),
		}))
	}

	private applyBreakpoints(abs: string, lines: number[]): Promise<unknown> {
		return this.request('setBreakpoints', {
			source: {path: abs},
			breakpoints: lines.map(l => ({line: l})),
		})
	}

	request(
		command: string,
		args: unknown = {},
		timeoutMs = 15000,
	): Promise<unknown> {
		if (!this.proc || this.proc.killed)
			return Promise.reject(new Error('debug adapter not running'))
		const seq = this.seq++
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(seq)
				reject(new Error(`dap timeout: ${command}`))
			}, timeoutMs)
			this.pending.set(seq, {resolve, reject, timer})
			this.sendRaw({seq, type: 'request', command, arguments: args})
		})
	}

	private sendRaw(msg: unknown) {
		if (!this.proc?.stdin) return
		try {
			const body = Buffer.from(JSON.stringify(msg), 'utf-8')
			this.proc.stdin.write(
				Buffer.concat([
					Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
					body,
				]),
			)
		} catch {
			/* ignore */
		}
	}

	async stop(): Promise<void> {
		const wasActive = this.state.active
		this.state = {active: false, program: null, stopped: null}
		if (this.proc && !this.proc.killed) {
			try {
				await this.request('disconnect', {terminateDebuggee: true}, 5000).catch(
					() => {},
				)
			} finally {
				this.killProc()
			}
		} else {
			this.killProc()
		}
		for (const w of this.initWaiters.splice(0)) {
			w.reject(new Error('debug session stopped'))
		}
		if (wasActive)
			this.broadcast({type: 'event', event: 'terminated', body: {}})
	}

	private killProc() {
		const p = this.proc
		this.proc = null
		if (!p) return
		try {
			if (!p.killed) p.kill('SIGTERM')
		} catch {
			/* ignore */
		}
		setTimeout(() => {
			try {
				if (!p.killed) p.kill('SIGKILL')
			} catch {
				/* ignore */
			}
		}, 2000).unref?.()
		for (const [, pd] of this.pending) {
			clearTimeout(pd.timer)
			pd.reject(new Error('debug adapter exited'))
		}
		this.pending.clear()
	}

	private failAll(err: Error) {
		for (const [, p] of this.pending) {
			clearTimeout(p.timer)
			p.reject(err)
		}
		this.pending.clear()
		for (const w of this.initWaiters.splice(0)) w.reject(err)
	}

	private onData(chunk: Buffer) {
		this.buf = Buffer.concat([this.buf, chunk])
		for (;;) {
			const h = this.buf.indexOf('\r\n\r\n')
			if (h === -1) return
			const m = this.buf
				.subarray(0, h)
				.toString('utf-8')
				.match(/Content-Length:\s*(\d+)/i)
			if (!m) {
				this.buf = this.buf.subarray(h + 4)
				continue
			}
			const len = Number(m[1])
			if (this.buf.length < h + 4 + len) return
			const body = this.buf.subarray(h + 4, h + 4 + len)
			this.buf = this.buf.subarray(h + 4 + len)
			try {
				this.onMessage(JSON.parse(body.toString('utf-8')))
			} catch {
				/* ignore */
			}
		}
	}

	private onMessage(
		msg: {
			type?: string
			seq?: number
			request_seq?: number
			success?: boolean
			command?: string
			body?: unknown
			event?: string
		} & Record<string, unknown>,
	) {
		if (msg.type === 'response' && typeof msg.request_seq === 'number') {
			const p = this.pending.get(msg.request_seq)
			if (p) {
				this.pending.delete(msg.request_seq)
				clearTimeout(p.timer)
				if (msg.success) p.resolve(msg.body)
				else {
					const m =
						(
							msg.body as
								{error?: {showUser?: boolean; format?: string}} | undefined
						)?.error?.format ?? `request failed: ${msg.command}`
					p.reject(new Error(String(m).slice(0, 500)))
				}
			}
			return
		}
		if (msg.type !== 'event' || typeof msg.event !== 'string') return
		void this.onEvent(msg.event, (msg.body ?? {}) as Record<string, unknown>)
	}

	private async onEvent(event: string, body: Record<string, unknown>) {
		if (event === 'initialized') {
			for (const w of this.initWaiters.splice(0)) w.resolve()
			return
		}
		if (event === 'stopped') {
			const threadId = Number(body.threadId ?? 0)
			const reason = String(body.reason ?? 'unknown')
			let file: string | null = null
			let line: number | null = null
			try {
				const trace = (await this.request(
					'stackTrace',
					{threadId, startFrame: 0, levels: 1},
					8000,
				).catch(() => null)) as {
					stackFrames?: {source?: DapSource; line?: number}[]
				} | null
				const top = trace?.stackFrames?.[0]
				if (top?.source?.path) {
					file = relFromAbs(this.rootDir, top.source.path)
					line = typeof top.line === 'number' ? top.line : null
				}
			} catch {
				/* keep stopped without location */
			}
			this.state.stopped = {threadId, reason, file, line}
			this.broadcast({
				type: 'event',
				event: 'stopped',
				body: {threadId, reason, file, line},
			})
			return
		}
		if (event === 'continued') {
			const all = (body.allThreadsContinued as boolean | undefined) ?? true
			if (all) this.state.stopped = null
			else if (
				typeof body.threadId === 'number' &&
				this.state.stopped?.threadId === body.threadId
			) {
				this.state.stopped = null
			}
			this.broadcast({type: 'event', event: 'continued', body})
			return
		}
		if (event === 'terminated' || event === 'exited') {
			this.state = {active: false, program: this.state.program, stopped: null}
			this.broadcast({type: 'event', event, body})
			return
		}
		if (event === 'output') {
			const b = body as {output?: unknown}
			if (typeof b.output === 'string' && b.output.length > 4000) {
				b.output = b.output.slice(0, 4000) + '…(truncated)'
			}
			this.broadcast({type: 'event', event: 'output', body: b})
			return
		}
		// Forward anything else (module, breakpoint, capabilities, …) untouched.
		this.broadcast({type: 'event', event, body})
	}

	attach(ws: WebSocket) {
		this.sockets.add(ws)
		ws.on('close', () => this.sockets.delete(ws))
		ws.on('error', () => {
			try {
				ws.close()
			} catch {
				/* ignore */
			}
		})
		ws.on('message', raw => {
			let msg: {
				type?: string
				id?: number
				command?: string
				args?: unknown
				path?: string
				lines?: number[]
			}
			try {
				msg = JSON.parse(raw.toString())
			} catch {
				return
			}
			void (async () => {
				try {
					if (msg.type === 'breakpoints' && typeof msg.path === 'string') {
						const r = await this.setBreakpoints(msg.path, msg.lines ?? [])
						this.sendWs(ws, {type: 'ack', path: msg.path, result: r})
					} else if (
						msg.type === 'request' &&
						msg.command &&
						typeof msg.id === 'number'
					) {
						const result = await this.request(msg.command, msg.args ?? {})
						this.sendWs(ws, {type: 'response', id: msg.id, result, error: null})
					} else {
						this.sendWs(ws, {type: 'error', error: 'unknown message'})
					}
				} catch (err) {
					this.sendWs(ws, {
						type:
							msg.type === 'request' && typeof msg.id === 'number'
								? 'response'
								: 'error',
						...(typeof msg.id === 'number' ? {id: msg.id} : {}),
						error: err instanceof Error ? err.message : String(err),
					})
				}
			})()
		})
		this.sendWs(ws, {type: 'hello', state: this.status()})
	}

	private broadcast(msg: unknown) {
		const body = JSON.stringify(msg)
		for (const ws of this.sockets) {
			try {
				if (ws.readyState === 1) ws.send(body)
			} catch {
				/* ignore */
			}
		}
	}

	private sendWs(ws: WebSocket, msg: unknown) {
		try {
			if (ws.readyState === 1) ws.send(JSON.stringify(msg))
		} catch {
			/* ignore */
		}
	}

	shutdown() {
		this.killProc()
		this.state = {active: false, program: null, stopped: null}
	}
}
