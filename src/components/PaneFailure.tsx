import {useState} from 'react'
import type {PaneErrorInfo} from '../lib/paneError'

interface Props {
	/** Human name of the pane, e.g. "editor" or "terminal". */
	label: string
	retry: () => void
	info: PaneErrorInfo
}

/**
 * Failure UI for a lazy pane. Keeps the two failure modes distinct so a real
 * crash is never reported as "network?":
 *  - load:   the JS chunk never arrived (offline / 404 / stale index.html)
 *  - render: the chunk loaded, but the component threw while mounting (a bug)
 */
export default function PaneFailure({label, retry, info}: Props) {
	const [copied, setCopied] = useState(false)
	const isLoad = info.kind === 'load'
	const stack = info.error?.stack ?? ''
	const details = [
		`kind: ${info.kind}`,
		info.url ? `url: ${info.url}` : null,
		info.error ? `${info.error.name}: ${info.error.message}` : null,
		stack ? `\n${stack}` : null,
	]
		.filter(Boolean)
		.join('\n')

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(details)
			setCopied(true)
			window.setTimeout(() => setCopied(false), 1500)
		} catch {
			setCopied(false)
		}
	}

	return (
		<div className="pane-failure">
			<p className="pane-failure-title">
				{isLoad ? `Couldn't load the ${label} bundle` : `The ${label} crashed`}
			</p>
			<p className="pane-failure-hint">
				{isLoad ? (
					<>
						The module request failed, so the {label} code never ran. This is a
						network or stale-build problem: check your connection, then retry.
						If you just redeployed td-code, reload the page to pick up the new
						index.html.
					</>
				) : (
					<>
						The {label} code loaded but threw while opening — that's an app bug,
						not a network problem. The details below identify it.
					</>
				)}
			</p>
			{info.url && (
				<p className="pane-failure-url">
					<code>{info.url}</code>
				</p>
			)}
			<details className="pane-failure-details">
				<summary>{info.summary}</summary>
				<pre>{details}</pre>
			</details>
			<div className="pane-failure-actions">
				<button
					className="save-btn"
					onClick={retry}
				>
					Retry
				</button>
				<button
					className="chip"
					onClick={copy}
					title="Copy error details"
				>
					{copied ? 'Copied' : 'Copy details'}
				</button>
				<button
					className="chip"
					onClick={() => window.location.reload()}
					title="Reload the whole app"
				>
					Reload window
				</button>
			</div>
		</div>
	)
}
