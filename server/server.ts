import {watch, type FSWatcher} from 'chokidar'
import {promises as fs} from 'node:fs'
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {WebSocketServer, type WebSocket} from 'ws'
import {lookup as mimeLookup} from './mime.ts'
import {resolveSafe} from './paths.ts'
import {TermManager} from './terminal.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface ServeOptions {
	rootDir: string
	port: number
	host: string
	authToken: string | null
	noWatch: boolean
	noTerms: boolean
	version: string
}

const MAX_FILE_BYTES = 2 * 1024 * 1024 // 2MB editable limit
const MAX_SEARCH_RESULTS = 200

function sendJson(res: ServerResponse, status: number, data: unknown) {
	const body = JSON.stringify(data)
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(body),
	})
	res.end(body)
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = ''
		req.on('data', chunk => {
			data += chunk
			if (data.length > 5 * 1024 * 1024) {
				reject(new Error('body too large'))
				req.destroy()
			}
		})
		req.on('end', () => resolve(data))
		req.on('error', reject)
	})
}

/** Resolve user-supplied relative path, jailed inside root. Returns null on escape. */
export {resolveSafe} from './paths.ts'

function isProbablyBinary(buf: Buffer): boolean {
	const sample = buf.subarray(0, Math.min(buf.length, 8000))
	for (let i = 0; i < sample.length; i++) {
		if (sample[i] === 0) return true
	}
	return false
}

async function listDir(abs: string, root: string) {
	const entries = await fs.readdir(abs, {withFileTypes: true})
	const out = await Promise.all(
		entries.map(async e => {
			const full = path.join(abs, e.name)
			let size = 0
			let mtime = 0
			try {
				const st = await fs.stat(full)
				size = st.size
				mtime = st.mtimeMs
			} catch {
				/* ignore */
			}
			return {
				name: e.name,
				path: path.relative(root, full).split(path.sep).join('/'),
				type: e.isDirectory() ? 'dir' : 'file',
				size,
				mtime,
			}
		}),
	)
	out.sort((a, b) => {
		if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
		return a.name.localeCompare(b.name)
	})
	return out
}

