import {lspWsUrl} from './api'

export interface LspPosition {
	line: number
	character: number
}

export interface LspRange {
	start: LspPosition
	end: LspPosition
}

export interface LspDiagnostic {
	range: LspRange
	severity?: number
	message: string
	source?: string
}

export interface LspCompletionItem {
	label: string
	kind?: number
	detail?: string
	documentation?: string | {value: string}
	insertText?: string
}

type Handler = (msg: unknown) => void

let nextId = 1

/** Minimal LSP-over-WebSocket client. One instance per language. */
export class LspClient {
	private ws: WebSocket | null = null
	private pending = new Map<
		number,
		{resolve: (v: unknown) => void; reject: (e: Error) => void}
	>()
	private handlers = new Set<Handler>()
	private opened = new Set<string>()
	private reconnects = 0
	readonly lang: string
	ready = false
	error = ''

	constructor(lang: string) {
		this.lang = lang
	}

	onMessage(fn: Handler): () => void {
		this.handlers.add(fn)
		return () => this.handlers.delete(fn)
	}

	connect(workspace?: number) {
		if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1))
			return
		let ws: WebSocket
		try {
			ws = new WebSocket(lspWsUrl(this.lang, workspace))
		} catch (e) {
			this.error = e instanceof Error ? e.message : 'ws failed'
			return
		}
		this.ws = ws
		ws.onopen = () => {
			this.reconnects = 0
			this.error = ''
			this.send({type: 'ensure'})
			// Re-announce open docs after reconnect
			for (const p of this.opened) {
				// Caller re-sends text via didChange; just mark for re-open
				this.handlers.forEach(h => h({type: 'reconnect', path: p}))
			}
		}
		ws.onmessage = ev => {
			try {
				const msg = JSON.parse(ev.data as string) as {
					type?: string
					id?: number
					result?: unknown
					error?: unknown
				}
				if (msg.type === 'response' && typeof msg.id === 'number') {
					const p = this.pending.get(msg.id)
					if (p) {
						this.pending.delete(msg.id)
						if (msg.error) p.reject(new Error(String(msg.error).slice(0, 500)))
						else p.resolve(msg.result)
					}
				}
				if (msg.type === 'ready' || msg.type === 'hello') this.ready = true
				if (msg.type === 'error' && !msg.id)
					this.error = String(msg.error ?? 'lsp error')
				this.handlers.forEach(h => h(msg))
			} catch {
				/* ignore */
			}
		}
		ws.onclose = () => {
			this.ws = null
			this.ready = false
			if (this.reconnects < 5) {
				this.reconnects++
				setTimeout(
					() => this.connect(workspace),
					Math.min(5000, 500 * this.reconnects),
				)
			}
		}
		ws.onerror = () => {
			try {
				ws.close()
			} catch {
				/* ignore */
			}
		}
	}

	private send(msg: unknown) {
		if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg))
	}

	didOpen(path: string, text: string, workspace?: number) {
		this.opened.add(path)
		this.send({type: 'open', path, text, rootDir: workspace})
	}

	didChange(path: string, text: string, workspace?: number) {
		if (!this.opened.has(path)) {
			this.didOpen(path, text, workspace)
			return
		}
		this.send({type: 'change', path, text, rootDir: workspace})
	}

	didClose(path: string, workspace?: number) {
		this.opened.delete(path)
		this.send({type: 'close', path, rootDir: workspace})
	}

	request<T>(
		method: string,
		params: unknown,
		workspace?: number,
		timeoutMs = 8000,
	): Promise<T> {
		const id = nextId++
		this.send({type: 'request', id, method, params, rootDir: workspace})
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				reject(new Error(`lsp timeout: ${method}`))
			}, timeoutMs)
			this.pending.set(id, {
				resolve: v => {
					clearTimeout(timer)
					resolve(v as T)
				},
				reject: e => {
					clearTimeout(timer)
					reject(e)
				},
			})
		})
	}

	dispose() {
		try {
			this.ws?.close()
		} catch {
			/* ignore */
		}
		this.ws = null
		this.handlers.clear()
		this.pending.clear()
	}
}

const clients = new Map<string, Map<number | undefined, LspClient>>()

export function lspFor(lang: string, workspace?: number): LspClient | null {
	if (lang !== 'typescript' && lang !== 'javascript') return null
	const langClients = clients.get('typescript') ?? new Map()
	let c = langClients.get(workspace)
	if (!c) {
		c = new LspClient('typescript')
		c.connect(workspace)
		langClients.set(workspace, c)
		clients.set('typescript', langClients)
	}
	return c
}

export function offsetToPos(text: string, offset: number): LspPosition {
	const before = text.slice(0, offset)
	const lines = before.split('\n')
	return {
		line: lines.length - 1,
		character: (lines[lines.length - 1] ?? '').length,
	}
}

export function posToOffset(text: string, pos: LspPosition): number {
	const lines = text.split('\n')
	let off = 0
	for (let i = 0; i < pos.line && i < lines.length; i++)
		off += (lines[i] ?? '').length + 1
	return off + Math.min(pos.character, (lines[pos.line] ?? '').length)
}

/** Build a file:// URI matching the server's pathToFileURL(root+rel). */
export function toUri(root: string, relPath: string): string {
	const rel = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
	const normRoot = root.replace(/\\/g, '/')
	if (/^[A-Za-z]:\//.test(normRoot) || /^[A-Za-z]:$/.test(normRoot)) {
		return `file:///${normRoot.replace(/\/+$/, '')}/${rel}`
	}
	if (normRoot.startsWith('/')) {
		return `file://${normRoot.replace(/\/+$/, '')}/${rel}`
	}
	return `file:///${rel}`
}
