import {spawn, type ChildProcess} from 'node:child_process'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import type {WebSocket} from 'ws'
import {findOnPath} from './paths.ts'

export type LspLang = 'typescript' | 'javascript'

interface Pending {
	resolve: (v: unknown) => void
	reject: (e: Error) => void
	timer: ReturnType<typeof setTimeout>
}

interface LangServer {
	proc: ChildProcess
	buf: Buffer
	nextId: number
	pending: Map<number, Pending>
	openDocs: Map<string, number>
	initialized: boolean
	startError?: string
	rootDir: string
}

function uriFor(rootDir: string, relPath: string): string {
	const abs = path.resolve(rootDir, relPath.replace(/^\/+/, ''))
	return pathToFileURL(abs).toString()
}

function relFromUri(rootDir: string, uri: string): string {
	try {
		const u = new URL(uri)
		if (u.protocol !== 'file:') return uri
		// Strip the leading slash from Windows file URLs (/D:/...) BEFORE
		// normalize: path.normalize('/D:/x') on win32 yields '\D:\x',
		// which is not absolute and breaks path.relative.
		let p = decodeURIComponent(u.pathname)
		if (process.platform === 'win32' && /^\/[A-Za-z]:\//.test(p)) {
			p = p.slice(1)
		}
		const abs = path.normalize(p)
		return path.relative(rootDir, abs).split(path.sep).join('/')
	} catch {
		return uri
	}
}

/** Find which root a path belongs to */
function findRootForPath(rootDirs: string[], absPath: string): string | null {
	const normalized = path.resolve(absPath)
	for (const root of rootDirs) {
		const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
		if (normalized === root || normalized.startsWith(rootWithSep)) {
			return root
		}
	}
	return null
}

export class LspManager {
	private servers = new Map<string, Map<string, LangServer>>() // lang -> rootDir -> LangServer
	private sockets = new Map<string, Set<WebSocket>>() // lang -> Set<WebSocket>
	readonly rootDirs: string[]

	constructor(rootDirs: string | string[]) {
		this.rootDirs = Array.isArray(rootDirs) ? rootDirs : [rootDirs]
	}

	supported(): string[] {
		return ['typescript', 'javascript']
	}

	status(
		rootDir?: string,
	): {lang: string; running: boolean; error?: string; rootDir?: string}[] {
		if (rootDir) {
			// Status for a specific root
			const out: {
				lang: string
				running: boolean
				error?: string
				rootDir?: string
			}[] = []
			for (const lang of this.supported()) {
				const rootMap = this.servers.get(lang)
				const s = rootMap?.get(rootDir)
				out.push({
					lang,
					running: Boolean(s?.proc && !s.proc.killed && s.initialized),
					rootDir,
					...(s?.startError ? {error: s.startError} : {}),
				})
			}
			return out
		}
		// Status for all roots
		const out: {
			lang: string
			running: boolean
			error?: string
			rootDir?: string
		}[] = []
		for (const lang of this.supported()) {
			const rootMap = this.servers.get(lang)
			if (!rootMap) continue
			for (const [root, s] of rootMap) {
				out.push({
					lang,
					running: Boolean(s?.proc && !s.proc.killed && s.initialized),
					rootDir: root,
					...(s?.startError ? {error: s.startError} : {}),
				})
			}
		}
		return out
	}

	/** Resolve how to launch typescript-language-server. Returns null when unavailable. */
	private launch(): {cmd: string; args: string[]} | null {
		const direct = findOnPath('typescript-language-server')
		if (direct) return {cmd: direct, args: ['--stdio']}
		// NOTE: do NOT pass `--bun` here. Forcing the Bun runtime crashes the
		// tsserver child process (observed exit code 1 on Windows). Plain
		// `bunx <pkg>` runs the CLI while tsserver still spawns under node.
		if (findOnPath('bunx'))
			return {
				cmd: findOnPath('bunx') as string,
				args: ['typescript-language-server', '--stdio'],
			}
		if (findOnPath('bun'))
			return {
				cmd: findOnPath('bun') as string,
				args: ['x', 'typescript-language-server', '--stdio'],
			}
		if (findOnPath('npx'))
			return {
				cmd: findOnPath('npx') as string,
				args: ['--yes', 'typescript-language-server', '--stdio'],
			}
		return null
	}