async function handleApi(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	opts: ServeOptions,
	terms: TermManager | null,
) {
	const method = req.method?.toUpperCase() ?? 'GET'

	// GET /api/health (no auth)
	if (url.pathname === '/api/health') {
		return sendJson(res, 200, {
			ok: true,
			root: opts.rootDir,
			version: opts.version,
			time: Date.now(),
		})
	}

	// --- auth check for everything else under /api ---
	if (opts.authToken) {
		const q = url.searchParams.get('token')
		const h =
			req.headers['authorization']?.replace(/^Bearer\s+/i, '') ??
			(req.headers['x-auth-token'] as string | undefined)
		if (q !== opts.authToken && h !== opts.authToken) {
			return sendJson(res, 401, {error: 'unauthorized: bad or missing token'})
		}
	}

	if (url.pathname === '/api/files' && method === 'GET') {
		const rel = url.searchParams.get('path') ?? ''
		const showHidden = url.searchParams.get('hidden') === '1'
		const abs = resolveSafe(opts.rootDir, rel)
		if (!abs) return sendJson(res, 403, {error: 'path escapes root'})
		try {
			const st = await fs.stat(abs)
			if (!st.isDirectory())
				return sendJson(res, 400, {error: 'not a directory'})
		} catch {
			return sendJson(res, 404, {error: 'directory not found'})
		}
		let items = await listDir(abs, opts.rootDir)
		if (!showHidden) items = items.filter(i => !i.name.startsWith('.'))
		return sendJson(res, 200, {path: rel, items})
	}

	if (url.pathname === '/api/file' && method === 'GET') {
		const rel = url.searchParams.get('path') ?? ''
		if (!rel) return sendJson(res, 400, {error: 'missing ?path='})
		const abs = resolveSafe(opts.rootDir, rel)
		if (!abs) return sendJson(res, 403, {error: 'path escapes root'})
		try {
			const st = await fs.stat(abs)
			if (st.isDirectory()) return sendJson(res, 400, {error: 'is a directory'})
			if (st.size > 10 * 1024 * 1024)
				return sendJson(res, 413, {error: 'file too large to preview (>10MB)'})
			const buf = await fs.readFile(abs)
			if (isProbablyBinary(buf)) {
				return sendJson(res, 200, {
					path: rel,
					binary: true,
					size: st.size,
					mtime: st.mtimeMs,
				})
			}
			const truncated = buf.length > MAX_FILE_BYTES
			const text = buf.subarray(0, MAX_FILE_BYTES).toString('utf-8')
			return sendJson(res, 200, {
				path: rel,
				content: text,
				size: st.size,
				mtime: st.mtimeMs,
				truncated,
			})
		} catch {
			return sendJson(res, 404, {error: 'file not found'})
		}
	}

	if (url.pathname === '/api/file' && method === 'POST') {
		let body: {path?: string; content?: string}
		try {
			body = JSON.parse(await readBody(req))
		} catch {
			return sendJson(res, 400, {error: 'invalid JSON body'})
		}
		if (!body.path) return sendJson(res, 400, {error: 'missing path'})
		const abs = resolveSafe(opts.rootDir, body.path)
		if (!abs) return sendJson(res, 403, {error: 'path escapes root'})
		const content = body.content ?? ''
		if (Buffer.byteLength(content, 'utf-8') > 5 * 1024 * 1024)
			return sendJson(res, 413, {error: 'content too large (>5MB)'})
		await fs.mkdir(path.dirname(abs), {recursive: true})
		// atomic write: tmp + rename
		const tmp = abs + `.td-code-tmp-${process.pid}`
		await fs.writeFile(tmp, content, 'utf-8')
		await fs.rename(tmp, abs)
		const st = await fs.stat(abs)
		return sendJson(res, 200, {ok: true, path: body.path, mtime: st.mtimeMs})
	}

	if (url.pathname === '/api/mkdir' && method === 'POST') {
		const body = JSON.parse(await readBody(req)).catch(() => null) as {
			path?: string
		} | null
		if (!body?.path) return sendJson(res, 400, {error: 'missing path'})
		const abs = resolveSafe(opts.rootDir, body.path)
		if (!abs) return sendJson(res, 403, {error: 'path escapes root'})
		await fs.mkdir(abs, {recursive: true})
		return sendJson(res, 200, {ok: true})
	}

	if (url.pathname === '/api/rename' && method === 'POST') {
		const body = JSON.parse(await readBody(req)).catch(() => null) as {
			from?: string
			to?: string
		} | null
		if (!body?.from || !body?.to)
			return sendJson(res, 400, {error: 'missing from/to'})
		const a = resolveSafe(opts.rootDir, body.from)
		const b = resolveSafe(opts.rootDir, body.to)
		if (!a || !b) return sendJson(res, 403, {error: 'path escapes root'})
		await fs.mkdir(path.dirname(b), {recursive: true})
		await fs.rename(a, b)
		return sendJson(res, 200, {ok: true})
	}

	if (
		url.pathname === '/api/remove' &&
		(method === 'POST' || method === 'DELETE')
	) {
		let target = url.searchParams.get('path') ?? ''
		if (method === 'POST') {
			try {
				const parsed = JSON.parse(await readBody(req)) as {path?: string}
				if (parsed?.path) target = parsed.path
			} catch {
				/* keep query param */
			}
		}
		if (!target) return sendJson(res, 400, {error: 'missing path'})
		const abs = resolveSafe(opts.rootDir, target)
		if (!abs) return sendJson(res, 403, {error: 'path escapes root'})
		if (path.resolve(abs) === path.resolve(opts.rootDir))
			return sendJson(res, 400, {error: 'refusing to delete root'})
		await fs.rm(abs, {recursive: true, force: true})
		return sendJson(res, 200, {ok: true})
	}

	if (url.pathname === '/api/search' && method === 'GET') {
		const q = (url.searchParams.get('q') ?? '').trim()
		if (!q || q.length < 2)
			return sendJson(res, 400, {error: 'query too short (min 2 chars)'})
		const relBase = url.searchParams.get('path') ?? ''
		const base = resolveSafe(opts.rootDir, relBase)
		if (!base) return sendJson(res, 403, {error: 'path escapes root'})
		const results: Array<{file: string; line: number; preview: string}> = []
		const skipDirs = new Set([
			'node_modules',
			'.git',
			'dist',
			'.hg',
			'__pycache__',
		])
		async function walk(dir: string) {
			if (results.length >= MAX_SEARCH_RESULTS) return
			let entries: import('node:fs').Dirent[]
			try {
				entries = await fs.readdir(dir, {withFileTypes: true})
			} catch {
				return
			}
			for (const e of entries) {
				if (results.length >= MAX_SEARCH_RESULTS) return
				if (e.name.startsWith('.') && e.name !== '.env') {
					if (skipDirs.has(e.name)) continue
				}
				if (skipDirs.has(e.name)) continue
				const full = path.join(dir, e.name)
				if (e.isDirectory()) {
					await walk(full)
				} else if (e.isFile()) {
					try {
						const st = await fs.stat(full)
						if (st.size > 512 * 1024) continue
						const text = await fs.readFile(full, 'utf-8')
						if (text.includes('\0')) continue
						const lines = text.split('\n')
						for (let i = 0; i < lines.length; i++) {
							const idx = lines[i].toLowerCase().indexOf(q.toLowerCase())
							if (idx !== -1) {
								results.push({
									file: path
										.relative(opts.rootDir, full)
										.split(path.sep)
										.join('/'),
									line: i + 1,
									preview: lines[i].slice(0, 240),
								})
								if (results.length >= MAX_SEARCH_RESULTS) return
								if (
									results.filter(
										r =>
											r.file ===
											path
												.relative(opts.rootDir, full)
												.split(path.sep)
												.join('/'),
									).length > 10
								)
									break
							}
						}
					} catch {
						/* unreadable -> skip */
					}
				}
			}
		}
		await walk(base)
		return sendJson(res, 200, {query: q, count: results.length, results})
	}

	if (url.pathname === '/api/terms' && method === 'GET') {
		if (!terms)
			return sendJson(res, 403, {error: 'terminal disabled (--no-terms)'})
		return sendJson(res, 200, {
			terms: terms.list(),
			ptyAvailable: terms.ptyAvailable,
		})
	}

	if (url.pathname === '/api/terms' && method === 'POST') {
		if (!terms)
			return sendJson(res, 403, {error: 'terminal disabled (--no-terms)'})
		let body: {cwd?: string; shell?: string; cols?: number; rows?: number}
		try {
			body = JSON.parse(await readBody(req))
		} catch {
			return sendJson(res, 400, {error: 'invalid JSON body'})
		}
		try {
			const info = terms.create(body ?? {})
			return sendJson(res, 201, info)
		} catch (err) {
			const status =
				typeof (err as {status?: unknown}).status === 'number'
					? ((err as {status: number}).status as number)
					: 400
			return sendJson(res, status, {
				error: err instanceof Error ? err.message : 'failed to create terminal',
			})
		}
	}

	if (url.pathname.startsWith('/api/terms/') && method === 'DELETE') {
		if (!terms)
			return sendJson(res, 403, {error: 'terminal disabled (--no-terms)'})
		const id = decodeURIComponent(url.pathname.slice('/api/terms/'.length))
		if (!id) return sendJson(res, 400, {error: 'missing session id'})
		if (!terms.remove(id)) return sendJson(res, 404, {error: 'unknown session'})
		return sendJson(res, 200, {ok: true})
	}

	return sendJson(res, 404, {error: 'unknown api route'})
}

