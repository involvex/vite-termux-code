import {useState} from 'react'
import {api, type SearchHit} from '../lib/api'
import {useAppStore} from '../store/useAppStore'

export default function SearchPanel() {
	const [q, setQ] = useState('')
	const [hits, setHits] = useState<SearchHit[]>([])
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState('')
	const {openTab, setStatus} = useAppStore()

	const run = async () => {
		if (q.trim().length < 2) return
		setLoading(true)
		setError('')
		try {
			const res = await api.search(q.trim())
			setHits(res.results)
		} catch (e) {
			setError(e instanceof Error ? e.message : 'search failed')
		} finally {
			setLoading(false)
		}
	}

	const jump = async (h: SearchHit) => {
		try {
			const data = await api.read(h.file)
			openTab({
				path: h.file,
				content: data.content ?? '',
				savedContent: data.content ?? '',
				mtime: data.mtime,
			})
			setStatus(`${h.file}:${h.line}`)
		} catch (e) {
			setStatus(e instanceof Error ? e.message : 'open failed')
		}
	}

	return (
		<div className="panel-col">
			<div className="panel-toolbar">
				<span className="panel-title">Search</span>
			</div>
			<form
				className="search-form"
				onSubmit={e => {
					e.preventDefault()
					void run()
				}}
			>
				<input
					className="search-input"
					value={q}
					onChange={e => setQ(e.target.value)}
					placeholder="search in files… (min 2 chars)"
				/>
			</form>
			{loading && <div className="muted">searching…</div>}
			{error && <div className="error">{error}</div>}
			<ul className="search-results">
				{hits.map((h, i) => (
					<li key={`${h.file}:${h.line}:${i}`}>
						<button
							className="search-hit"
							onClick={() => void jump(h)}
						>
							<span className="search-file">
								{h.file}:{h.line}
							</span>
							<span className="search-preview">{h.preview}</span>
						</button>
					</li>
				))}
			</ul>
			{hits.length === 0 && !loading && (
				<div className="muted small">no results yet</div>
			)}
		</div>
	)
}
