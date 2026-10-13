import path from 'node:path'

/** Resolve user-supplied relative path, jailed inside root. Returns null on escape. */
export function resolveSafe(root: string, requested: string): string | null {
	const rel = (requested || '').replace(/^\/+/, '')
	const abs = path.resolve(root, rel)
	const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
	if (abs !== root && !abs.startsWith(rootWithSep)) return null
	return abs
}
