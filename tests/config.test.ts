import {describe, expect, test} from 'bun:test'
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {
	checkWorkspacePaths,
	generatePairingCode,
	initUserConfig,
	parseConfig,
	parseEnvWorkspaces,
	resolveConfigWorkspaces,
	STARTER_CONFIG_TEXT,
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
					workspaces: ['~/projects/api', {path: '~/projects/web', name: 'web'}],
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
			workspaces: [
				{path: '~/projects/api'},
				{path: '~/projects/web', name: 'web'},
			],
			version: 1,
		})
	})

	test('ignores _comment / $comment keys', () => {
		expect(
			parseConfig('{"_comment": "hi", "$note": 1, "auth": false}'),
		).toEqual({auth: false})
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

	test('validates workspaces entries', () => {
		expect(
			parseConfig('{"workspaces": ["a", {"path": "b", "name": "B"}]}')
				.workspaces,
		).toEqual([{path: 'a'}, {path: 'b', name: 'B'}])
		expect(() => parseConfig('{"workspaces": "nope"}', 'cfg')).toThrow(
			/must be an array/,
		)
		expect(() => parseConfig('{"workspaces": []}', 'cfg')).toThrow(
			/must not be empty/,
		)
		expect(() => parseConfig('{"workspaces": [42]}', 'cfg')).toThrow(
			/must be a path string/,
		)
		expect(() => parseConfig('{"workspaces": ["", "x"]}', 'cfg')).toThrow(
			/non-empty string/,
		)
		expect(() => parseConfig('{"workspaces": ["a", "A"]}', 'cfg')).toThrow(
			/duplicates/,
		)
		expect(() =>
			parseConfig('{"workspaces": [{"path": "a", "bogus": 1}]}', 'cfg'),
		).toThrow(/unknown key\(s\): bogus/)
	})
})

describe('resolveConfigWorkspaces', () => {
	test('expands ~ and resolves relative paths', () => {
		const out = resolveConfigWorkspaces(
			[{path: 'rel/dir'}, {path: '~/x', name: 'home'}],
			'/base',
		)
		expect(out[0]?.path.replace(/\\/g, '/')).toMatch(/\/base\/rel\/dir$/)
		expect(out[1]?.name).toBe('home')
	})
})

describe('parseEnvWorkspaces', () => {
	test('splits on the OS path delimiter', () => {
		const sep = process.platform === 'win32' ? ';' : ':'
		expect(parseEnvWorkspaces(`a${sep} b ${sep}`).map(w => w.path)).toEqual([
			'a',
			'b',
		])
		expect(parseEnvWorkspaces('')).toEqual([])
		expect(parseEnvWorkspaces(undefined)).toEqual([])
	})
})

describe('checkWorkspacePaths', () => {
	test('reports existing dirs, missing paths, and files', () => {
		const dir = mkdtempSync(join(tmpdir(), 'td-code-ws-'))
		try {
			const sub = join(dir, 'proj')
			mkdirSync(sub, {recursive: true})
			const file = join(dir, 'note.txt')
			writeFileSync(file, 'hi', 'utf8')
			const out = checkWorkspacePaths(
				[{path: sub}, {path: join(dir, 'gone')}, {path: file}],
				dir,
			)
			expect(out[0]).toMatchObject({exists: true, isDirectory: true})
			expect(out[1]).toMatchObject({exists: false, isDirectory: false})
			expect(out[2]).toMatchObject({exists: true, isDirectory: false})
		} finally {
			rmSync(dir, {recursive: true, force: true})
		}
	})
})

describe('initUserConfig', () => {
	test('starter template parses and round-trips', () => {
		expect(() => parseConfig(STARTER_CONFIG_TEXT, '<starter>')).not.toThrow()
		const parsed = parseConfig(STARTER_CONFIG_TEXT)
		expect(parsed.port).toBe(4444)
		expect(parsed.workspaces?.length).toBe(2)
	})

	test('writes the file, refuses to overwrite without --force', () => {
		const dir = mkdtempSync(join(tmpdir(), 'td-code-cfg-'))
		try {
			const file = join(dir, '.td-code', 'config.json')
			const first = initUserConfig(file, {})
			expect(first.path).toBe(file)
			expect(readFileSync(file, 'utf8')).toBe(STARTER_CONFIG_TEXT)
			expect(() => initUserConfig(file, {})).toThrow(/already exists/)
			expect(() => initUserConfig(file, {force: true})).not.toThrow()
		} finally {
			rmSync(dir, {recursive: true, force: true})
		}
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
