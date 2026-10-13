import {
	autocompletion,
	closeBrackets,
	closeBracketsKeymap,
	completionKeymap,
	type CompletionContext,
	type CompletionResult,
} from '@codemirror/autocomplete'
import {
	defaultKeymap,
	history,
	historyKeymap,
	indentWithTab,
} from '@codemirror/commands'
import {css} from '@codemirror/lang-css'
import {html} from '@codemirror/lang-html'
import {javascript} from '@codemirror/lang-javascript'
import {json} from '@codemirror/lang-json'
import {markdown} from '@codemirror/lang-markdown'
import {python} from '@codemirror/lang-python'
import {yaml} from '@codemirror/lang-yaml'
import {
	bracketMatching,
	indentOnInput,
	indentUnit,
} from '@codemirror/language'
import {lintGutter, linter, type Diagnostic} from '@codemirror/lint'
import {highlightSelectionMatches, searchKeymap} from '@codemirror/search'
import {EditorState} from '@codemirror/state'
import {oneDark} from '@codemirror/theme-one-dark'
import {EditorView, hoverTooltip, keymap, type Tooltip} from '@codemirror/view'
import {useEffect, useMemo, useRef, useState} from 'react'
import {extToLanguage} from '../lib/api'
import {themeById} from '../lib/themes'
import {
	lspFor,
	offsetToPos,
	posToOffset,
	toUri,
	type LspCompletionItem,
	type LspDiagnostic,
} from '../lib/lsp'
import {useAppStore} from '../store/useAppStore'

function langExtension(filePath: string) {
	const lang = extToLanguage(filePath)
	switch (lang) {
		case 'typescript':
			return javascript({typescript: true})
		case 'javascript':
			return javascript({typescript: false})
		case 'json':
			return json()
		case 'python':
			return python()
		case 'html':
			return html()
		case 'css':
			return css()
		case 'markdown':
			return markdown()
		case 'yaml':
			return yaml()
		default:
			return []
	}
}

function isTs(filePath: string): boolean {
	const lang = extToLanguage(filePath)
	return lang === 'typescript' || lang === 'javascript'
}

function severityOf(s?: number): 'error' | 'warning' | 'info' {
	if (s === 1) return 'error'
	if (s === 2) return 'warning'
	return 'info'
}

/** Shared diagnostics cache, keyed by relative path. Updated via LSP WS. */
const diagCache = new Map<string, Diagnostic[]>()
const diagListeners = new Set<() => void>()

function setDiags(path: string, items: LspDiagnostic[], docText: string) {
	diagCache.set(
		path,
		items.map(d => ({
			from: posToOffset(docText, d.range.start),
			to: Math.max(
				posToOffset(docText, d.range.start) + 1,
				posToOffset(docText, d.range.end),
			),
			severity: severityOf(d.severity),
			message: d.message + (d.source ? ` [${d.source}]` : ''),
		})),
	)
	for (const fn of diagListeners) fn()
}

function lspMarkdownToText(v: unknown): string {
	if (typeof v === 'string') return v
	if (v && typeof v === 'object') {
		const o = v as {value?: unknown; kind?: unknown}
		if (typeof o.value === 'string') return o.value
	}
	return ''
}

