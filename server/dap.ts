import {spawn, type ChildProcess} from 'node:child_process'
import path from 'node:path'
import type {WebSocket} from 'ws'
import {findOnPath, findRootForPath, resolveSafe} from './paths.ts'

export interface DapBp {
	line: number
	condition?: string
	hitCondition?: string
}

export interface DapStopped {
	threadId: number
	reason: string
	file: string | null
	line: number | null
}

export interface DapState {
	active: boolean
	adapter: string | null
	program: string | null
	stopped: DapStopped | null
	error?: string
	rootDir?: string
}

export interface AdapterDef {
	/** stable id, reported in status */
	id: string
	label: string
	/** file extensions (lowercase, with dot) this adapter debugs */
	exts: string[]
	/** DAP initialize adapterID */
	adapterID: string
	/** resolve spawn command; throws {status} with setup instructions */
	resolve: () => Promise<{cmd: string; args: string[]}>
	/** DAP launch arguments for a program */
	launchArgs: (
		absProgram: string,
		rootDir: string,
		opts: {stopOnEntry?: boolean},
	) => Record<string, unknown>
}

interface Pending {
	resolve: (v: unknown) => void
	reject: (e: Error) => void
	timer: ReturnType<typeof setTimeout>
}

interface DapSource {
	path?: string
}

/** Extra node runtime args (e.g. --experimental-strip-types for .ts on node 22). */
function nodeRuntimeArgs(): string[] {
	return (process.env.TD_CODE_NODE_RUNTIME_ARGS ?? '')
		.split(/\s+/)
		.filter(Boolean)
}

function relFromAbs(rootDir: string, abs: string): string | null {
	const rel = path
		.relative(rootDir, path.normalize(abs))
		.split(path.sep)
		.join('/')
	if (!rel || rel.startsWith('..')) return null
	return rel
}

