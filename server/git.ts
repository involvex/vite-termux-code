import {execFile} from 'node:child_process'
import path from 'node:path'
import {findOnPath} from './paths.ts'

export interface GitChange {
	path: string
	kind: string
}

export interface GitStatus {
	repo: true
	branch: string | null
	detached: boolean
	ahead: number
	behind: number
	staged: GitChange[]
	unstaged: GitChange[]
	untracked: string[]
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

export class GitError extends Error {
	status: number
	constructor(message: string, status = 400) {
		super(message)
		this.status = status
	}
}

let gitBin: string | null | undefined

export function gitAvailable(): boolean {
	if (gitBin === undefined) gitBin = findOnPath('git')
	return gitBin !== null
}

function runGit(
	cwd: string,
	args: string[],
	timeoutMs = 30000,
): Promise<string> {
	return new Promise((resolve, reject) => {
		if (!gitAvailable()) {
			reject(
				new GitError('git is not installed (Termux: pkg install git)', 501),
			)
			return
		}
		execFile(
			gitBin as string,
			args,
			{cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024},
			(err, stdout, stderr) => {
				if (err) {
					const msg = (stderr || err.message).trim().slice(0, 2000)
					reject(new GitError(msg, 400))
					return
				}
				resolve(stdout)
			},
		)
	})
}

export interface RepoScope {
	/** absolute repo toplevel (inside the served root's tree) */
	toplevel: string
	/** toplevel-relative path of the served root, or '.' */
	scope: string
}

/** Locate the repo containing rootDir. Throws GitError when there is none. */
export async function repoScope(rootDir: string): Promise<RepoScope> {
	if (!gitAvailable()) {
		throw new GitError('git is not installed (Termux: pkg install git)', 501)
	}
	let toplevel: string
	try {
		toplevel = (await runGit(rootDir, ['rev-parse', '--show-toplevel'])).trim()
	} catch {
		throw new GitError('not a git repository', 404)
	}
	const scope =
		path.relative(toplevel, rootDir).split(path.sep).join('/') || '.'
	if (scope.startsWith('..')) {
		// Shouldn't happen (toplevel came from inside rootDir), be safe anyway.
		throw new GitError('repository scope escapes served directory', 403)
	}
	return {toplevel, scope}
}

/** Validate a repo-relative file path and confine it to the served scope. */
function scopedFile(scope: string, file: string): string {
	const f = (file || '').replace(/\\/g, '/').replace(/^\/+/, '')
	if (!f || f.split('/').includes('..')) {
		throw new GitError(`invalid path: ${file}`, 400)
	}
	if (scope !== '.' && f !== scope && !f.startsWith(scope + '/')) {
		throw new GitError(`path outside served directory: ${file}`, 403)
	}
	return f
}

function scopeArg(scope: string): string[] {
	return scope === '.' ? [] : [scope]
}

export async function gitStatus(rootDir: string): Promise<GitStatus> {
	const {toplevel, scope} = await repoScope(rootDir)
	const out = await runGit(toplevel, [
		'status',
		'--porcelain=v1',
		'-b',
		'--untracked-files=normal',
		'--',
		...scopeArg(scope),
	])
	const lines = out.split('\n')
	const branchLine = (lines.shift() ?? '').replace(/^## /, '')
	let branch: string | null = null
	let detached = false
	let ahead = 0
	let behind = 0
	const m = branchLine.match(/^(.+?)(?:\.\.\.(.+?))?(?: \[(.+)\])?$/)
	if (m) {
		const head = (m[1] ?? '').trim()
		if (head === 'HEAD (no branch)' || head.startsWith('HEAD')) {
			detached = true
			try {
				branch = (
					await runGit(toplevel, ['rev-parse', '--short', 'HEAD'])
				).trim()
			} catch {
				branch = null
			}
		} else if (head.startsWith('No commits yet on ')) {
			branch = head.replace('No commits yet on ', '')
		} else {
			branch = head
		}
		const tracking = m[3] ?? ''
		for (const part of tracking.split(',').map(s => s.trim())) {
			const a = part.match(/^ahead (\d+)$/)
			const b = part.match(/^behind (\d+)$/)
			if (a) ahead = Number(a[1])
			if (b) behind = Number(b[1])
		}
	}
	const staged: GitChange[] = []
	const unstaged: GitChange[] = []
	const untracked: string[] = []
	const stripScope = (p: string) =>
		scope === '.'
			? p
			: p.startsWith(scope + '/')
				? p.slice(scope.length + 1)
				: p
	for (const line of lines) {
		if (line.length < 4) continue
		const x = line[0] as string
		const y = line[1] as string
		let p = line.slice(3)
		// renames: "R  old -> new" — report the new path
		const arrow = p.indexOf(' -> ')
		if (arrow !== -1) p = p.slice(arrow + 4)
		// quoted paths (spaces/unicode): git quotes them C-style
		if (p.startsWith('"') && p.endsWith('"')) {
			try {
				p = JSON.parse(p) as string
			} catch {
				p = p.slice(1, -1)
			}
		}
		if (x === '?' && y === '?') {
			untracked.push(stripScope(p))
			continue
		}
		if (x !== ' ' && x !== '?') staged.push({path: stripScope(p), kind: x})
		if (y !== ' ' && y !== '?') unstaged.push({path: stripScope(p), kind: y})
	}
	return {
		repo: true,
		branch,
		detached,
		ahead,
		behind,
		staged,
		unstaged,
		untracked,
	}
}

export async function gitLog(
	rootDir: string,
	limit = 20,
): Promise<GitCommit[]> {
	const {toplevel, scope} = await repoScope(rootDir)
	const n = Math.max(1, Math.min(50, Math.floor(limit) || 20))
	const out = await runGit(toplevel, [
		'log',
		`--format=%H%x1f%h%x1f%s%x1f%an%x1f%ad`,
		'--date=short',
		'-n',
		String(n),
		'--',
		...scopeArg(scope),
	]).catch(err => {
		// fresh repo without commits: git log exits 128 — return empty, not error
		if (
			err instanceof GitError &&
			/does not have any commits/.test(err.message)
		)
			return ''
		throw err
	})
	if (!out.trim()) return []
	return out
		.split('\n')
		.filter(Boolean)
		.map(line => {
			const [hash = '', short = '', subject = '', author = '', date = ''] =
				line.split('\x1f')
			return {hash, short, subject, author, date}
		})
}

export async function gitDiff(
	rootDir: string,
	file: string,
	staged: boolean,
): Promise<{diff: string; truncated: boolean}> {
	const {toplevel, scope} = await repoScope(rootDir)
	const f = scopedFile(scope, file)
	const out = await runGit(toplevel, [
		'diff',
		'--no-color',
		...(staged ? ['--cached'] : []),
		'--',
		f,
	])
	const MAX = 200_000
	if (out.length > MAX) return {diff: out.slice(0, MAX), truncated: true}
	return {diff: out, truncated: false}
}

export async function gitStage(
	rootDir: string,
	files: string[],
): Promise<void> {
	const {toplevel, scope} = await repoScope(rootDir)
	if (!files.length) throw new GitError('no files given', 400)
	await runGit(toplevel, ['add', '--', ...files.map(f => scopedFile(scope, f))])
}

export async function gitUnstage(
	rootDir: string,
	files: string[],
): Promise<void> {
	const {toplevel, scope} = await repoScope(rootDir)
	if (!files.length) throw new GitError('no files given', 400)
	await runGit(toplevel, [
		'restore',
		'--staged',
		'--',
		...files.map(f => scopedFile(scope, f)),
	])
}

export async function gitCommit(
	rootDir: string,
	message: string,
	name?: string,
	email?: string,
): Promise<{hash: string}> {
	const {toplevel} = await repoScope(rootDir)
	const msg = (message ?? '').trim()
	if (!msg) throw new GitError('commit message is empty', 400)
	if (msg.length > 2000) throw new GitError('commit message too long', 400)
	const args: string[] = []
	if (name?.trim()) args.push('-c', `user.name=${name.trim()}`)
	if (email?.trim()) args.push('-c', `user.email=${email.trim()}`)
	args.push('commit', '-m', msg)
	try {
		await runGit(toplevel, args)
	} catch (err) {
		if (
			err instanceof GitError &&
			/user\.name|user\.email|Author identity unknown/i.test(err.message)
		) {
			throw new GitError(
				'git needs an identity: set name/email below or run: git config user.name "You" && git config user.email "you@example.com"',
				400,
			)
		}
		throw err
	}
	const hash = (await runGit(toplevel, ['rev-parse', 'HEAD'])).trim()
	return {hash}
}

export async function gitBranches(rootDir: string): Promise<GitBranch[]> {
	const {toplevel} = await repoScope(rootDir)
	// NOTE: `git branch --format` does not interpret %xNN escapes on all
	// versions, so parse the stable default output instead ("* current").
	const out = await runGit(toplevel, ['branch', '--no-color'])
	return out
		.split('\n')
		.map(line => line.trim())
		.filter(line => line.length > 0 && !line.startsWith('('))
		.map(line => {
			const current = line.startsWith('*')
			const name = line.replace(/^[*+ ] /, '').trim()
			return {name, current}
		})
		.filter(b => b.name.length > 0)
}

export async function gitCheckout(rootDir: string, ref: string): Promise<void> {
	const {toplevel} = await repoScope(rootDir)
	const r = (ref || '').trim()
	if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(r) || r.includes('..')) {
		throw new GitError(`invalid branch name: ${ref}`, 400)
	}
	await runGit(toplevel, ['checkout', r])
}