	async ensure(lang: string, rootDir?: string): Promise<LangServer> {
		const targetRoot = rootDir ?? this.rootDirs[0]
		const rootMap = this.servers.get(lang) ?? new Map()
		const existing = rootMap.get(targetRoot)
		if (existing?.proc && !existing.proc.killed) return existing
		if (lang !== 'typescript' && lang !== 'javascript') {
			throw Object.assign(new Error(`unsupported language: ${lang}`), {
				status: 400,
			})
		}
		const launch = this.launch()
		if (!launch) {
			throw Object.assign(
				new Error(
					'typescript-language-server not found. Install it: bun add -d typescript-language-server typescript  (or npm i -D typescript-language-server typescript)',
				),
				{status: 501},
			)
		}
		const proc = spawn(launch.cmd, launch.args, {
			cwd: targetRoot,
			env: {...process.env},
			stdio: ['pipe', 'pipe', 'pipe'],
		})
		const srv: LangServer = {
			proc,
			buf: Buffer.alloc(0),
			nextId: 1,
			pending: new Map(),
			openDocs: new Map(),
			initialized: false,
			rootDir: targetRoot,
		}
		rootMap.set(targetRoot, srv)
		this.servers.set(lang, rootMap)
		proc.stdout?.on('data', d => this.onData(lang, srv, Buffer.from(d)))
		proc.stderr?.on('data', d => {
			const msg = d.toString('utf-8').slice(0, 500)
			if (/cannot find|ERR|error/i.test(msg)) srv.startError = msg.trim()
		})
		proc.on('error', err => {
			srv.startError = err.message
			for (const p of srv.pending.values()) {
				clearTimeout(p.timer)
				p.reject(err)
			}
			srv.pending.clear()
		})
		proc.on('exit', () => {
			for (const p of srv.pending.values()) {
				clearTimeout(p.timer)
				p.reject(new Error('language server exited'))
			}
			srv.pending.clear()
			srv.initialized = false
		})
		try {
			await this.request(lang, targetRoot, 'initialize', {
				processId: process.pid,
				rootUri: pathToFileURL(targetRoot).toString(),
				capabilities: {
					textDocument: {
						hover: {contentFormat: ['markdown', 'plaintext']},
						completion: {completionItem: {snippetSupport: false}},
						publishDiagnostics: {},
					},
				},
			})
			this.notify(lang, targetRoot, 'initialized', {})
			srv.initialized = true
		} catch (err) {
			srv.startError = err instanceof Error ? err.message : String(err)
			throw err
		}
		return srv
	}

	private frame(msg: unknown): Buffer {
		const body = Buffer.from(JSON.stringify(msg), 'utf-8')
		return Buffer.concat([
			Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf-8'),
			body,
		])
	}

	private send(lang: string, rootDir: string, msg: unknown) {
		const rootMap = this.servers.get(lang)
		const srv = rootMap?.get(rootDir)
		srv?.proc.stdin?.write(this.frame(msg))
	}

	notify(lang: string, rootDir: string, method: string, params: unknown) {
		this.send(lang, rootDir, {jsonrpc: '2.0', method, params})
	}

