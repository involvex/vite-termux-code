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
import {bracketMatching, indentOnInput, indentUnit} from '@codemirror/language'
import {lintGutter, linter, type Diagnostic} from '@codemirror/lint'
import {highlightSelectionMatches, searchKeymap} from '@codemirror/search'
import {
	EditorState,
	RangeSet,
	RangeSetBuilder,
	StateEffect,
	StateField,
} from '@codemirror/state'
import {oneDark} from '@codemirror/theme-one-dark'
import {
	Decoration,
	EditorView,
	GutterMarker,
	gutter,
	hoverTooltip,
	keymap,
	type Tooltip,
} from '@codemirror/view'
import {useEffect, useMemo, useRef, useState} from 'react'
import {extToLanguage} from '../lib/api'
import {dapClient} from '../lib/dap'
import {
	lspFor,
	offsetToPos,
	posToOffset,
	toUri,
	type LspCompletionItem,
	type LspDiagnostic,
} from '../lib/lsp'
import {themeById} from '../lib/themes'
import type {Bp} from '../store/useAppStore'
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

// --- Debug breakpoints: per-file line sets live in the zustand store
// (persisted). The editor mirrors them into a StateField so the gutter
// refreshes without recreating the view.
const setBpsEffect = StateEffect.define<Bp[]>()
const bpField = StateField.define<Map<number, Bp>>({
	create: () => new Map<number, Bp>(),
	update(value, tr) {
		for (const e of tr.effects) {
			if (e.is(setBpsEffect))
				return new Map(e.value.map(b => [b.line, b] as [number, Bp]))
		}
		return value
	},
})

class BpMarker extends GutterMarker {
	cond: boolean
	constructor(cond: boolean) {
		super()
		this.cond = cond
	}
	toDOM() {
		const d = document.createElement('div')
		d.className = this.cond ? 'bp-dot bp-dot-cond' : 'bp-dot'
		return d
	}
}

function syncBpField(filePath: string, view: EditorView, workspace?: number) {
	const key = workspace !== undefined ? `${workspace}:${filePath}` : filePath
	const bps = useAppStore.getState().breakpoints[key] ?? []
	view.dispatch({effects: setBpsEffect.of(bps)})
	// live-update a running session; backend stores them regardless
	dapClient.sendBreakpoints(filePath, bps, workspace)
}

function toggleBp(
	filePath: string,
	view: EditorView,
	line: number,
	workspace?: number,
) {
	const {breakpoints, setBreakpoints} = useAppStore.getState()
	const key = workspace !== undefined ? `${workspace}:${filePath}` : filePath
	const cur = breakpoints[key] ?? []
	const next = cur.some(b => b.line === line)
		? cur.filter(b => b.line !== line)
		: [...cur, {line}].sort((a, b) => a.line - b.line)
	setBreakpoints(filePath, next, workspace)
	syncBpField(filePath, view, workspace)
}

/** Alt+Click a breakpoint: edit condition / hit condition (empty clears). */
function editBpCond(
	filePath: string,
	view: EditorView,
	line: number,
	workspace?: number,
) {
	const {breakpoints, setBreakpointCond, setStatus} = useAppStore.getState()
	const key = workspace !== undefined ? `${workspace}:${filePath}` : filePath
	const cur = breakpoints[key]?.find(b => b.line === line)
	if (!cur) {
		setStatus(`set a breakpoint on line ${line} first (click the gutter)`)
		return
	}
	const condition = window.prompt(
		`Condition for breakpoint at ${filePath}:${line} (expression, empty = always break):`,
		cur.condition ?? '',
	)
	if (condition === null) return
	const hitCondition = window.prompt(
		'Hit condition (e.g. >= 5, empty = none):',
		cur.hitCondition ?? '',
	)
	if (hitCondition === null) return
	const c = condition.trim()
	const h = hitCondition.trim()
	// empty strings clear that part; clearing both keeps a plain breakpoint
	setBreakpointCond(filePath, line, {condition: c, hitCondition: h}, workspace)
	syncBpField(filePath, view, workspace)
	setStatus(
		c || h
			? `conditional breakpoint ${filePath}:${line}`
			: `breakpoint ${filePath}:${line}`,
	)
}

function bpGutterExt(filePath: string, workspace?: number) {
	return gutter({
		class: 'bp-gutter',
		// Without this, CodeMirror only creates gutter elements for lines that
		// already have a marker — leaving an empty, unclickable gutter, so a
		// breakpoint could never be set by clicking the margin.
		renderEmptyElements: true,
		markers: v => {
			const set = v.state.field(bpField, false)
			if (!set || set.size === 0) return RangeSet.empty
			const build = new RangeSetBuilder<GutterMarker>()
			for (const [ln, bp] of [...set.entries()].sort((a, b) => a[0] - b[0])) {
				if (ln < 1 || ln > v.state.doc.lines) continue
				const from = v.state.doc.line(ln).from
				build.add(
					from,
					from,
					new BpMarker(Boolean(bp.condition || bp.hitCondition)),
				)
			}
			return build.finish()
		},
		domEventHandlers: {
			mousedown(view, line, event) {
				const ln = view.state.doc.lineAt(line.from).number
				if ((event as MouseEvent).altKey)
					editBpCond(filePath, view, ln, workspace)
				else toggleBp(filePath, view, ln, workspace)
				return true
			},
		},
	})
}

