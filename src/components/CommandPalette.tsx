import {useEffect, useMemo, useRef, useState} from 'react'
import {allCommands, fuzzyScore, type Command} from '../lib/commands'
import {useAppStore} from '../store/useAppStore'

export default function CommandPalette() {
	const {paletteOpen, setPaletteOpen, setStatus} = useAppStore()
	const [query, setQuery] = useState('')
	const [index, setIndex] = useState(0)
	const inputRef = useRef<HTMLInputElement>(null)
	const listRef = useRef<HTMLDivElement>(null)
	const prevOpenRef = useRef(paletteOpen)
	const prevQueryRef = useRef(query)

	// Reset state when the palette opens (adjust during render, not in an effect).
	if (paletteOpen && !prevOpenRef.current) {
		setQuery('')
		setIndex(0)
	}
	prevOpenRef.current = paletteOpen

	// Reset selection when the query changes.
	if (prevQueryRef.current !== query) {
		setIndex(0)
		prevQueryRef.current = query
	}

	const commands = useMemo(
		() => (paletteOpen ? allCommands() : []),
		[paletteOpen],
	)

	const filtered = useMemo(() => {
		const q = query.trim().replace(/^>\s*/, '')
		if (!q) return commands
		return commands
			.map(c => {
				const s = fuzzyScore(q, c.title)
				return s === null ? null : {c, s}
			})
			.filter((x): x is {c: Command; s: number} => x !== null)
			.sort((a, b) => b.s - a.s)
			.map(x => x.c)
	}, [commands, query])

	useEffect(() => {
		if (paletteOpen) {
			// focus after mount
			const t = window.setTimeout(() => inputRef.current?.focus(), 20)
			return () => window.clearTimeout(t)
		}
	}, [paletteOpen])

	useEffect(() => {
		listRef.current
			?.querySelector('[data-active="true"]')
			?.scrollIntoView({block: 'nearest'})
	}, [index])

	if (!paletteOpen) return null

	const run = (c: Command) => {
		setPaletteOpen(false)
		try {
			const r = c.run()
			if (r instanceof Promise)
				r.catch(e =>
					setStatus(e instanceof Error ? e.message : 'command failed'),
				)
		} catch (e) {
			setStatus(e instanceof Error ? e.message : 'command failed')
		}
	}

	return (
		<div
			className="palette-backdrop"
			onMouseDown={e => {
				if (e.target === e.currentTarget) setPaletteOpen(false)
			}}
		>
			<div
				className="palette"
				role="dialog"
				aria-label="Command palette"
			>
				<input
					ref={inputRef}
					className="palette-input"
					value={query}
					onChange={e => setQuery(e.target.value)}
					placeholder="> type a command… (Esc to close)"
					onKeyDown={e => {
						if (e.key === 'Escape') {
							e.preventDefault()
							setPaletteOpen(false)
						} else if (e.key === 'ArrowDown') {
							e.preventDefault()
							setIndex(i => Math.min(filtered.length - 1, i + 1))
						} else if (e.key === 'ArrowUp') {
							e.preventDefault()
							setIndex(i => Math.max(0, i - 1))
						} else if (e.key === 'Enter') {
							e.preventDefault()
							const c = filtered[index]
							if (c) run(c)
						}
					}}
				/>
				<div
					ref={listRef}
					className="palette-list"
				>
					{filtered.map((c, i) => (
						<button
							key={c.id}
							data-active={i === index}
							className={`palette-item ${i === index ? 'active' : ''}`}
							onMouseEnter={() => setIndex(i)}
							onClick={() => run(c)}
						>
							<span className="palette-title">{c.title}</span>
							{c.hint && <span className="palette-hint">{c.hint}</span>}
						</button>
					))}
					{filtered.length === 0 && (
						<div className="palette-empty muted">no matching commands</div>
					)}
				</div>
			</div>
		</div>
	)
}
