import {existsSync} from 'node:fs'
import path from 'node:path'

/** Resolve user-supplied relative path, jailed inside root. Returns null on escape. */
export function resolveSafe(root: string, requested: string): string | null {
	const rel = (requested || '').replace(/^\/+/, '')
	const abs = path.resolve(root, rel)
	const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
	if (abs !== root && !abs.startsWith(rootWithSep)) return null
	return abs
}

export function findOnPath(cmd: string): string | null {
	const pathEnv = process.env.PATH ?? ''
	const lower = cmd.toLowerCase()
	const exts =
		process.platform === 'win32'
			? (process.env.PATHEXT?.split(';') ?? ['.EXE', '.CMD', '.BAT']).map(e =>
					e.toLowerCase(),
				)
			: ['']
	for (const dir of pathEnv.split(path.delimiter)) {
		if (!dir) continue
		const candidates = [cmd]
		for (const ext of exts) {
			if (ext && !lower.endsWith(ext)) candidates.push(cmd + ext)
		}
		for (const name of candidates) {
			const p = path.join(dir, name)
			try {
				if (existsSync(p)) return p
			} catch {
				/* ignore */
			}
		}
	}
	return null
}
