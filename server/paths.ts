import {existsSync} from 'node:fs'
import path from 'node:path'

/**
 * Resolve user-supplied relative path, jailed inside one of the roots.
 * Returns null on escape or if path doesn't exist under any root.
 */
export function resolveSafe(
	roots: string | string[],
	requested: string,
): string | null {
	const rootArray = Array.isArray(roots) ? roots : [roots]
	const rel = (requested || '').replace(/^\/+/, '')

	for (const root of rootArray) {
		const abs = path.resolve(root, rel)
		const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
		if (abs !== root && !abs.startsWith(rootWithSep)) continue
		// Check if the path actually exists under this root
		if (existsSync(abs)) return abs
	}
	return null
}

/**
 * Find which root a given absolute path belongs to.
 * Returns the root path or null if not under any root.
 */
export function findRootForPath(
	roots: string | string[],
	absPath: string,
): string | null {
	const rootArray = Array.isArray(roots) ? roots : [roots]
	const normalized = path.resolve(absPath)
	for (const root of rootArray) {
		const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
		if (normalized === root || normalized.startsWith(rootWithSep)) {
			return root
		}
	}
	return null
}

/**
 * Get relative path from the root it belongs to.
 */
export function getRelativePath(
	roots: string | string[],
	absPath: string,
): string {
	const root = findRootForPath(roots, absPath)
	if (!root) return ''
	const rel = path.relative(root, absPath)
	return rel.split(path.sep).join('/')
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