// --- Stopped-location highlight (debugger current line)
// NOTE: a StateField used as a dependency of `EditorView.decorations.compute`
// must ALSO be part of the state config, otherwise `state.field(curField)`
// inside the compute callback throws "Field is not present in this state"
// on every editor mount.
const setCurEffect = StateEffect.define<number | null>()
const curField = StateField.define<number | null>({
	create: () => null,
	update(value, tr) {
		for (const e of tr.effects) {
			if (e.is(setCurEffect)) return e.value
		}
		return value
	},
})

const curLineDeco = EditorView.decorations.compute([curField], state => {
	const ln = state.field(curField)
	if (!ln || ln < 1 || ln > state.doc.lines) return Decoration.none
	return Decoration.set([
		Decoration.line({class: 'dbg-cur-line'}).range(state.doc.line(ln).from),
	])
})

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
	workspace?: number,
): Promise<boolean> {
	const client = lspFor('typescript')
	if (!client) return false
	const root = useAppStore.getState().root
	const doc = view.state.doc.toString()
	const pos = offsetToPos(doc, view.state.selection.main.head)
	try {
		const res = (await client.request(
			'textDocument/definition',
			{
				textDocument: {uri: toUri(root, filePath)},
				position: pos,
			},
			workspace,
		)) as
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
				const data = await api.read(targetPath, workspace)
				if (!data.binary) {
					openTab({
						path: targetPath,
						content: data.content ?? '',
						savedContent: data.content ?? '',
						mtime: data.mtime,
						workspace,
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
	const {tabs, updateTab, settings, debug, debugJump} = useAppStore()
	const tab = tabs.find(t => t.path === filePath)
	const [lspError, setLspError] = useState('')
	const tabWorkspace = tab?.workspace

	const initialDoc = useMemo(() => tab?.content ?? '', [filePath]) // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => {
		if (!containerRef.current || !tab) return
		viewRef.current?.destroy()

		const readOnly = Boolean(tab.truncated || tab.binary)
		const useLsp = isTs(filePath) && !readOnly
		const client = useLsp ? lspFor(extToLanguage(filePath)) : null
		if (client) {
			client.didOpen(filePath, initialDoc, tabWorkspace)
			const off = client.onMessage(msg => {
				const m = msg as {
					type?: string
					path?: string
					diagnostics?: LspDiagnostic[]
					error?: unknown
					rootDir?: string
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
				client.didChange(filePath, text, tabWorkspace)
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
				const res = (await client.request(
					'textDocument/hover',
					{
						textDocument: {uri: toUri(useAppStore.getState().root, filePath)},
						position,
					},
					tabWorkspace,
				)) as {contents?: unknown} | null
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
				const res = (await client.request(
					'textDocument/completion',
					{
						textDocument: {uri: toUri(useAppStore.getState().root, filePath)},
						position,
					},
					tabWorkspace,
				)) as {items: LspCompletionItem[]} | LspCompletionItem[] | null
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
							void gotoDefinition(view, filePath, tabWorkspace)
							return true
						},
					},
				]),
				langExtension(filePath),
				themeById(settings.theme).cm === 'oneDark' ? oneDark : [],
				bpField.init(() => {
					const key =
						tabWorkspace !== undefined
							? `${tabWorkspace}:${filePath}`
							: filePath
					return new Map(
						(useAppStore.getState().breakpoints[key] ?? []).map(b => [
							b.line,
							b,
						]),
					)
				}),
				// must be in the state for the curLineDeco compute above
				curField.init(() => null),
				...(readOnly ? [] : [bpGutterExt(filePath, tabWorkspace)]),
				curLineDeco,
				settings.wordWrap ? EditorView.lineWrapping : [],
				indentUnit.of(
					settings.insertSpaces ? ' '.repeat(settings.tabSize) : '\t',
				),
				...(useLsp ? [tsLinter, lintGutter(), tsHover] : []),
				EditorView.domEventHandlers({
					mousedown: (e, view) => {
						if ((e.ctrlKey || e.metaKey) && useLsp) {
							e.preventDefault()
							void gotoDefinition(view, filePath, tabWorkspace)
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

	// Debugger: highlight the stopped line in this file (if any)
	useEffect(() => {
		const view = viewRef.current
		if (!view) return
		const want =
			debug.stopped && debug.stopped.file === filePath
				? (debug.stopped.line ?? null)
				: null
		try {
			if (view.state.field(curField, false) !== want) {
				view.dispatch({effects: setCurEffect.of(want)})
			}
		} catch {
			/* field absent (read-only race) */
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [debug.stopped, filePath])

	// Debugger: jump-to-location requests (stopped event, frame click)
	useEffect(() => {
		const view = viewRef.current
		if (!view || !debugJump || debugJump.path !== filePath) return
		const ln = Math.max(1, Math.min(debugJump.line, view.state.doc.lines))
		const pos = view.state.doc.line(ln).from
		view.dispatch({
			selection: {anchor: pos},
			effects: EditorView.scrollIntoView(pos, {y: 'center'}),
		})
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [debugJump])

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
