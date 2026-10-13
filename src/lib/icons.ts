/** File-type badges: 2-letter code + color class. Zero dependencies. */

export interface FileBadge {
	text: string
	className: string
}

const BY_EXT: Record<string, {text: string; className: string}> = {
	ts: {text: 'TS', className: 'fb-ts'},
	tsx: {text: 'TS', className: 'fb-ts'},
	mts: {text: 'TS', className: 'fb-ts'},
	cts: {text: 'TS', className: 'fb-ts'},
	js: {text: 'JS', className: 'fb-js'},
	jsx: {text: 'JS', className: 'fb-js'},
	mjs: {text: 'JS', className: 'fb-js'},
	cjs: {text: 'JS', className: 'fb-js'},
	py: {text: 'PY', className: 'fb-py'},
	json: {text: '{}', className: 'fb-json'},
	md: {text: 'MD', className: 'fb-md'},
	markdown: {text: 'MD', className: 'fb-md'},
	html: {text: '<>', className: 'fb-html'},
	htm: {text: '<>', className: 'fb-html'},
	xml: {text: '<>', className: 'fb-html'},
	vue: {text: 'VU', className: 'fb-html'},
	css: {text: 'CSS', className: 'fb-css'},
	scss: {text: 'CSS', className: 'fb-css'},
	less: {text: 'CSS', className: 'fb-css'},
	yaml: {text: 'YML', className: 'fb-yml'},
	yml: {text: 'YML', className: 'fb-yml'},
	toml: {text: 'TOML', className: 'fb-yml'},
	rs: {text: 'RS', className: 'fb-rs'},
	go: {text: 'GO', className: 'fb-go'},
	java: {text: 'JV', className: 'fb-java'},
	c: {text: 'C', className: 'fb-c'},
	h: {text: 'H', className: 'fb-c'},
	cpp: {text: 'C+', className: 'fb-c'},
	hpp: {text: 'H+', className: 'fb-c'},
	sh: {text: 'SH', className: 'fb-sh'},
	bash: {text: 'SH', className: 'fb-sh'},
	sql: {text: 'SQL', className: 'fb-sql'},
	lock: {text: 'LOCK', className: 'fb-lock'},
	dockerfile: {text: 'DOC', className: 'fb-docker'},
}

const BY_NAME: Record<string, {text: string; className: string}> = {
	'package.json': {text: '{}', className: 'fb-json'},
	makefile: {text: 'MK', className: 'fb-make'},
	gnumakefile: {text: 'MK', className: 'fb-make'},
	dockerfile: {text: 'DOC', className: 'fb-docker'},
	license: {text: '©', className: 'fb-doc'},
	'readme.md': {text: 'MD', className: 'fb-md'},
	'.gitignore': {text: 'GIT', className: 'fb-git'},
	'.dockerignore': {text: 'DOC', className: 'fb-docker'},
	'.env': {text: 'ENV', className: 'fb-doc'},
	'.env.example': {text: 'ENV', className: 'fb-doc'},
	'.editorconfig': {text: 'ED', className: 'fb-doc'},
	'.eslintrc': {text: 'ES', className: 'fb-doc'},
	'.prettierrc': {text: 'PR', className: 'fb-doc'},
}

export function fileBadge(fileName: string): FileBadge | null {
	const lower = fileName.toLowerCase()
	const named = BY_NAME[lower]
	if (named) return named
	const dot = lower.lastIndexOf('.')
	if (dot > 0) {
		const ext = lower.slice(dot + 1)
		const hit = BY_EXT[ext]
		if (hit) return hit
	}
	// extensionless scripts (e.g. `build`, `run`) get a generic mark
	if (!lower.includes('.')) return {text: '*', className: 'fb-sh'}
	return null
}
