const map: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2',
	'.woff': 'font/woff',
	'.ttf': 'font/ttf',
	'.webmanifest': 'application/manifest+json',
	'.txt': 'text/plain; charset=utf-8',
}

export function lookup(filePath: string): string {
	const dot = filePath.lastIndexOf('.')
	const ext = dot === -1 ? '' : filePath.slice(dot).toLowerCase()
	return map[ext] ?? 'application/octet-stream'
}
