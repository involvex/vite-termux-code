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
import {DapManager} from './dap.ts'
import {
	GitError,
	gitBranches,
	gitCheckout,
	gitCommit,
	gitDiff,
	gitLog,
	gitStage,
	gitStatus,
	gitUnstage,
} from './git.ts'
import {LspManager} from './lsp.ts'
import {lookup as mimeLookup} from './mime.ts'
import {findRootForPath, resolveSafe} from './paths.ts'
import {listTasks, resolveTask} from './tasks.ts'
import {TermManager} from './terminal.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface ServeOptions {
	rootDirs: string[]
	port: number
	host: string
	authToken: string | null
	/** Short code accepted in addition to the token (pairing on a phone). */
	pairingCode?: string | null
	noWatch: boolean
	noTerms: boolean
	version: string
}

export interface Workspace {
	rootDir: string
	name: string
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
	lsp: LspManager,
	dap: DapManager,
) {
	const method = req.method?.toUpperCase() ?? 'GET'

	// GET /api/health (no auth)
	if (url.pathname === '/api/health') {
		return sendJson(res, 200, {
			ok: true,
			roots: opts.rootDirs,
			version: opts.version,
			time: Date.now(),
		})
	}

	// GET /api/workspaces - list all workspaces
	if (url.pathname === '/api/workspaces' && method === 'GET') {
		return sendJson(res, 200, {
			workspaces: opts.rootDirs.map((rootDir, index) => ({
				rootDir,
				name: path.basename(rootDir) || `Workspace ${index + 1}`,
				index,
			})),
		})
	}

	// POST /api/workspaces - add a new workspace
	if (url.pathname === '/api/workspaces' && method === 'POST') {
		let body: {path?: string; name?: string}
		try {
			body = JSON.parse(await readBody(req))
		} catch {
			return sendJson(res, 400, {error: 'invalid JSON body'})
		}
		if (!body.path) return sendJson(res, 400, {error: 'missing path'})
		const absPath = path.resolve(body.path)
		try {
			const st = await fs.stat(absPath)
			if (!st.isDirectory())
				return sendJson(res, 400, {error: 'not a directory'})
		} catch {
			return sendJson(res, 404, {error: 'directory not found'})
		}
		// Check if already exists
		if (opts.rootDirs.some(r => path.resolve(r) === absPath)) {
			return sendJson(res, 400, {error: 'workspace already exists'})
		}
		opts.rootDirs.push(absPath)
		// TODO: Add watcher for new root
		return sendJson(res, 201, {ok: true, rootDir: absPath})
	}

	// DELETE /api/workspaces/:index - remove a workspace
	if (url.pathname.startsWith('/api/workspaces/') && method === 'DELETE') {
		const indexStr = decodeURIComponent(
			url.pathname.slice('/api/workspaces/'.length),
		)
		const index = parseInt(indexStr, 10)
		if (isNaN(index) || index < 0 || index >= opts.rootDirs.length) {
			return sendJson(res, 404, {error: 'workspace not found'})
		}
		if (opts.rootDirs.length === 1) {
			return sendJson(res, 400, {error: 'cannot remove last workspace'})
		}
		opts.rootDirs.splice(index, 1)
		// TODO: Remove watcher for removed root
		return sendJson(res, 200, {ok: true})
	}

	// PATCH /api/workspaces/:index - update workspace (e.g., rename)
	if (url.pathname.startsWith('/api/workspaces/') && method === 'PATCH') {
		const indexStr = decodeURIComponent(
			url.pathname.slice('/api/workspaces/'.length),
		)
		const index = parseInt(indexStr, 10)
		if (isNaN(index) || index < 0 || index >= opts.rootDirs.length) {
			return sendJson(res, 404, {error: 'workspace not found'})
		}
		// Parse body to validate JSON (name is stored client-side in localStorage)
		try {
			JSON.parse(await readBody(req))
		} catch {
			return sendJson(res, 400, {error: 'invalid JSON body'})
		}
		return sendJson(res, 200, {ok: true})
	}

	// --- auth check for everything else under /api ---
	if (opts.authToken) {
		const q = url.searchParams.get('token') ?? url.searchParams.get('code')
		const h =
			req.headers['authorization']?.replace(/^Bearer\s+/i, '') ??
			(req.headers['x-auth-token'] as string | undefined)
		if (!isAuthorized(opts, q, h)) {
			return sendJson(res, 401, {
				error: 'unauthorized: bad or missing token',
				// tells the UI to show the pairing-code prompt
				pairing: Boolean(opts.pairingCode),
			})
		}
	}

	if (url.pathname === '/api/auth/check' && method === 'GET') {
		// Sits after the auth gate on purpose: reaching this handler means the
		// presented token/pairing code was accepted. Used by the pairing screen.
		return sendJson(res, 200, {ok: true})
	}

	if (url.pathname === '/api/files' && method === 'GET') {
		const rel = url.searchParams.get('path') ?? ''
		const showHidden = url.searchParams.get('hidden') === '1'
		const abs = resolveSafe(opts.rootDirs, rel)
		if (!abs) return sendJson(res, 403, {error: 'path escapes root'})
		try {
			const st = await fs.stat(abs)
			if (!st.isDirectory())
				return sendJson(res, 400, {error: 'not a directory'})
		} catch {
			return sendJson(res, 404, {error: 'directory not found'})
		}
		// Find which root this path belongs to for listDir
		const root = findRootForPath(opts.rootDirs, abs) ?? opts.rootDirs[0]
		let items = await listDir(abs, root)
		if (!showHidden) items = items.filter(i => !i.name.startsWith('.'))
		return sendJson(res, 200, {path: rel, items})
	}

	if (url.pathname === '/api/file' && method === 'GET') {
		const rel = url.searchParams.get('path') ?? ''
		if (!rel) return sendJson(res, 400, {error: 'missing ?path='})
		const abs = resolveSafe(opts.rootDirs, rel)
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
		const abs = resolveSafe(opts.rootDirs, body.path)
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
		const abs = resolveSafe(opts.rootDirs, body.path)
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
		const a = resolveSafe(opts.rootDirs, body.from)
		const b = resolveSafe(opts.rootDirs, body.to)
		if (!a || !b) return sendJson(res, 403, {error: 'path escapes root'})
		// Ensure both paths are under the same root
		const rootA = findRootForPath(opts.rootDirs, a)
		const rootB = findRootForPath(opts.rootDirs, b)
		if (rootA !== rootB)
			return sendJson(res, 400, {error: 'cannot rename across workspaces'})
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
		const abs = resolveSafe(opts.rootDirs, target)
		if (!abs) return sendJson(res, 403, {error: 'path escapes root'})
		// Prevent removing a root directory
		for (const root of opts.rootDirs) {
			if (path.resolve(abs) === path.resolve(root))
				return sendJson(res, 400, {error: 'refusing to delete workspace root'})
		}
		await fs.rm(abs, {recursive: true, force: true})
		return sendJson(res, 200, {ok: true})
	}

	if (url.pathname === '/api/search' && method === 'GET') {
		const q = (url.searchParams.get('q') ?? '').trim()
		if (!q || q.length < 2)
			return sendJson(res, 400, {error: 'query too short (min 2 chars)'})
		const relBase = url.searchParams.get('path') ?? ''
		// If path is specified, search only in that workspace; otherwise search all
		let roots: string[]
		if (relBase) {
			const base = resolveSafe(opts.rootDirs, relBase)
			if (!base) return sendJson(res, 403, {error: 'path escapes root'})
			roots = [findRootForPath(opts.rootDirs, base) ?? opts.rootDirs[0]]
		} else {
			roots = opts.rootDirs
		}
		const results: Array<{file: string; line: number; preview: string}> = []
		const skipDirs = new Set([
			'node_modules',
			'.git',
			'dist',
			'.hg',
			'__pycache__',
		])
		async function walk(dir: string, root: string) {
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
					await walk(full, root)
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
									file: path.relative(root, full).split(path.sep).join('/'),
									line: i + 1,
									preview: lines[i].slice(0, 240),
								})
								if (results.length >= MAX_SEARCH_RESULTS) return
								if (
									results.filter(
										r =>
											r.file ===
											path.relative(root, full).split(path.sep).join('/'),
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
		for (const root of roots) {
			await walk(root, root)
			if (results.length >= MAX_SEARCH_RESULTS) break
		}
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

	if (url.pathname === '/api/git/status' && method === 'GET') {
		const workspaceRoot = url.searchParams.get('workspace')
			? opts.rootDirs[parseInt(url.searchParams.get('workspace')!, 10)]
			: opts.rootDirs[0]
		try {
			return sendJson(res, 200, await gitStatus(workspaceRoot))
		} catch (err) {
			// friendly empty state for the Source Control tab
			if (
				err instanceof GitError &&
				err.status === 404 &&
				err.message === 'not a git repository'
			) {
				return sendJson(res, 200, {repo: false})
			}
			return gitErr(res, err)
		}
	}

	if (url.pathname === '/api/git/log' && method === 'GET') {
		const workspaceRoot = url.searchParams.get('workspace')
			? opts.rootDirs[parseInt(url.searchParams.get('workspace')!, 10)]
			: opts.rootDirs[0]
		try {
			const limit = Number(url.searchParams.get('limit') ?? 20)
			return sendJson(res, 200, {commits: await gitLog(workspaceRoot, limit)})
		} catch (err) {
			return gitErr(res, err)
		}
	}

	if (url.pathname === '/api/git/diff' && method === 'GET') {
		const workspaceRoot = url.searchParams.get('workspace')
			? opts.rootDirs[parseInt(url.searchParams.get('workspace')!, 10)]
			: opts.rootDirs[0]
		try {
			const file = url.searchParams.get('file') ?? ''
			const staged = url.searchParams.get('staged') === '1'
			if (!file) return sendJson(res, 400, {error: 'missing ?file='})
			return sendJson(res, 200, await gitDiff(workspaceRoot, file, staged))
		} catch (err) {
			return gitErr(res, err)
		}
	}

	if (url.pathname === '/api/git/stage' && method === 'POST') {
		const workspaceRoot = url.searchParams.get('workspace')
			? opts.rootDirs[parseInt(url.searchParams.get('workspace')!, 10)]
			: opts.rootDirs[0]
		try {
			const body = JSON.parse(await readBody(req)) as {files?: string[]}
			await gitStage(workspaceRoot, body.files ?? [])
			return sendJson(res, 200, {ok: true})
		} catch (err) {
			return gitErr(res, err)
		}
	}

	if (url.pathname === '/api/git/unstage' && method === 'POST') {
		const workspaceRoot = url.searchParams.get('workspace')
			? opts.rootDirs[parseInt(url.searchParams.get('workspace')!, 10)]
			: opts.rootDirs[0]
		try {
			const body = JSON.parse(await readBody(req)) as {files?: string[]}
			await gitUnstage(workspaceRoot, body.files ?? [])
			return sendJson(res, 200, {ok: true})
		} catch (err) {
			return gitErr(res, err)
		}
	}

	if (url.pathname === '/api/git/commit' && method === 'POST') {
		const workspaceRoot = url.searchParams.get('workspace')
			? opts.rootDirs[parseInt(url.searchParams.get('workspace')!, 10)]
			: opts.rootDirs[0]
		try {
			const body = JSON.parse(await readBody(req)) as {
				message?: string
				name?: string
				email?: string
			}
			return sendJson(
				res,
				200,
				await gitCommit(
					workspaceRoot,
					body.message ?? '',
					body.name,
					body.email,
				),
			)
		} catch (err) {
			return gitErr(res, err)
		}
	}

	if (url.pathname === '/api/git/branches' && method === 'GET') {
		const workspaceRoot = url.searchParams.get('workspace')
			? opts.rootDirs[parseInt(url.searchParams.get('workspace')!, 10)]
			: opts.rootDirs[0]
		try {
			return sendJson(res, 200, {branches: await gitBranches(workspaceRoot)})
		} catch (err) {
			return gitErr(res, err)
		}
	}

	if (url.pathname === '/api/git/checkout' && method === 'POST') {
		const workspaceRoot = url.searchParams.get('workspace')
			? opts.rootDirs[parseInt(url.searchParams.get('workspace')!, 10)]
			: opts.rootDirs[0]
		try {
			const body = JSON.parse(await readBody(req)) as {ref?: string}
			await gitCheckout(workspaceRoot, body.ref ?? '')
			return sendJson(res, 200, {ok: true})
		} catch (err) {
			return gitErr(res, err)
		}
	}

	if (url.pathname === '/api/tasks' && method === 'GET') {
		const workspaceRoot = url.searchParams.get('workspace')
			? opts.rootDirs[parseInt(url.searchParams.get('workspace')!, 10)]
			: opts.rootDirs[0]
		try {
			return sendJson(res, 200, await listTasks(workspaceRoot))
		} catch (err) {
			return sendJson(res, 500, {
				error: err instanceof Error ? err.message : 'failed to list tasks',
			})
		}
	}

	if (url.pathname === '/api/tasks/run' && method === 'POST') {
		if (!terms)
			return sendJson(res, 403, {error: 'terminal disabled (--no-terms)'})
		let body: {id?: string}
		try {
			body = JSON.parse(await readBody(req))
		} catch {
			return sendJson(res, 400, {error: 'invalid JSON body'})
		}
		if (!body.id) return sendJson(res, 400, {error: 'missing id'})
		const workspaceRoot = url.searchParams.get('workspace')
			? opts.rootDirs[parseInt(url.searchParams.get('workspace')!, 10)]
			: opts.rootDirs[0]
		const task = await resolveTask(workspaceRoot, body.id)
		if (!task) return sendJson(res, 404, {error: 'unknown task'})
		if (task.id.startsWith('missing:'))
			return sendJson(res, 400, {error: 'no bun/npm on PATH'})
		try {
			const info = terms.create({cwd: workspaceRoot})
			// Small delay lets the shell print its prompt first so the
			// command doesn't get lost in spawn races on slow devices.
			setTimeout(() => terms.input(info.id, `${task.command}\n`), 250)
			return sendJson(res, 201, {termId: info.id, task})
		} catch (err) {
			const status =
				typeof (err as {status?: unknown}).status === 'number'
					? ((err as {status: number}).status as number)
					: 400
			return sendJson(res, status, {
				error: err instanceof Error ? err.message : 'failed to run task',
			})
		}
	}

	if (url.pathname === '/api/lsp/status' && method === 'GET') {
		const workspaceRoot = url.searchParams.get('workspace')
			? opts.rootDirs[parseInt(url.searchParams.get('workspace')!, 10)]
			: opts.rootDirs[0]
		return sendJson(res, 200, {langs: lsp.status(workspaceRoot)})
	}

	if (url.pathname === '/api/lsp/ensure' && method === 'POST') {
		let body: {lang?: string}
		try {
			body = JSON.parse(await readBody(req))
		} catch {
			return sendJson(res, 400, {error: 'invalid JSON body'})
		}
		const lang = body.lang ?? 'typescript'
		const workspaceRoot = url.searchParams.get('workspace')
			? opts.rootDirs[parseInt(url.searchParams.get('workspace')!, 10)]
			: opts.rootDirs[0]
		try {
			await lsp.ensure(lang, workspaceRoot)
			return sendJson(res, 200, {ok: true, lang})
		} catch (err) {
			const status =
				typeof (err as {status?: unknown}).status === 'number'
					? ((err as {status: number}).status as number)
					: 400
			return sendJson(res, status, {
				error: err instanceof Error ? err.message : 'failed to start LSP',
			})
		}
	}

	if (url.pathname === '/api/dap/status' && method === 'GET') {
		const workspaceRoot = url.searchParams.get('workspace')
			? opts.rootDirs[parseInt(url.searchParams.get('workspace')!, 10)]
			: opts.rootDirs[0]
		return sendJson(res, 200, dap.status(workspaceRoot))
	}

	if (url.pathname === '/api/dap/start' && method === 'POST') {
		let body: {program?: string; stopOnEntry?: boolean}
		try {
			body = JSON.parse(await readBody(req))
		} catch {
			return sendJson(res, 400, {error: 'invalid JSON body'})
		}
		if (!body.program) return sendJson(res, 400, {error: 'missing program'})
		const workspaceRoot = url.searchParams.get('workspace')
			? opts.rootDirs[parseInt(url.searchParams.get('workspace')!, 10)]
			: opts.rootDirs[0]
		try {
			return sendJson(
				res,
				200,
				await dap.start(body.program, {
					stopOnEntry: body.stopOnEntry,
					rootDir: workspaceRoot,
				}),
			)
		} catch (err) {
			const status =
				typeof (err as {status?: unknown}).status === 'number'
					? ((err as {status: number}).status as number)
					: 400
			return sendJson(res, status, {
				error:
					err instanceof Error ? err.message : 'failed to start debug session',
			})
		}
	}

	if (url.pathname === '/api/dap/stop' && method === 'POST') {
		await dap.stop()
		return sendJson(res, 200, {ok: true})
	}

	return sendJson(res, 404, {error: 'unknown api route'})
}

function gitErr(res: ServerResponse, err: unknown) {
	if (err instanceof GitError)
		return sendJson(res, err.status, {error: err.message})
	if (err instanceof SyntaxError)
		return sendJson(res, 400, {error: 'invalid JSON body'})
	return sendJson(res, 500, {error: 'internal error'})
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

/**
 * Accept either the full auth token or the short pairing code.
 * `presented` values may be undefined (no query/header at all).
 */
function isAuthorized(
	opts: ServeOptions,
	queryValue: string | null | undefined,
	headerValue: string | null | undefined,
): boolean {
	if (!opts.authToken) return true
	const accepted = [opts.authToken]
	if (opts.pairingCode) accepted.push(opts.pairingCode)
	for (const v of [queryValue, headerValue]) {
		if (v && accepted.includes(v)) return true
	}
	return false
}

function checkWsToken(req: IncomingMessage, opts: ServeOptions): boolean {
	try {
		const u = new URL(req.url ?? '/', 'http://x')
		const q = u.searchParams.get('token') ?? u.searchParams.get('code')
		const proto = (req.headers['sec-websocket-protocol'] ?? '') as string
		// The protocol header carries the token because browsers cannot set
		// headers on WebSockets; a bare pairing code may be passed the same way.
		const header =
			opts.pairingCode && proto.includes(opts.pairingCode)
				? opts.pairingCode
				: undefined
		return isAuthorized(opts, q, header)
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
	const terms = opts.noTerms ? null : new TermManager(opts.rootDirs)
	const lsp = new LspManager(opts.rootDirs)
	const dap = new DapManager(opts.rootDirs)
	const server = createServer(async (req, res) => {
		try {
			const host = req.headers.host ?? `localhost:${opts.port}`
			const url = new URL(req.url ?? '/', `http://${host}`)
			if (url.pathname.startsWith('/api/')) {
				await handleApi(req, res, url, opts, terms, lsp, dap)
				return
			}
			if (
				url.pathname === '/ws' ||
				url.pathname === '/term' ||
				url.pathname === '/lsp' ||
				url.pathname === '/dap'
			) {
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
	const lspWss = new WebSocketServer({noServer: true})
	const dapWss = new WebSocketServer({noServer: true})
	const clients = new Set<WebSocket>()
	wss.on('connection', (ws, req) => {
		if (opts.authToken && !checkWsToken(req, opts)) {
			ws.close(4401, 'unauthorized')
			return
		}
		clients.add(ws)
		ws.on('close', () => clients.delete(ws))
		ws.send(JSON.stringify({type: 'hello', roots: opts.rootDirs}))
	})

	// WebSocket for interactive terminals
	termWss.on('connection', (ws, req) => {
		if (!terms) {
			ws.close(4403, 'terminal disabled')
			return
		}
		if (opts.authToken && !checkWsToken(req, opts)) {
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

	// WebSocket for language servers
	lspWss.on('connection', (ws, req) => {
		if (opts.authToken && !checkWsToken(req, opts)) {
			ws.close(4401, 'unauthorized')
			return
		}
		let lang = 'typescript'
		try {
			lang =
				new URL(req.url ?? '/', 'http://x').searchParams.get('lang') ??
				'typescript'
		} catch {
			/* ignore */
		}
		lsp.attach(ws, lang)
	})

	// WebSocket for debug sessions (single active session, v1)
	dapWss.on('connection', (ws, req) => {
		if (opts.authToken && !checkWsToken(req, opts)) {
			ws.close(4401, 'unauthorized')
			return
		}
		dap.attach(ws)
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
		} else if (pathname === '/lsp') {
			lspWss.handleUpgrade(req, socket, head, ws =>
				lspWss.emit('connection', ws, req),
			)
		} else if (pathname === '/dap') {
			dapWss.handleUpgrade(req, socket, head, ws =>
				dapWss.emit('connection', ws, req),
			)
		} else {
			socket.destroy()
		}
	})

	let watcher: FSWatcher | null = null
	if (!opts.noWatch) {
		try {
			watcher = watch(opts.rootDirs, {
				ignored: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
				ignoreInitial: true,
			})
			const broadcast = (type: string, p: string) => {
				const root = findRootForPath(opts.rootDirs, p)
				if (!root) return
				const rel = path.relative(root, p).split(path.sep).join('/')
				const msg = JSON.stringify({type, path: rel, root})
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
	console.log(
		`\n  td-code v${opts.version} serving ${opts.rootDirs.join(', ')}`,
	)
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
	if (opts.pairingCode) {
		console.log(
			`  Pairing code: ${opts.pairingCode}  (open the editor and type it when asked)`,
		)
	}
	if (opts.authToken)
		console.log(
			'  Auth token enabled. Use ?token=... or --no-auth on trusted networks.',
		)
	else
		console.log(
			'  No auth (--no-auth or "auth": false). Only use on trusted networks.',
		)
	console.log(`  Watcher: ${watcher ? 'on' : 'off'}`)
	console.log(
		`  Terminal: ${terms ? `on${terms.ptyAvailable ? ' (pty via script)' : ' (pipes, no pty)'}` : 'off (--no-terms)'}\n`,
	)

	const shutdown = () => {
		watcher?.close().catch(() => {})
		terms?.killAll()
		lsp.shutdown()
		dap.shutdown()
		wss.close()
		termWss.close()
		lspWss.close()
		dapWss.close()
		server.close(() => process.exit(0))
		setTimeout(() => process.exit(0), 1500).unref()
	}
	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)
}
