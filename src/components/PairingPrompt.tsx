import {useEffect, useState} from 'react'
import {api} from '../lib/api'

interface Props {
	/** Called after a successful code submit so the app can retry. */
	onPaired: () => void
}

/**
 * Shown when the server requires auth and the browser has no valid credential
 * (or pairing is enabled). The short code is printed by `td-code` at startup
 * and is accepted anywhere a token is, so typing it here is enough.
 */
export default function PairingPrompt({onPaired}: Props) {
	const [code, setCode] = useState('')
	const [error, setError] = useState('')
	const [busy, setBusy] = useState(false)

	// `?code=…` in the URL is treated as a submitted code: verify it, then
	// clean the URL so the credential is not left visible in history.
	useEffect(() => {
		const fromUrl = new URL(window.location.href).searchParams.get('code')
		if (!fromUrl) return
		void verify(fromUrl)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	const verify = async (value: string) => {
		const candidate = value.trim()
		if (!candidate) {
			setError('enter the code shown by td-code')
			return
		}
		setBusy(true)
		setError('')
		api.setPairingCode(candidate)
		try {
			// Must be an authenticated endpoint: /api/health is public and would
			// accept any code.
			await api.authCheck()
			onPaired()
		} catch {
			api.clearPairingCode()
			setError('that code was not accepted — try again')
		} finally {
			setBusy(false)
		}
	}

	return (
		<div className="pairing">
			<form
				className="pairing-card"
				onSubmit={e => {
					e.preventDefault()
					void verify(code)
				}}
			>
				<h1>td-code</h1>
				<p className="muted">
					This server requires a credential. Type the pairing code printed in
					the terminal that started td-code — it is accepted anywhere a token
					is.
				</p>
				<input
					autoFocus
					className="pairing-input"
					value={code}
					onChange={e => setCode(e.target.value)}
					placeholder="e.g. 482913"
					inputMode="numeric"
					autoComplete="one-time-code"
					spellCheck={false}
					aria-label="Pairing code"
				/>
				{error && <div className="error">{error}</div>}
				<button
					className="save-btn"
					type="submit"
					disabled={busy || !code.trim()}
				>
					{busy ? 'checking…' : 'Pair'}
				</button>
				<p className="muted small">
					Running on a trusted network? Start td-code with{' '}
					<code>--no-auth</code> or set <code>{'"auth": false}'}</code> in
					~/.td-code/config.json.
				</p>
			</form>
		</div>
	)
}