	request(
		lang: string,
		rootDir: string,
		method: string,
		params: unknown,
		timeoutMs = 8000,
	): Promise<unknown> {
		const rootMap = this.servers.get(lang)
		const srv = rootMap?.get(rootDir)
		if (!srv?.proc || srv.proc.killed)
			return Promise.reject(new Error('language server not running'))
		const id = srv.nextId++
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				srv.pending.delete(id)
				reject(new Error(`lsp timeout: ${method}`))
			}, timeoutMs)
			srv.pending.set(id, {resolve, reject, timer})
			this.send(lang, rootDir, {jsonrpc: '2.0', id, method, params})
		})
	}

	didOpen(lang: string, relPath: string, text: string, rootDir?: string) {
		const targetRoot =
			rootDir ??
			findRootForPath(this.rootDirs, path.resolve(relPath)) ??
			this.rootDirs[0]
		const rootMap = this.servers.get(lang)
		const srv = rootMap?.get(targetRoot)
		const uri = uriFor(targetRoot, relPath)
		const version = (srv?.openDocs.get(uri) ?? 0) + 1
		srv?.openDocs.set(uri, version)
		this.notify(lang, targetRoot, 'textDocument/didOpen', {
			textDocument: {uri, languageId: 'typescript', version, text},
		})
	}

	didChange(lang: string, relPath: string, text: string, rootDir?: string) {
		const targetRoot =
			rootDir ??
			findRootForPath(this.rootDirs, path.resolve(relPath)) ??
			this.rootDirs[0]
		const rootMap = this.servers.get(lang)
		const srv = rootMap?.get(targetRoot)
		const uri = uriFor(targetRoot, relPath)
		const version = (srv?.openDocs.get(uri) ?? 0) + 1
		srv?.openDocs.set(uri, version)
		this.notify(lang, targetRoot, 'textDocument/didChange', {
			textDocument: {uri, version},
			contentChanges: [{text}],
		})
	}

	didClose(lang: string, relPath: string, rootDir?: string) {
		const targetRoot =
			rootDir ??
			findRootForPath(this.rootDirs, path.resolve(relPath)) ??
			this.rootDirs[0]
		const rootMap = this.servers.get(lang)
		const srv = rootMap?.get(targetRoot)
		const uri = uriFor(targetRoot, relPath)
		srv?.openDocs.delete(uri)
		this.notify(lang, targetRoot, 'textDocument/didClose', {
			textDocument: {uri},
		})
	}

	private onData(lang: string, srv: LangServer, chunk: Buffer) {
		srv.buf = Buffer.concat([srv.buf, chunk])
		for (;;) {
			const headerEnd = srv.buf.indexOf('\r\n\r\n')
			if (headerEnd === -1) return
			const header = srv.buf.subarray(0, headerEnd).toString('utf-8')
			const m = header.match(/Content-Length:\s*(\d+)/i)
			if (!m) {
				srv.buf = srv.buf.subarray(headerEnd + 4)
				continue
			}
			const len = Number(m[1])
			if (srv.buf.length < headerEnd + 4 + len) return
			const body = srv.buf.subarray(headerEnd + 4, headerEnd + 4 + len)
			srv.buf = srv.buf.subarray(headerEnd + 4 + len)
			try {
				this.onMessage(lang, srv, JSON.parse(body.toString('utf-8')))
			} catch {
				/* ignore malformed */
			}
		}
	}

	private onMessage(
		lang: string,
		srv: LangServer,
		msg: {
			id?: number
			result?: unknown
			error?: unknown
			method?: string
			params?: unknown
		},
	) {
		if (typeof msg.id === 'number' && ('result' in msg || 'error' in msg)) {
			const p = srv.pending.get(msg.id)
			if (!p) return
			srv.pending.delete(msg.id)
			clearTimeout(p.timer)
			if ('error' in msg && msg.error !== undefined && msg.error !== null)
				p.reject(new Error(JSON.stringify(msg.error).slice(0, 500)))
			else p.resolve(msg.result)
			// Forward request/response to WS clients waiting on it
			this.broadcast(lang, {
				type: 'response',
				id: msg.id,
				result: msg.result,
				error: msg.error ?? null,
			})
			return
		}
		if (msg.method === 'textDocument/publishDiagnostics') {
			const params = msg.params as {
				uri: string
				diagnostics: Array<{
					range: {
						start: {line: number; character: number}
						end: {line: number; character: number}
					}
					severity?: number
					message: string
					source?: string
				}>
			}
			this.broadcast(lang, {
				type: 'diagnostics',
				uri: params.uri,
				path: relFromUri(srv.rootDir, params.uri),
				rootDir: srv.rootDir,
				diagnostics: params.diagnostics ?? [],
			})
		}
	}

	attach(ws: WebSocket, lang: string) {
		let set = this.sockets.get(lang)
		if (!set) {
			set = new Set()
			this.sockets.set(lang, set)
		}
		set.add(ws)
		ws.on('close', () => set?.delete(ws))
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
				method?: string
				params?: unknown
				path?: string
				text?: string
				rootDir?: string
			}
			try {
				msg = JSON.parse(raw.toString())
			} catch {
				return
			}
			void (async () => {
				try {
					const targetRoot = msg.rootDir ?? this.rootDirs[0]
					if (msg.type === 'open' && typeof msg.path === 'string') {
						await this.ensure(lang, targetRoot)
						this.didOpen(lang, msg.path, msg.text ?? '', targetRoot)
						this.sendWs(ws, {type: 'opened', path: msg.path})
					} else if (msg.type === 'change' && typeof msg.path === 'string') {
						this.didChange(lang, msg.path, msg.text ?? '', targetRoot)
					} else if (msg.type === 'close' && typeof msg.path === 'string') {
						this.didClose(lang, msg.path, targetRoot)
					} else if (
						msg.type === 'request' &&
						msg.method &&
						typeof msg.id === 'number'
					) {
						await this.ensure(lang, targetRoot)
						const result = await this.request(
							lang,
							targetRoot,
							msg.method,
							msg.params ?? {},
						)
						this.sendWs(ws, {type: 'response', id: msg.id, result, error: null})
					} else if (msg.type === 'ensure') {
						await this.ensure(lang, targetRoot)
						this.sendWs(ws, {type: 'ready', lang})
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
		// Best-effort: report current status immediately
		const rootMap = this.servers.get(lang)
		const s = rootMap?.get(this.rootDirs[0])
		this.sendWs(ws, {
			type: 'hello',
			lang,
			running: Boolean(s?.proc && !s.proc.killed && s.initialized),
		})
	}

	private broadcast(lang: string, msg: unknown) {
		const body = JSON.stringify(msg)
		for (const ws of this.sockets.get(lang) ?? []) {
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
		for (const [, rootMap] of this.servers) {
			for (const [, srv] of rootMap) {
				try {
					srv.proc.kill('SIGTERM')
				} catch {
					/* ignore */
				}
			}
		}
		this.servers.clear()
	}
}
