export interface FileItem {
	name: string
	path: string
	type: 'file' | 'dir'
	size: number
	mtime: number
}

export interface FileContent {
	path: string
	content?: string
	binary?: boolean
	size: number
	mtime: number
	truncated?: boolean
}

export interface SearchHit {
	file: string
	line: number
	preview: string
}

export interface TermSession {
	id: string
	cwd: string
	shell: string
	pty: boolean
	cols: number
	rows: number
	alive: boolean
	exitCode: number | null
	createdAt: number
}

export interface GitChange {
	path: string
	kind: string
}

export interface GitStatus {
	repo: boolean
	branch?: string | null
	detached?: boolean
	ahead?: number
	behind?: number
	staged?: GitChange[]
	unstaged?: GitChange[]
	untracked?: string[]
}

export interface GitCommit {
	hash: string
	short: string
	subject: string
	author: string
	date: string
}

export interface GitBranch {
	name: string
	current: boolean
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

export interface TaskDef {
	id: string
	label: string
	kind: 'bun' | 'npm' | 'make'
	script: string
	command: string
	detail?: string
}

export interface Workspace {
	rootDir: string
	name: string
	index: number
}

/**
 * Pairing screen state. When the server answers 401 with `pairing: true`,
 * App renders the code prompt instead of the IDE.
 */
let unauthorizedHandler: (() => void) | null = null

export function onUnauthorized(fn: (() => void) | null): void {
	unauthorizedHandler = fn
}

function notifyUnauthorized() {
	try {
		unauthorizedHandler?.()
	} catch {
		/* ignore */
	}
}

function getToken(): string {
	const url = new URL(window.location.href)
	// ?code= is the pairing-code entry point (short, typeable on a phone);
	// it is stored exactly like a token because the server accepts either.
	const q = url.searchParams.get('token') ?? url.searchParams.get('code')
	if (q) {
		sessionStorage.setItem('td-code-token', q)
		// Don't leave the credential in the address bar / history / referrers.
		url.searchParams.delete('token')
		url.searchParams.delete('code')
		window.history.replaceState({}, '', url.toString())
		return q
	}
	return sessionStorage.getItem('td-code-token') ?? ''
}

/** Store a pairing code as the session credential. */
export function submitPairingCode(code: string): boolean {
	const clean = code.trim()
	if (!clean) return false
	sessionStorage.setItem('td-code-token', clean)
	notifyUnauthorized()
	return true
}

export function clearPairingCode(): void {
	sessionStorage.removeItem('td-code-token')
}

export function authQuery(): string {
	const t = getToken()
	return t ? `token=${encodeURIComponent(t)}` : ''
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
	const t = getToken()
	const sep = path.includes('?') ? '&' : '?'
	const url = t ? `${path}${sep}token=${encodeURIComponent(t)}` : path
	const res = await fetch(url, {
		...init,
		headers: {
			'Content-Type': 'application/json',
			...(t ? {'x-auth-token': t} : {}),
			...init?.headers,
		},
	})
	if (res.status === 401) {
		// Stale credential, or we still need to pair.
		let pairing = false
		try {
			pairing = Boolean(
				((await res.clone().json()) as {pairing?: boolean}).pairing,
			)
		} catch {
			/* ignore */
		}
		if (pairing || t) notifyUnauthorized()
	}
	if (!res.ok) {
		let msg = res.statusText
		try {
			const j = (await res.json()) as {error?: string}
			if (j.error) msg = j.error
		} catch {
			/* ignore */
		}
		throw new Error(`${res.status}: ${msg}`)
	}
	return (await res.json()) as T
}

function withWorkspace(path: string, workspace?: number): string {
	if (workspace !== undefined) {
		const sep = path.includes('?') ? '&' : '?'
		return `${path}${sep}workspace=${workspace}`
	}
	return path
}

export const api = {
	/** Store/clear the pairing code (used by PairingPrompt). */
	setPairingCode: submitPairingCode,
	clearPairingCode,
	health: () =>
		req<{ok: boolean; roots: string[]; version: string}>('/api/health'),
	/**
	 * Authenticated round-trip used to verify a pairing code. Unlike /api/health
	 * (which is deliberately public) this 401s unless the credential is good.
	 */
	authCheck: () => req<{ok: boolean}>('/api/auth/check'),
	workspaces: () => req<{workspaces: Workspace[]}>('/api/workspaces'),
	addWorkspace: (rootDir: string, name?: string) =>
		req<{ok: boolean; rootDir: string}>('/api/workspaces', {
			method: 'POST',
			body: JSON.stringify({path: rootDir, name}),
		}),
	removeWorkspace: (index: number) =>
		req<{ok: boolean}>(`/api/workspaces/${index}`, {
			method: 'DELETE',
		}),
	updateWorkspace: (index: number, data: {name?: string}) =>
		req<{ok: boolean}>(`/api/workspaces/${index}`, {
			method: 'PATCH',
			body: JSON.stringify(data),
		}),
	list: (dirPath = '', hidden = false, workspace?: number) =>
		req<{path: string; items: FileItem[]}>(
			withWorkspace(
				`/api/files?path=${encodeURIComponent(dirPath)}&hidden=${hidden ? '1' : '0'}`,
				workspace,
			),
		),
	read: (filePath: string, workspace?: number) =>
		req<FileContent>(
			withWorkspace(
				`/api/file?path=${encodeURIComponent(filePath)}`,
				workspace,
			),
		),
	save: (filePath: string, content: string, workspace?: number) =>
		req<{ok: boolean; mtime: number}>(withWorkspace('/api/file', workspace), {
			method: 'POST',
			body: JSON.stringify({path: filePath, content}),
		}),
	mkdir: (dirPath: string, workspace?: number) =>
		req<{ok: boolean}>(withWorkspace('/api/mkdir', workspace), {
			method: 'POST',
			body: JSON.stringify({path: dirPath}),
		}),
	rename: (from: string, to: string, workspace?: number) =>
		req<{ok: boolean}>(withWorkspace('/api/rename', workspace), {
			method: 'POST',
			body: JSON.stringify({from, to}),
		}),
	remove: (target: string, workspace?: number) =>
		req<{ok: boolean}>(withWorkspace('/api/remove', workspace), {
			method: 'POST',
			body: JSON.stringify({path: target}),
		}),
	search: (q: string, base = '', workspace?: number) =>
		req<{query: string; count: number; results: SearchHit[]}>(
			withWorkspace(
				`/api/search?q=${encodeURIComponent(q)}&path=${encodeURIComponent(base)}`,
				workspace,
			),
		),
	terms: () => req<{terms: TermSession[]; ptyAvailable: boolean}>('/api/terms'),
	createTerm: (
		opts: {cwd?: string; shell?: string; cols?: number; rows?: number} = {},
	) =>
		req<TermSession>('/api/terms', {
			method: 'POST',
			body: JSON.stringify(opts),
		}),
	killTerm: (id: string) =>
		req<{ok: boolean}>(`/api/terms/${encodeURIComponent(id)}`, {
			method: 'DELETE',
		}),
	gitStatus: (workspace?: number) =>
		req<GitStatus>(withWorkspace('/api/git/status', workspace)),
	gitLog: (limit = 15, workspace?: number) =>
		req<{commits: GitCommit[]}>(
			withWorkspace(`/api/git/log?limit=${limit}`, workspace),
		),
	gitDiff: (file: string, staged: boolean, workspace?: number) =>
		req<{diff: string; truncated: boolean}>(
			withWorkspace(
				`/api/git/diff?file=${encodeURIComponent(file)}&staged=${staged ? '1' : '0'}`,
				workspace,
			),
		),
	gitStage: (files: string[], workspace?: number) =>
		req<{ok: boolean}>(withWorkspace('/api/git/stage', workspace), {
			method: 'POST',
			body: JSON.stringify({files}),
		}),
	gitUnstage: (files: string[], workspace?: number) =>
		req<{ok: boolean}>(withWorkspace('/api/git/unstage', workspace), {
			method: 'POST',
			body: JSON.stringify({files}),
		}),
	gitCommit: (
		message: string,
		name?: string,
		email?: string,
		workspace?: number,
	) =>
		req<{hash: string}>(withWorkspace('/api/git/commit', workspace), {
			method: 'POST',
			body: JSON.stringify({message, name, email}),
		}),
	gitBranches: (workspace?: number) =>
		req<{branches: GitBranch[]}>(withWorkspace('/api/git/branches', workspace)),
	gitCheckout: (ref: string, workspace?: number) =>
		req<{ok: boolean}>(withWorkspace('/api/git/checkout', workspace), {
			method: 'POST',
			body: JSON.stringify({ref}),
		}),
	tasks: (workspace?: number) =>
		req<{
			tasks: TaskDef[]
			runners: {bun: string | null; npm: string | null; make: string | null}
		}>(withWorkspace('/api/tasks', workspace)),
	runTask: (id: string, workspace?: number) =>
		req<{termId: string; task: TaskDef}>(
			withWorkspace('/api/tasks/run', workspace),
			{
				method: 'POST',
				body: JSON.stringify({id}),
			},
		),
	lspStatus: (workspace?: number) =>
		req<{
			langs: {
				lang: string
				running: boolean
				error?: string
				rootDir?: string
			}[]
		}>(withWorkspace('/api/lsp/status', workspace)),
	dapStatus: (workspace?: number) =>
		req<DapState>(withWorkspace('/api/dap/status', workspace)),
	dapStart: (program: string, stopOnEntry = false, workspace?: number) =>
		req<DapState>(withWorkspace('/api/dap/start', workspace), {
			method: 'POST',
			body: JSON.stringify({program, stopOnEntry}),
		}),
	dapStop: (workspace?: number) =>
		req<{ok: boolean}>(withWorkspace('/api/dap/stop', workspace), {
			method: 'POST',
		}),
	lspEnsure: (lang: string, workspace?: number) =>
		req<{ok: boolean; lang: string}>(
			withWorkspace('/api/lsp/ensure', workspace),
			{
				method: 'POST',
				body: JSON.stringify({lang}),
			},
		),
}

function wsBase(): string {
	const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
	return `${proto}://${window.location.host}`
}

function withToken(url: string): string {
	const t = getToken()
	return t ? `${url}?token=${encodeURIComponent(t)}` : url
}

export function wsUrl(): string {
	return withToken(`${wsBase()}/ws`)
}

export function termWsUrl(id: string): string {
	const t = getToken()
	const q = `id=${encodeURIComponent(id)}${t ? `&token=${encodeURIComponent(t)}` : ''}`
	return `${wsBase()}/term?${q}`
}

export function dapWsUrl(workspace?: number): string {
	const t = getToken()
	// `withToken` only adds '?token=…' when auth is on, so the separator has to
	// be chosen here — appending '&workspace=' blindly produced the invalid
	// path '/dap&workspace=0' and the server never matched the upgrade route.
	const parts = [
		t ? `token=${encodeURIComponent(t)}` : '',
		workspace !== undefined ? `workspace=${workspace}` : '',
	].filter(Boolean)
	return parts.length ? `${wsBase()}/dap?${parts.join('&')}` : `${wsBase()}/dap`
}

export function lspWsUrl(lang: string, workspace?: number): string {
	const t = getToken()
	const q = `lang=${encodeURIComponent(lang)}${t ? `&token=${encodeURIComponent(t)}` : ''}${workspace !== undefined ? `&workspace=${workspace}` : ''}`
	return `${wsBase()}/lsp?${q}`
}

export function extToLanguage(filePath: string): string {
	const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
	if (['ts', 'tsx', 'mts', 'cts'].includes(ext)) return 'typescript'
	if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'javascript'
	if (ext === 'json') return 'json'
	if (ext === 'py') return 'python'
	if (ext === 'md' || ext === 'markdown') return 'markdown'
	if (ext === 'html' || ext === 'htm' || ext === 'xml' || ext === 'vue')
		return 'html'
	if (ext === 'css' || ext === 'scss' || ext === 'less') return 'css'
	if (['yml', 'yaml'].includes(ext)) return 'yaml'
	return 'plaintext'
}