async function serveStatic(
	_req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	distDir: string,
) {
	let pathname = decodeURIComponent(url.pathname)
	if (pathname === '/') pathname = '/index.html'
	// Never serve hidden files directly; SPA fallback handles the rest
	const filePath = path.join(distDir, pathname.replace(/^\/+/, ''))
	if (!filePath.startsWith(distDir)) {
		res.writeHead(403).end('forbidden')
		return
	}
	try {
		const st = await fs.stat(filePath)
		if (st.isDirectory()) {
			const html = await fs.readFile(path.join(distDir, 'index.html'))
			res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'})
			res.end(html)
			return
		}
		const data = await fs.readFile(filePath)
		res.writeHead(200, {'Content-Type': mimeLookup(filePath)})
		res.end(data)
	} catch {
		// SPA fallback
		try {
			const html = await fs.readFile(path.join(distDir, 'index.html'))
			res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'})
			res.end(html)
		} catch {
			res.writeHead(404).end('not found: run `bun run build` first')
		}
	}
}

function checkWsToken(req: IncomingMessage, token: string): boolean {
	try {
		const u = new URL(req.url ?? '/', 'http://x')
		const q = u.searchParams.get('token')
		const proto = (req.headers['sec-websocket-protocol'] ?? '') as string
		return q === token || proto.includes(token)
	} catch {
		return false
	}
}

export function lanIps(): string[] {
	const out: string[] = []
	for (const nets of Object.values(os.networkInterfaces())) {
		for (const n of nets ?? []) {
			if (n.family === 'IPv4' && !n.internal) out.push(n.address)
		}
	}
	return out
}

