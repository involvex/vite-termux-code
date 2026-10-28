import type RFB from '@novnc/novnc'
import {useEffect, useRef, useState} from 'react'
import {useAppStore} from '../store/useAppStore'

export interface VNCViewerProps {
	visible: boolean
}

/**
 * Browser VNC client using modern `@novnc/novnc` (ESM).
 * Only connects while `visible` is true; URL/password come from the store.
 */
export function VNCViewer({visible}: VNCViewerProps) {
	const url = useAppStore(s => s.vncUrl)
	const password = useAppStore(s => s.vncPassword)
	const setVncOpen = useAppStore(s => s.setVncOpen)
	const screenRef = useRef<HTMLDivElement>(null)
	const [status, setStatus] = useState('idle')
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		if (!visible || !url.trim()) return

		let disposed = false
		let rfb: RFB | null = null
		queueMicrotask(() => {
			if (!disposed) {
				setStatus('connecting…')
				setError(null)
			}
		})

		const onConnect = () => {
			if (!disposed) setStatus('connected')
		}
		const onDisconnect = (e: Event) => {
			if (disposed) return
			const detail = (e as CustomEvent<{clean?: boolean}>).detail
			setStatus(detail?.clean ? 'disconnected' : 'connection lost')
		}
		const onCredentials = () => {
			rfb?.sendCredentials({password: password || ''})
		}
		const onSecurityFailure = (e: Event) => {
			const detail = (e as CustomEvent<{status?: number; reason?: string}>)
				.detail
			setError(detail?.reason ?? `security failure (${detail?.status ?? '?'})`)
			setStatus('failed')
		}

		void import('@novnc/novnc').then(mod => {
			if (disposed || !screenRef.current) return
			const RfbCtor = mod.default
			try {
				rfb = new RfbCtor(screenRef.current, url.trim(), {
					credentials: password ? {password} : undefined,
				})
				rfb.scaleViewport = true
				rfb.resizeSession = true
				rfb.focusOnClick = true
				rfb.addEventListener('connect', onConnect)
				rfb.addEventListener('disconnect', onDisconnect)
				rfb.addEventListener('credentialsrequired', onCredentials)
				rfb.addEventListener('securityfailure', onSecurityFailure)
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err))
				setStatus('failed')
			}
		})

		return () => {
			disposed = true
			try {
				rfb?.removeEventListener('connect', onConnect)
				rfb?.removeEventListener('disconnect', onDisconnect)
				rfb?.removeEventListener('credentialsrequired', onCredentials)
				rfb?.removeEventListener('securityfailure', onSecurityFailure)
				rfb?.disconnect()
			} catch {
				/* ignore teardown races */
			}
			rfb = null
		}
	}, [visible, url, password])

	const label = !visible ? 'hidden' : !url.trim() ? 'no url' : status

	return (
		<section
			className={
				visible ? 'term-drawer vnc-drawer' : 'term-drawer vnc-drawer off'
			}
			aria-label="VNC"
			aria-hidden={!visible}
		>
			<div className="vnc-toolbar muted small">
				<span>VNC · {label}</span>
				<span className="vnc-url">{url}</span>
				<button
					className="vnc-close"
					title="Close VNC"
					onClick={() => setVncOpen(false)}
				>
					✕
				</button>
			</div>
			{error && <div className="error vnc-error">{error}</div>}
			<div
				ref={screenRef}
				className="vnc-screen"
			/>
		</section>
	)
}

export default VNCViewer
