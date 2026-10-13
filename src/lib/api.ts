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

function getToken(): string {
	const url = new URL(window.location.href)
	const q = url.searchParams.get('token')
	if (q) {
		sessionStorage.setItem('td-code-token', q)
		return q
	}
	return sessionStorage.getItem('td-code-token') ?? ''
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
			...(init?.headers ?? {}),
		},
	})
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

export const api = {
	health: () =>
		req<{ok: boolean; root: string; version: string}>('/api/health'),
	list: (dirPath = '', hidden = false) =>
		req<{path: string; items: FileItem[]}>(
			`/api/files?path=${encodeURIComponent(dirPath)}&hidden=${hidden ? '1' : '0'}`,
		),
	read: (filePath: string) =>
		req<FileContent>(`/api/file?path=${encodeURIComponent(filePath)}`),
	save: (filePath: string, content: string) =>
		req<{ok: boolean; mtime: number}>('/api/file', {
			method: 'POST',
			body: JSON.stringify({path: filePath, content}),
		}),
	mkdir: (dirPath: string) =>
		req<{ok: boolean}>('/api/mkdir', {
			method: 'POST',
			body: JSON.stringify({path: dirPath}),
		}),
	rename: (from: string, to: string) =>
		req<{ok: boolean}>('/api/rename', {
			method: 'POST',
			body: JSON.stringify({from, to}),
		}),
	remove: (target: string) =>
		req<{ok: boolean}>('/api/remove', {
			method: 'POST',
			body: JSON.stringify({path: target}),
		}),
	search: (q: string, base = '') =>
		req<{query: string; count: number; results: SearchHit[]}>(
			`/api/search?q=${encodeURIComponent(q)}&path=${encodeURIComponent(base)}`,
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
	gitStatus: () => req<GitStatus>('/api/git/status'),
	gitLog: (limit = 15) =>
		req<{commits: GitCommit[]}>(`/api/git/log?limit=${limit}`),
	gitDiff: (file: string, staged: boolean) =>
		req<{diff: string; truncated: boolean}>(
			`/api/git/diff?file=${encodeURIComponent(file)}&staged=${staged ? '1' : '0'}`,
		),
	gitStage: (files: string[]) =>
		req<{ok: boolean}>('/api/git/stage', {
			method: 'POST',
			body: JSON.stringify({files}),
		}),
	gitUnstage: (files: string[]) =>
		req<{ok: boolean}>('/api/git/unstage', {
			method: 'POST',
			body: JSON.stringify({files}),
		}),
	gitCommit: (message: string, name?: string, email?: string) =>
		req<{hash: string}>('/api/git/commit', {
			method: 'POST',
			body: JSON.stringify({message, name, email}),
		}),
	gitBranches: () => req<{branches: GitBranch[]}>('/api/git/branches'),
	gitCheckout: (ref: string) =>
		req<{ok: boolean}>('/api/git/checkout', {
			method: 'POST',
			body: JSON.stringify({ref}),
		}),
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