function splitCmd(value: string): string[] {
	return (value.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(s =>
		s.replace(/^["']|["']$/g, ''),
	)
}

/** Per-root DAP session state */
interface DapSession {
	proc: ChildProcess | null
	buf: Buffer
	seq: number
	pending: Map<number, Pending>
	sockets: Set<WebSocket>
	initWaiters: {resolve: () => void; reject: (e: Error) => void}[]
	breakpoints: Map<string, DapBp[]>
	rootDir: string
	adapterDef: AdapterDef | null
	state: DapState
}

export class DapManager {
	private sessions = new Map<string, DapSession>() // rootDir -> DapSession
	readonly rootDirs: string[]

	constructor(rootDirs: string | string[]) {
		this.rootDirs = Array.isArray(rootDirs) ? rootDirs : [rootDirs]
	}

	/** @deprecated Use rootDirs instead */
	get rootDir(): string {
		return this.rootDirs[0]
	}

	status(rootDir?: string): DapState {
		const targetRoot = rootDir ?? this.rootDirs[0]
		const session = this.sessions.get(targetRoot)
		if (session) {
			return {...session.state, rootDir: targetRoot}
		}
		return {
			active: false,
			adapter: null,
			program: null,
			stopped: null,
			rootDir: targetRoot,
		}
	}

	private pythonBin: string | null | undefined

	private adapters: AdapterDef[] = [
		{
			id: 'python',
			label: 'Python (debugpy)',
			exts: ['.py'],
			adapterID: 'debugpy',
			resolve: async () => ({
				cmd: await this.resolvePython(),
				// Frozen modules break breakpoints on 3.11+ (debugpy warns).
				args: ['-Xfrozen_modules=off', '-m', 'debugpy.adapter'],
			}),
			launchArgs: (abs, root, opts) => ({
				program: abs,
				console: 'internalConsole',
				justMyCode: true,
				stopOnEntry: opts.stopOnEntry ?? false,
				cwd: root,
			}),
		},
		{
			id: 'node',
			label: 'Node.js (js-debug)',
			exts: ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'],
			adapterID: 'pwa-node',
			resolve: async () => {
				// Full command line so entries needing a runtime work, e.g.
				//   TD_CODE_JS_DEBUG="node /opt/js-debug/out/src/dapDebugServer.js"
				const parts = splitCmd((process.env.TD_CODE_JS_DEBUG ?? '').trim())
				if (parts.length > 0) {
					const cmd = parts[0] as string
					return {cmd, args: parts.slice(1)}
				}
				const bin = findOnPath('js-debug')
				if (bin) return {cmd: bin, args: []}
				throw Object.assign(
					new Error(
						'js-debug not found — download js-debug-dap from ' +
							'microsoft/vscode-js-debug releases (or copy it from a VS Code ' +
							'install), ensure node is on PATH, and set TD_CODE_JS_DEBUG to ' +
							'its entry command, e.g. TD_CODE_JS_DEBUG="node /opt/js-debug/dapDebugServer.js"',
					),
					{status: 501},
				)
			},
			launchArgs: (abs, root, opts) => ({
				type: 'pwa-node',
				request: 'launch',
				program: abs,
				cwd: root,
				console: 'internalConsole',
				stopOnEntry: opts.stopOnEntry ?? false,
				// .ts support: node strips types natively on 23.6+; older
				// 22.x needs --experimental-strip-types, e.g.
				// TD_CODE_NODE_RUNTIME_ARGS="--experimental-strip-types"
				...(nodeRuntimeArgs().length ? {runtimeArgs: nodeRuntimeArgs()} : {}),
			}),
		},
	]

	private adapterFor(relProgram: string): AdapterDef | null {
		const lower = relProgram.toLowerCase()
		return this.adapters.find(a => a.exts.some(e => lower.endsWith(e))) ?? null
	}

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
					(tried.length
						? ` (tried: ${tried.join(', ')})`
						: ' (no python on PATH)') +
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

	private getSession(rootDir: string): DapSession {
		let session = this.sessions.get(rootDir)
		if (!session) {
			session = {
				proc: null,
				buf: Buffer.alloc(0),
				seq: 1,
				pending: new Map(),
				sockets: new Set(),
				initWaiters: [],
				breakpoints: new Map(),
				rootDir,
				adapterDef: null,
				state: {active: false, adapter: null, program: null, stopped: null},
			}
			this.sessions.set(rootDir, session)
		}
		return session
	}

	/** Spawn a fresh adapter and run the initialize handshake. */
	private async spawnAdapter(
		session: DapSession,
		def: AdapterDef,
	): Promise<void> {
		this.killProc(session)
		// Throws {status} with setup instructions when nothing qualifies.
		const {cmd, args} = await def.resolve()
		const proc = spawn(cmd, args, {
			cwd: session.rootDir,
			env: {...process.env},
			stdio: ['pipe', 'pipe', 'pipe'],
		})
		session.proc = proc
		session.buf = Buffer.alloc(0)
		session.adapterDef = def
		proc.stdout?.on('data', d => this.onData(session, Buffer.from(d)))
		proc.stderr?.on('data', () => {
			/* adapter logs go here; surfaced via output events instead */
		})
		proc.on('error', err => this.failAll(session, err))
		proc.on('exit', () => {
			this.failAll(session, new Error('debug adapter exited'))
			session.proc = null
		})
		try {
			await this.request(session, 'initialize', {
				clientID: 'td-code',
				adapterID: def.adapterID,
				linesStartAt1: true,
				columnsStartAt1: true,
				pathFormat: 'path',
			})
		} catch (err) {
			this.killProc(session)
			throw err
		}
	}

	/** Launch a program. Resolves once configurationDone is accepted (running). */
	async start(
		relProgram: string,
		opts: {stopOnEntry?: boolean; rootDir?: string} = {},
	): Promise<DapState> {
		const targetRoot =
			opts.rootDir ??
			findRootForPath(this.rootDirs, path.resolve(relProgram)) ??
			this.rootDirs[0]
		const session = this.getSession(targetRoot)

		if (session.state.active) await this.stop(targetRoot)
		const abs = resolveSafe(this.rootDirs, relProgram)
		if (!abs)
			throw Object.assign(new Error('program escapes root'), {status: 403})
		const def = this.adapterFor(relProgram)
		if (!def)
			throw Object.assign(
				new Error(
					`no debug adapter for ${relProgram} (supported: .py via debugpy, .js/.mjs/.cjs/.ts via js-debug)`,
				),
				{status: 400},
			)
		const {promises: fs} = await import('node:fs')
		try {
			const st = await fs.stat(abs)
			if (!st.isFile()) throw new Error('not a file')
		} catch {
			throw Object.assign(new Error(`program not found: ${relProgram}`), {
				status: 404,
			})
		}

		await this.spawnAdapter(session, def)
		session.state = {
			active: true,
			adapter: def.id,
			program: relProgram,
			stopped: null,
		}

		const initialized = new Promise<void>((resolve, reject) => {
			const t = setTimeout(
				() => reject(new Error('adapter init timeout')),
				20000,
			)
			session.initWaiters.push({
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
			session,
			'launch',
			def.launchArgs(abs, targetRoot, opts),
			60000,
		)
		// Surface async launch failures without unhandled rejections.
		launchP.catch(() => {})
		try {
			await initialized
		} catch (err) {
			this.killProc(session)
			session.state = {
				active: false,
				adapter: null,
				program: null,
				stopped: null,
			}
			throw err
		}
		// (Re)apply all known breakpoints, then let the program run.
		for (const [p, bps] of session.breakpoints) {
			const a = resolveSafe(this.rootDirs, p)
			if (a) await this.applyBreakpoints(session, a, bps).catch(() => {})
		}
		await this.request(session, 'configurationDone', {})
		// The launch response should arrive now that configuration is done.
		await launchP
		this.broadcast(session, {
			type: 'event',
			event: 'started',
			body: {program: relProgram},
		})
		return this.status(targetRoot)
	}

	async setBreakpoints(
		relPath: string,
		bps: (number | DapBp)[],
		rootDir?: string,
	): Promise<unknown> {
		const targetRoot =
			rootDir ??
			findRootForPath(this.rootDirs, path.resolve(relPath)) ??
			this.rootDirs[0]
		const session = this.getSession(targetRoot)

		const seen = new Set<number>()
		const clean: DapBp[] = []
		for (const b of bps) {
			const line = typeof b === 'number' ? b : b.line
			if (!Number.isInteger(line) || line <= 0 || seen.has(line)) continue
			seen.add(line)
			if (typeof b === 'number') clean.push({line})
			else
				clean.push({
					line,
					...(b.condition ? {condition: b.condition.slice(0, 500)} : {}),
					...(b.hitCondition
						? {hitCondition: b.hitCondition.slice(0, 100)}
						: {}),
				})
			if (clean.length >= 100) break
		}
		clean.sort((a, b) => a.line - b.line)
		session.breakpoints.set(relPath, clean)
		const abs = resolveSafe(this.rootDirs, relPath)
		if (!abs || !session.proc) return {verified: false, stored: true}
		return this.applyBreakpoints(session, abs, clean).catch(err => ({
			error: err instanceof Error ? err.message : String(err),
		}))
	}

	private applyBreakpoints(
		session: DapSession,
		abs: string,
		bps: DapBp[],
	): Promise<unknown> {
		return this.request(session, 'setBreakpoints', {
			source: {path: abs},
			breakpoints: bps.map(b => ({
				line: b.line,
				...(b.condition ? {condition: b.condition} : {}),
				...(b.hitCondition ? {hitCondition: b.hitCondition} : {}),
			})),
		})
	}

	request(
		session: DapSession,
		command: string,
		args: unknown = {},
		timeoutMs = 15000,
	): Promise<unknown> {
		if (!session.proc || session.proc.killed)
			return Promise.reject(new Error('debug adapter not running'))
		const seq = session.seq++
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				session.pending.delete(seq)
				reject(new Error(`dap timeout: ${command}`))
			}, timeoutMs)
			session.pending.set(seq, {resolve, reject, timer})
			this.sendRaw(session, {seq, type: 'request', command, arguments: args})
		})
	}

	private sendRaw(session: DapSession, msg: unknown) {
		if (!session.proc?.stdin) return
		try {
			const body = Buffer.from(JSON.stringify(msg), 'utf-8')
			session.proc.stdin.write(
				Buffer.concat([
					Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
					body,
				]),
			)
		} catch {
			/* ignore */
		}
	}

	async stop(rootDir?: string): Promise<void> {
		const targetRoot = rootDir ?? this.rootDirs[0]
		const session = this.getSession(targetRoot)

		const wasActive = session.state.active
		session.state = {active: false, adapter: null, program: null, stopped: null}
		if (session.proc && !session.proc.killed) {
			try {
				await this.request(
					session,
					'disconnect',
					{terminateDebuggee: true},
					5000,
				).catch(() => {})
			} finally {
				this.killProc(session)
			}
		} else {
			this.killProc(session)
		}
		for (const w of session.initWaiters.splice(0)) {
			w.reject(new Error('debug session stopped'))
		}
		if (wasActive)
			this.broadcast(session, {type: 'event', event: 'terminated', body: {}})
	}

	private killProc(session: DapSession) {
		const p = session.proc
		session.proc = null
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
		for (const [, pd] of session.pending) {
			clearTimeout(pd.timer)
			pd.reject(new Error('debug adapter exited'))
		}
		session.pending.clear()
	}

	private failAll(session: DapSession, err: Error) {
		for (const [, p] of session.pending) {
			clearTimeout(p.timer)
			p.reject(err)
		}
		session.pending.clear()
		for (const w of session.initWaiters.splice(0)) w.reject(err)
	}

	private onData(session: DapSession, chunk: Buffer) {
		session.buf = Buffer.concat([session.buf, chunk])
		for (;;) {
			const h = session.buf.indexOf('\r\n\r\n')
			if (h === -1) return
			const m = session.buf
				.subarray(0, h)
				.toString('utf-8')
				.match(/Content-Length:\s*(\d+)/i)
			if (!m) {
				session.buf = session.buf.subarray(h + 4)
				continue
			}
			const len = Number(m[1])
			if (session.buf.length < h + 4 + len) return
			const body = session.buf.subarray(h + 4, h + 4 + len)
			session.buf = session.buf.subarray(h + 4 + len)
			try {
				this.onMessage(session, JSON.parse(body.toString('utf-8')))
			} catch {
				/* ignore */
			}
		}
	}

	private onMessage(
		session: DapSession,
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
			const p = session.pending.get(msg.request_seq)
			if (p) {
				session.pending.delete(msg.request_seq)
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
		void this.onEvent(
			session,
			msg.event,
			(msg.body ?? {}) as Record<string, unknown>,
		)
	}

	private async onEvent(
		session: DapSession,
		event: string,
		body: Record<string, unknown>,
	) {
		if (event === 'initialized') {
			for (const w of session.initWaiters.splice(0)) w.resolve()
			return
		}
		if (event === 'stopped') {
			const threadId = Number(body.threadId ?? 0)
			const reason = String(body.reason ?? 'unknown')
			let file: string | null = null
			let line: number | null = null
			try {
				const trace = (await this.request(
					session,
					'stackTrace',
					{threadId, startFrame: 0, levels: 1},
					8000,
				).catch(() => null)) as {
					stackFrames?: {source?: DapSource; line?: number}[]
				} | null
				const top = trace?.stackFrames?.[0]
				if (top?.source?.path) {
					file = relFromAbs(session.rootDir, top.source.path)
					line = typeof top.line === 'number' ? top.line : null
				}
			} catch {
				/* keep stopped without location */
			}
			session.state.stopped = {threadId, reason, file, line}
			this.broadcast(session, {
				type: 'event',
				event: 'stopped',
				body: {threadId, reason, file, line},
			})
			return
		}
		if (event === 'continued') {
			const all = (body.allThreadsContinued as boolean | undefined) ?? true
			if (all) session.state.stopped = null
			else if (
				typeof body.threadId === 'number' &&
				session.state.stopped?.threadId === body.threadId
			) {
				session.state.stopped = null
			}
			this.broadcast(session, {type: 'event', event: 'continued', body})
			return
		}
		if (event === 'terminated' || event === 'exited') {
			session.state = {
				active: false,
				adapter: session.state.adapter,
				program: session.state.program,
				stopped: null,
			}
			this.broadcast(session, {type: 'event', event, body})
			return
		}
		if (event === 'output') {
			const b = body as {output?: unknown}
			if (typeof b.output === 'string' && b.output.length > 4000) {
				b.output = b.output.slice(0, 4000) + '…(truncated)'
			}
			this.broadcast(session, {type: 'event', event: 'output', body: b})
			return
		}
		// Forward anything else (module, breakpoint, capabilities, …) untouched.
		this.broadcast(session, {type: 'event', event, body})
	}

	attach(ws: WebSocket, rootDir?: string) {
		const targetRoot = rootDir ?? this.rootDirs[0]
		const session = this.getSession(targetRoot)

		session.sockets.add(ws)
		ws.on('close', () => session.sockets.delete(ws))
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
				breakpoints?: DapBp[]
				rootDir?: string
			}
			try {
				msg = JSON.parse(raw.toString())
			} catch {
				return
			}
			void (async () => {
				try {
					const msgRoot = msg.rootDir ?? targetRoot
					const msgSession = this.getSession(msgRoot)
					if (msg.type === 'breakpoints' && typeof msg.path === 'string') {
						const r = await this.setBreakpoints(
							msg.path,
							(msg.breakpoints as DapBp[] | undefined) ??
								(msg.lines as number[] | undefined) ??
								[],
							msgRoot,
						)
						this.sendWs(ws, {type: 'ack', path: msg.path, result: r})
					} else if (
						msg.type === 'request' &&
						msg.command &&
						typeof msg.id === 'number'
					) {
						const result = await this.request(
							msgSession,
							msg.command,
							msg.args ?? {},
						)
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
		this.sendWs(ws, {type: 'hello', state: this.status(targetRoot)})
	}

	private broadcast(session: DapSession, msg: unknown) {
		const body = JSON.stringify(msg)
		for (const ws of session.sockets) {
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
		for (const [, session] of this.sessions) {
			this.killProc(session)
		}
		this.sessions.clear()
	}
}
