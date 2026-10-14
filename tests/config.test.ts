import {describe, expect, test} from 'bun:test'
import {
	generatePairingCode,
	parseConfig,
	userConfigPath,
} from '../server/config.ts'

describe('parseConfig', () => {
	test('empty object is valid', () => {
		expect(parseConfig('{}')).toEqual({})
	})

	test('parses a full config', () => {
		expect(
			parseConfig(
				JSON.stringify({
					port: 8080,
					host: '127.0.0.1',
					auth: false,
					authToken: 'secret',
					pairing: {enabled: true, length: 8},
					watch: false,
					terms: false,
					open: true,
					version: 1,
				}),
			),
		).toEqual({
			port: 8080,
			host: '127.0.0.1',
			auth: false,
			authToken: 'secret',
			pairing: {enabled: true, length: 8},
			watch: false,
			terms: false,
			open: true,
			version: 1,
		})
	})

	test('rejects invalid JSON with the source path', () => {
		expect(() => parseConfig('{oops', '/home/me/.td-code/config.json')).toThrow(
			/\/home\/me\/\.td-code\/config\.json is not valid JSON/,
		)
	})

	test('rejects a non-object document', () => {
		expect(() => parseConfig('[1,2]', 'cfg')).toThrow(
			/must contain a JSON object/,
		)
	})

	test('rejects unknown keys so typos surface', () => {
		expect(() => parseConfig('{"authentification": false}', 'cfg')).toThrow(
			/unknown key\(s\): authentification/,
		)
	})

	test('validates types', () => {
		expect(() => parseConfig('{"port": 0}', 'cfg')).toThrow(/port.*1-65535/)
		expect(() => parseConfig('{"port": 70000}', 'cfg')).toThrow(/port.*1-65535/)
		expect(() => parseConfig('{"auth": "no"}', 'cfg')).toThrow(/true or false/)
		expect(() => parseConfig('{"pairing": []}', 'cfg')).toThrow(
			/pairing" must be an object/,
		)
		expect(() => parseConfig('{"pairing": {"length": 2}}', 'cfg')).toThrow(
			/pairing\.length.*4-10/,
		)
		expect(() => parseConfig('{"pairing": {"code": "abc"}}', 'cfg')).toThrow(
			/pairing\.code.*digits/,
		)
		expect(() => parseConfig('{"version": 2}', 'cfg')).toThrow(
			/unsupported "version"/,
		)
	})

	test('accepts a UTF-8 BOM, as written by Notepad / PowerShell 5.1', () => {
		expect(parseConfig('\ufeff{"auth": false}')).toEqual({auth: false})
	})

	test('accepts a fixed numeric pairing code', () => {
		expect(parseConfig('{"pairing": {"code": "482913"}}').pairing?.code).toBe(
			'482913',
		)
	})
})

describe('generatePairingCode', () => {
	test('produces digits of the requested length', () => {
		expect(generatePairingCode(6)).toMatch(/^\d{6}$/)
		expect(generatePairingCode(4)).toMatch(/^\d{4}$/)
	})

	test('clamps out-of-range lengths', () => {
		expect(generatePairingCode(1)).toMatch(/^\d{4}$/)
		expect(generatePairingCode(99)).toMatch(/^\d{10}$/)
	})
})

describe('userConfigPath', () => {
	test('points at ~/.td-code/config.json', () => {
		const p = userConfigPath()
		expect(p.replace(/\\/g, '/')).toMatch(/\/\.td-code\/config\.json$/)
	})
})
