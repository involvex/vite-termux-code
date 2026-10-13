import {dapWsUrl} from './api'

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
}

export interface DapThread {
	id: number
	name: string
}

export interface DapFrame {
	id: number
	name: string
	source?: {path?: string; name?: string}
	line: number
	column: number
}

export interface DapScope {
	name: string
	variablesReference: number
	expensive: boolean
}

export interface DapVariable {
	name: string
	value: string
	type?: string
	variablesReference: number
}

type EventHandler = (event: string, body: Record<string, unknown>) => void

let nextId = 1

/** Single shared WS client for the (single, v1) debug session. */
class DapClient {
	private ws: WebSocket | null = null
	private pending = new Map<
		number,
		{resolve: (v: unknown) => void; reject: (e: Error) => void}
	>()
	private handlers = new Set<EventHandler>()

	onEvent(fn: EventHandler): () => void {
		this.handlers.add(fn)
		return () => this.handlers.delete(fn)
	}

	connect(workspace?: number) {
		if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1))
			return
		let ws: WebSocket
		try {
			ws = new WebSocket(dapWsUrl(workspace))
		} catch {
			return
		}
		this.ws = ws
		ws.onmessage = ev => {
			try {
				const msg = JSON.parse(ev.data as string) as {
					type?: string
					id?: number
					result?: unknown
					error?: unknown
					event?: string
					body?: Record<string, unknown>
				}
				if (msg.type === 'response' && typeof msg.id === 'number') {
					const p = this.pending.get(msg.id)
					if (p) {
						this.pending.delete(msg.id)
						if (msg.error) p.reject(new Error(String(msg.error).slice(0, 500)))
						else p.resolve(msg.result)
					}
					return
				}
				if (msg.type === 'event' && msg.event) {
					this.handlers.forEach(h => h(msg.event as string, msg.body ?? {}))
				}
			} catch {
				/* ignore */
			}
		}
		ws.onclose = () => {
			this.ws = null
		}
		ws.onerror = () => {
			try {
				ws.close()
			} catch {
				/* ignore */
			}
		}
	}

	ensureConnected(workspace?: number) {
		this.connect(workspace)
	}

	sendBreakpoints(
		path: string,
		bps: {line: number; condition?: string; hitCondition?: string}[],
		workspace?: number,
	) {
		this.connect(workspace)
		if (this.ws?.readyState === 1) {
			this.ws.send(
				JSON.stringify({
					type: 'breakpoints',
					path,
					breakpoints: bps,
					rootDir: workspace,
				}),
			)
		}
	}

	request<T>(
		command: string,
		args: unknown = {},
		timeoutMs = 15000,
	): Promise<T> {
		this.connect()
		const id = nextId++
		if (this.ws?.readyState === 1) {
			this.ws.send(JSON.stringify({type: 'request', id, command, args}))
		}
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				reject(new Error(`dap timeout: ${command}`))
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
}

export const dapClient = new DapClient()
