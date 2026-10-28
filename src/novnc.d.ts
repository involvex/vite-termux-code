declare module '@novnc/novnc' {
	export interface NoVncCredentials {
		username?: string
		password?: string
		target?: string
	}

	export interface NoVncOptions {
		shared?: boolean
		credentials?: NoVncCredentials
		repeaterID?: string
		wsProtocols?: string[]
	}

	export default class RFB extends EventTarget {
		constructor(
			target: HTMLElement,
			urlOrChannel: string | WebSocket | RTCDataChannel,
			options?: NoVncOptions,
		)

		viewOnly: boolean
		focusOnClick: boolean
		clipViewport: boolean
		dragViewport: boolean
		scaleViewport: boolean
		resizeSession: boolean
		showDotCursor: boolean
		qualityLevel: number
		compressionLevel: number
		readonly capabilities: Record<string, boolean>
		readonly clippingViewport: boolean

		disconnect(): void
		sendCredentials(credentials: NoVncCredentials): void
		sendCtrlAltDel(): void
		sendKey(keysym: number, code: string | null, down?: boolean): void
		focus(options?: FocusOptions): void
		blur(): void
		clipboardPasteFrom(text: string): void
		approveServer(): void
	}
}
