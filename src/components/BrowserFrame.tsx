import {useState} from 'react'
import {useAppStore} from '../store/useAppStore'

function normalizeUrl(input: string): string {
	const t = input.trim()
	if (!t) return t
	if (/^https?:\/\//i.test(t)) return t
	return `http://${t}`
}

export default function BrowserFrame() {
	const {
		browserUrl,
		navigateBrowser,
		browserBack,
		browserForward,
		browserHistory,
		browserIndex,
		quickLinks,
		setQuickLinks,
	} = useAppStore()
	const [draft, setDraft] = useState(browserUrl)
	const [frameKey, setFrameKey] = useState(0)

	const go = (raw: string) => {
		const url = normalizeUrl(raw)
		if (!url) return
		navigateBrowser(url)
		setDraft(url)
	}

	const addQuickLink = () => {
		const label = window.prompt('Label:', new URL(browserUrl).hostname)
		if (!label) return
		setQuickLinks([...quickLinks, {label, url: browserUrl}])
	}

	return (
		<div className="browser-col">
			<div className="browser-bar">
				<button
					className="icon-btn"
					onClick={browserBack}
					disabled={browserIndex <= 0}
					title="Back"
				>
					←
				</button>
				<button
					className="icon-btn"
					onClick={browserForward}
					disabled={browserIndex >= browserHistory.length - 1}
					title="Forward"
				>
					→
				</button>
				<button
					className="icon-btn"
					onClick={() => setFrameKey(k => k + 1)}
					title="Reload"
				>
					↻
				</button>
				<form
					className="browser-form"
					onSubmit={e => {
						e.preventDefault()
						go(draft)
					}}
				>
					<input
						className="browser-input"
						value={draft}
						onChange={e => setDraft(e.target.value)}
						placeholder="http://localhost:4096"
						spellCheck={false}
					/>
				</form>
				<button
					className="icon-btn"
					title="Open in new tab (breaks out of iframe)"
					onClick={() => window.open(browserUrl, '_blank', 'noopener')}
				>
					↗
				</button>
			</div>
			<div className="quick-links">
				{quickLinks.map(q => (
					<button
						key={q.url + q.label}
						className="chip"
						onClick={() => go(q.url)}
						title={q.url}
					>
						{q.label}
					</button>
				))}
				<button
					className="chip ghost"
					onClick={addQuickLink}
					title="Save current page as quick link"
				>
					+ pin current
				</button>
			</div>
			<iframe
				key={frameKey + browserUrl}
				className="browser-frame"
				src={browserUrl}
				title="browser"
				sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
			/>
			<div className="muted small browser-hint">
				If a page refuses to load in the frame (X-Frame-Options), use ↗ to open
				it in a new tab. Run opencode in another Termux session and paste its
				URL above.
			</div>
		</div>
	)
}