export async function startServer(opts: ServeOptions): Promise<void> {
	const distDir = path.resolve(__dirname, '../dist')
	const terms = opts.noTerms ? null : new TermManager(opts.rootDir)
	const server = createServer(async (req, res) => {
		try {
			const host = req.headers.host ?? `localhost:${opts.port}`
			const url = new URL(req.url ?? '/', `http://${host}`)
			if (url.pathname.startsWith('/api/')) {
				await handleApi(req, res, url, opts, terms)
				return
			}
			if (url.pathname === '/ws' || url.pathname === '/term') {
				res.writeHead(426).end('use websocket')
				return
			}
			await serveStatic(req, res, url, distDir)
		} catch (err) {
			console.error('[td-code]', err)
			if (!res.headersSent) sendJson(res, 500, {error: 'internal error'})
			else res.end()
		}
	})

	// NOTE: both sockets share one HTTP server via `noServer` + manual routing.
	// (Two `new WebSocketServer({server, path})` instances do NOT work: the
	// first upgrade listener aborts non-matching paths with 400 before the
	// second one runs. This is the documented `ws` sharing pattern.)
	const wss = new WebSocketServer({noServer: true})
	const termWss = new WebSocketServer({noServer: true})
	const clients = new Set<WebSocket>()
	wss.on('connection', (ws, req) => {
		if (opts.authToken && !checkWsToken(req, opts.authToken)) {
			ws.close(4401, 'unauthorized')
			return
		}
		clients.add(ws)
		ws.on('close', () => clients.delete(ws))
		ws.send(JSON.stringify({type: 'hello', root: opts.rootDir}))
	})

	// WebSocket for interactive terminals
	termWss.on('connection', (ws, req) => {
		if (!terms) {
			ws.close(4403, 'terminal disabled')
			return
		}
		if (opts.authToken && !checkWsToken(req, opts.authToken)) {
			ws.close(4401, 'unauthorized')
			return
		}
		let id = ''
		try {
			id = new URL(req.url ?? '/', 'http://x').searchParams.get('id') ?? ''
		} catch {
			/* ignore */
		}
		if (!id) {
			ws.close(4404, 'missing session id')
			return
		}
		terms.attach(ws, id)
	})

	server.on('upgrade', (req, socket, head) => {
		let pathname = '/'
		try {
			pathname = new URL(req.url ?? '/', 'http://x').pathname
		} catch {
			/* ignore */
		}
		if (pathname === '/ws') {
			wss.handleUpgrade(req, socket, head, ws =>
				wss.emit('connection', ws, req),
			)
		} else if (pathname === '/term') {
			termWss.handleUpgrade(req, socket, head, ws =>
				termWss.emit('connection', ws, req),
			)
		} else {
			socket.destroy()
		}
	})

	let watcher: FSWatcher | null = null
	if (!opts.noWatch) {
		try {
			watcher = watch(opts.rootDir, {
				ignored: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
				ignoreInitial: true,
			})
			const broadcast = (type: string, p: string) => {
				const rel = path.relative(opts.rootDir, p).split(path.sep).join('/')
				const msg = JSON.stringify({type, path: rel})
				for (const c of clients) {
					if (c.readyState === 1) c.send(msg)
				}
			}
			watcher.on('add', p => broadcast('add', p))
			watcher.on('change', p => broadcast('change', p))
			watcher.on('unlink', p => broadcast('unlink', p))
			watcher.on('addDir', p => broadcast('addDir', p))
			watcher.on('unlinkDir', p => broadcast('unlinkDir', p))
		} catch (err) {
			console.warn('[td-code] watcher disabled:', err)
		}
	}

	await new Promise<void>((resolve, reject) => {
		server.on('error', reject)
		server.listen(opts.port, opts.host, () => resolve())
	})

	const ips = opts.host === '0.0.0.0' ? lanIps() : []
	console.log(`\n  td-code v${opts.version} serving ${opts.rootDir}`)
	console.log(
		`  Local:  http://localhost:${opts.port}/` +
			(opts.authToken ? `?token=${opts.authToken}` : ''),
	)
	for (const ip of ips) {
		console.log(
			`  LAN:    http://${ip}:${opts.port}/` +
				(opts.authToken ? `?token=${opts.authToken}` : ''),
		)
	}
	if (opts.authToken)
		console.log(
			'  Auth token enabled. Use ?token=... or --no-auth on trusted networks.',
		)
	else console.log('  No auth (--no-auth). Only use on trusted networks.')
	console.log(`  Watcher: ${watcher ? 'on' : 'off'}`)
	console.log(
		`  Terminal: ${terms ? `on${terms.ptyAvailable ? ' (pty via script)' : ' (pipes, no pty)'}` : 'off (--no-terms)'}\n`,
	)

	const shutdown = () => {
		watcher?.close().catch(() => {})
		terms?.killAll()
		wss.close()
		termWss.close()
		server.close(() => process.exit(0))
		setTimeout(() => process.exit(0), 1500).unref()
	}
	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)
}
