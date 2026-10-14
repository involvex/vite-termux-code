import {describe, expect, test} from 'bun:test'
import {
	chunkUrlFrom,
	classifyPaneError,
	summarizePaneError,
} from '../src/lib/paneError.ts'

describe('classifyPaneError', () => {
	test('a rejected dynamic import is a load failure, not a crash', () => {
		const info = classifyPaneError(
			new TypeError(
				'Failed to fetch dynamically imported module: http://127.0.0.1:4444/assets/CodeEditor-abc123.js',
			),
			null,
		)
		expect(info.kind).toBe('load')
		expect(info.url).toBe('http://127.0.0.1:4444/assets/CodeEditor-abc123.js')
		expect(info.summary).toBe('Failed to fetch dynamically imported module')
	})

	test('a component that throws while mounting is a render failure', () => {
		const info = classifyPaneError(
			null,
			new RangeError('Field is not present in this state'),
		)
		expect(info.kind).toBe('render')
		expect(info.url).toBeUndefined()
		expect(info.summary).toBe('Field is not present in this state')
	})

	test('a rejected import wins over a render error', () => {
		const info = classifyPaneError(
			new Error('Failed to fetch dynamically imported module: /assets/X-1.js'),
			new Error('never reached'),
		)
		expect(info.kind).toBe('load')
		expect(info.error?.message).toContain('Failed to fetch')
		expect(info.summary).not.toContain('never reached')
	})

	test('neither error still produces a usable message', () => {
		expect(classifyPaneError(null, null).summary).toBe('Pane crashed')
		expect(classifyPaneError(null, null).kind).toBe('render')
	})
})

describe('chunkUrlFrom', () => {
	test('extracts an absolute module url', () => {
		expect(
			chunkUrlFrom(
				new Error(
					'Failed to fetch dynamically imported module: https://cdn.example.com/a/b-1.js',
				),
			),
		).toBe('https://cdn.example.com/a/b-1.js')
	})

	test('extracts a root-relative module path', () => {
		expect(
			chunkUrlFrom(
				new TypeError(
					'Failed to fetch dynamically imported module: /assets/CodeEditor-xy.js',
				),
			),
		).toBe('/assets/CodeEditor-xy.js')
	})

	test('returns undefined for unrelated messages', () => {
		expect(
			chunkUrlFrom(new Error('Field is not present in this state')),
		).toBeUndefined()
		expect(chunkUrlFrom(null)).toBeUndefined()
	})
})

describe('summarizePaneError', () => {
	test('trims the trailing module url', () => {
		expect(
			summarizePaneError(
				'load',
				new Error(
					'Failed to fetch dynamically imported module: /assets/x-1.js',
				),
			),
		).toBe('Failed to fetch dynamically imported module')
	})

	test('falls back to the error name when message is empty', () => {
		expect(summarizePaneError('render', new RangeError(''))).toBe('RangeError')
	})
})
