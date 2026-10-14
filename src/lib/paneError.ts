/**
 * Pane failure classification — pure helpers, no React/DOM, so they can be
 * unit-tested. A lazy pane can fail for two very different reasons and they
 * must never be conflated:
 *
 *   load:   the JS chunk never arrived (offline, 404, stale index.html after a
 *           redeploy) -> the user may need to reload or check connectivity
 *   render: the chunk loaded, but the component threw while mounting -> a bug
 */

export interface PaneErrorInfo {
	kind: 'load' | 'render'
	error: Error | null
	/** Short headline, e.g. "Failed to fetch dynamically imported module". */
	summary: string
	/** Module URL, when the browser reported one (load failures only). */
	url?: string
}

// Absolute URL first, else any root-relative path that looks like a JS module
// ("/assets/CodeEditor-xy.js", "/ext/dist/main-1.js", ...).
const MODULE_URL_RE = /(https?:\/\/\S+|\/[\w./-]*\.js\b)/

/**
 * Decide which failure happened. `loadError` is set by the lazy factory when
 * the module import rejected; `renderError` comes from the error boundary when
 * the component itself threw. A rejected import wins, because a rejected
 * import never reaches render.
 */
export function classifyPaneError(
	loadError: Error | null,
	renderError: Error | null,
): PaneErrorInfo {
	const kind: PaneErrorInfo['kind'] = loadError ? 'load' : 'render'
	const error = kind === 'load' ? loadError : renderError
	const url = kind === 'load' ? chunkUrlFrom(error) : undefined
	return {
		kind,
		error,
		summary: summarizePaneError(kind, error),
		...(url ? {url} : {}),
	}
}

/** Pull the module URL out of a "Failed to fetch dynamically imported module" message. */
export function chunkUrlFrom(err: Error | null): string | undefined {
	const m = err?.message?.match(MODULE_URL_RE)
	return m?.[1]
}

/** One-line, human-readable headline. Trims the trailing module URL. */
export function summarizePaneError(
	kind: PaneErrorInfo['kind'],
	err: Error | null,
): string {
	if (!err) return kind === 'load' ? 'Module failed to load' : 'Pane crashed'
	const msg = err.message || err.name || String(err)
	return msg.replace(/:\s*\/?(\S+\.js)\s*$/, '').trim()
}
