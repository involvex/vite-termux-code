import {
	autocompletion,
	closeBrackets,
	closeBracketsKeymap,
	completionKeymap,
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
import {bracketMatching, indentOnInput} from '@codemirror/language'
import {highlightSelectionMatches, searchKeymap} from '@codemirror/search'
import {EditorState} from '@codemirror/state'
import {oneDark} from '@codemirror/theme-one-dark'
import {EditorView, keymap} from '@codemirror/view'
import {useEffect, useMemo, useRef} from 'react'
import {extToLanguage} from '../lib/api'
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

export default function CodeEditor({filePath}: {filePath: string}) {
	const containerRef = useRef<HTMLDivElement>(null)
	const viewRef = useRef<EditorView | null>(null)
	const {tabs, updateTab} = useAppStore()
	const tab = tabs.find(t => t.path === filePath)

	const initialDoc = useMemo(() => tab?.content ?? '', [filePath]) // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => {
		if (!containerRef.current || !tab) return
		// destroy previous
		viewRef.current?.destroy()

		const readOnly = Boolean(tab.truncated || tab.binary)
		const state = EditorState.create({
			doc: initialDoc,
			extensions: [
				history(),
				bracketMatching(),
				closeBrackets(),
				autocompletion({activateOnTyping: true, maxRenderedOptions: 30}),
				indentOnInput(),
				highlightSelectionMatches(),
				keymap.of([
					indentWithTab,
					...closeBracketsKeymap,
					...defaultKeymap,
					...historyKeymap,
					...completionKeymap,
					...searchKeymap,
				]),
				langExtension(filePath),
				oneDark,
				EditorView.lineWrapping,
				EditorView.updateListener.of(update => {
					if (update.docChanged) {
						updateTab(filePath, {content: update.state.doc.toString()})
					}
				}),
				EditorState.readOnly.of(readOnly),
				EditorView.editable.of(!readOnly),
			],
		})
		const view = new EditorView({state, parent: containerRef.current})
		viewRef.current = view
		return () => {
			view.destroy()
			viewRef.current = null
		}
		// re-create only when switching files or readonly flips
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [filePath, tab?.truncated, tab?.binary])

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
			<div
				ref={containerRef}
				className="cm-host"
			/>
		</div>
	)
}