async function gotoDefinition(
	view: EditorView,
	filePath: string,
): Promise<boolean> {
	const client = lspFor('typescript')
	if (!client) return false
	const root = useAppStore.getState().root
	const doc = view.state.doc.toString()
	const pos = offsetToPos(doc, view.state.selection.main.head)
	try {
		const res = (await client.request('textDocument/definition', {
			textDocument: {uri: toUri(root, filePath)},
			position: pos,
		})) as
			| {uri: string; range: {start: {line: number; character: number}}}
			| {uri: string; range: {start: {line: number; character: number}}}[]
			| null
		if (!res) return false
		const loc = Array.isArray(res) ? res[0] : res
		if (!loc?.uri) return false
		// Same-file jump only for v1; cross-file opens the target file.
		const targetUri = loc.uri as string
		let targetPath = ''
		try {
			const u = new URL(targetUri)
			const abs = decodeURIComponent(u.pathname)
			const normRoot = root.replace(/\\/g, '/')
			const normAbs = /^\/[A-Za-z]:\//.test(abs)
				? abs.slice(1).replace(/\//g, '/')
				: abs
			if (normAbs.startsWith(normRoot)) {
				targetPath = normAbs.slice(normRoot.length).replace(/^\/+/, '')
			}
		} catch {
			/* ignore */
		}
		const {openTab, setActive, setStatus} = useAppStore.getState()
		if (targetPath && targetPath !== filePath) {
			try {
				const {api} = await import('../lib/api')
				const data = await api.read(targetPath)
				if (!data.binary) {
					openTab({
						path: targetPath,
						content: data.content ?? '',
						savedContent: data.content ?? '',
						mtime: data.mtime,
					})
					setActive(targetPath)
					setStatus(`definition: ${targetPath}`)
					return true
				}
			} catch {
				/* fall through to same-file line jump */
			}
		}
		const line = loc.range.start.line + 1
		const lineInfo = view.state.doc.line(Math.min(line, view.state.doc.lines))
		view.dispatch({
			selection: {anchor: lineInfo.from},
			effects: EditorView.scrollIntoView(lineInfo.from, {y: 'center'}),
		})
		view.focus()
		return true
	} catch {
		return false
	}
}

export default function CodeEditor({filePath}: {filePath: string}) {
	const containerRef = useRef<HTMLDivElement>(null)
	const viewRef = useRef<EditorView | null>(null)
	const changeTimer = useRef<number | null>(null)
	const {tabs, updateTab, settings} = useAppStore()
	const tab = tabs.find(t => t.path === filePath)
	const [lspError, setLspError] = useState('')

	const initialDoc = useMemo(() => tab?.content ?? '', [filePath]) // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => {
		if (!containerRef.current || !tab) return
		viewRef.current?.destroy()

		const readOnly = Boolean(tab.truncated || tab.binary)
		const useLsp = isTs(filePath) && !readOnly
		const client = useLsp ? lspFor(extToLanguage(filePath)) : null
		if (client) {
			client.didOpen(filePath, initialDoc)
			const off = client.onMessage(msg => {
				const m = msg as {
					type?: string
					path?: string
					diagnostics?: LspDiagnostic[]
					error?: unknown
				}
				if (m.type === 'diagnostics' && m.path === filePath) {
					const cur = viewRef.current?.state.doc.toString() ?? initialDoc
					setDiags(filePath, m.diagnostics ?? [], cur)
				}
				if (m.type === 'error' && m.error) {
					setLspError(String(m.error).slice(0, 300))
				}
			})
			// cleanup subscription on recreate
			viewRef.current?.destroy()
			void off
		}

		const pushChange = (text: string) => {
			if (!client) return
			if (changeTimer.current !== null) window.clearTimeout(changeTimer.current)
			changeTimer.current = window.setTimeout(() => {
				client.didChange(filePath, text)
			}, 500)
		}

		const tsLinter = linter(view => {
			const cached = diagCache.get(filePath) ?? []
			// Clamp to doc length (doc may have changed since diagnostics arrived)
			const max = view.state.doc.length
			return cached
				.filter(d => d.from <= max)
				.map(d => ({...d, to: Math.min(d.to, max)}))
		})

		const tsHover = hoverTooltip(async (view, pos): Promise<Tooltip | null> => {
			if (!client) return null
			const doc = view.state.doc.toString()
			const position = offsetToPos(doc, pos)
			try {
				const res = (await client.request('textDocument/hover', {
					textDocument: {uri: toUri(useAppStore.getState().root, filePath)},
					position,
				})) as {contents?: unknown} | null
				if (!res?.contents) return null
				const raw = Array.isArray(res.contents)
					? res.contents.map(lspMarkdownToText).join('\n')
					: lspMarkdownToText(res.contents)
				if (!raw.trim()) return null
				return {
					pos,
					create: () => {
						const dom = document.createElement('div')
						dom.className = 'lsp-hover'
						dom.textContent = raw.slice(0, 2000)
						return {dom}
					},
				}
			} catch {
				return null
			}
		})

		async function tsComplete(
			ctx: CompletionContext,
		): Promise<CompletionResult | null> {
			if (!client) return null
			const doc = ctx.state.doc.toString()
			const position = offsetToPos(doc, ctx.pos)
			// Only trigger on identifiers / dots to avoid spamming the server
			const before = doc.slice(Math.max(0, ctx.pos - 2), ctx.pos)
			if (!/[A-Za-z0-9_$.]$/.test(before)) return null
			try {
				const res = (await client.request('textDocument/completion', {
					textDocument: {uri: toUri(useAppStore.getState().root, filePath)},
					position,
				})) as {items: LspCompletionItem[]} | LspCompletionItem[] | null
				const items = Array.isArray(res) ? res : (res?.items ?? [])
				if (!items.length) return null
				return {
					from: ctx.pos,
					options: items.slice(0, 30).map(i => ({
						label: i.label,
						detail: i.detail ?? i.kind?.toString(),
						info:
							typeof i.documentation === 'string'
								? i.documentation
								: (i.documentation as {value?: string} | undefined)?.value,
						apply: i.insertText ?? i.label,
					})),
				}
			} catch {
				return null
			}
		}

		const state = EditorState.create({
			doc: initialDoc,
			extensions: [
				history(),
				bracketMatching(),
				closeBrackets(),
				autocompletion({
					activateOnTyping: true,
					maxRenderedOptions: 30,
					override: useLsp ? [tsComplete] : undefined,
				}),
				indentOnInput(),
				highlightSelectionMatches(),
				keymap.of([
					indentWithTab,
					...closeBracketsKeymap,
					...defaultKeymap,
					...historyKeymap,
					...completionKeymap,
					...searchKeymap,
					{
						key: 'F12',
						run: view => {
							void gotoDefinition(view, filePath)
							return true
						},
					},
				]),
				langExtension(filePath),
				themeById(settings.theme).cm === 'oneDark' ? oneDark : [],
				settings.wordWrap ? EditorView.lineWrapping : [],
				indentUnit.of(
					settings.insertSpaces ? ' '.repeat(settings.tabSize) : '\t',
				),
				...(useLsp ? [tsLinter, lintGutter(), tsHover] : []),
				EditorView.domEventHandlers({
					mousedown: (e, view) => {
						if ((e.ctrlKey || e.metaKey) && useLsp) {
							e.preventDefault()
							void gotoDefinition(view, filePath)
							return true
						}
						return false
					},
				}),
				EditorView.updateListener.of(update => {
					if (update.docChanged) {
						const text = update.state.doc.toString()
						updateTab(filePath, {content: text})
						pushChange(text)
					}
				}),
				EditorState.readOnly.of(readOnly),
				EditorView.editable.of(!readOnly),
			],
		})
		const view = new EditorView({state, parent: containerRef.current})
		viewRef.current = view
		const rerender = () => {
			try {
				// Nudge the linter to re-read diagCache
				view.dispatch({effects: []})
			} catch {
				/* ignore */
			}
		}
		diagListeners.add(rerender)
		return () => {
			diagListeners.delete(rerender)
			if (changeTimer.current !== null) window.clearTimeout(changeTimer.current)
			try {
				client?.didClose(filePath)
			} catch {
				/* ignore */
			}
			view.destroy()
			viewRef.current = null
		}
		// re-create when switching files, readonly flips, or editor settings change
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		filePath,
		tab?.truncated,
		tab?.binary,
		settings.theme,
		settings.wordWrap,
		settings.tabSize,
		settings.insertSpaces,
	])

	// External content changes (e.g. file reloaded from disk)
	useEffect(() => {
		const view = viewRef.current
		if (!view || !tab) return
		const current = view.state.doc.toString()
		if (current !== tab.content && document.activeElement !== view.contentDOM) {
			view.dispatch({
				changes: {from: 0, to: current.length, insert: tab.content},
			})
		}
	}, [tab?.content, tab]) // eslint-disable-line react-hooks/exhaustive-deps

	if (!tab) return null
	if (tab.binary) {
		return (
			<div className="editor-empty">
				Binary file — preview not supported: {tab.path}
			</div>
		)
	}
	return (
		<div className="cm-wrap">
			{tab.truncated && (
				<div className="banner">
					Large file (&gt;2MB): read-only preview of first 2MB.
				</div>
			)}
			{lspError && isTs(filePath) && (
				<div className="banner">
					LSP: {lspError}{' '}
					<span className="muted">
						(bun add -d typescript-language-server typescript)
					</span>
				</div>
			)}
			<div
				ref={containerRef}
				className="cm-host"
			/>
		</div>
	)
}
