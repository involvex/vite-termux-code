#!/usr/bin/env node
import {randomBytes} from 'node:crypto'
import {existsSync, statSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	bashCompletionScript,
	installBashCompletion,
	isCompletionShell,
	SUPPORTED_COMPLETION_SHELLS,
} from './completion.ts'
import {
	checkWorkspacePaths,
	generatePairingCode,
	initUserConfig,
	loadUserConfig,
	parseEnvWorkspaces,
	resolveConfigWorkspaces,
	userConfigPath,
} from './config.ts'
import {lanIps, startServer} from './server.ts'

const VERSION = '0.1.0'
const DEFAULT_PORT = 4444
const DEFAULT_HOST = '0.0.0.0'

function help() {
	console.log(`td-code v${VERSION} - minimal VSCode-like editor for Termux

Usage:
  td-code [dir...] [options]
  td-code config init [--force]   write a starter ~/.td-code/config.json
  td-code config edit             open the config in $VISUAL/$EDITOR
  td-code config validate         check the config without starting
  td-code config path             print the config file path
  td-code completion bash [--install]  print or install a bash completion script

Arguments:
  dir...                 directories to serve (default: . or config workspaces)

Options:
  -p, --port <n>         port to listen on (default: ${DEFAULT_PORT})
  --host <addr>          host to bind (default: ${DEFAULT_HOST})
  --no-auth              disable token auth (default: enabled with random token)
  --auth-token <token>   use a fixed token instead of generating one
  --pairing              accept a short pairing code (6 digits) in addition
                         to the token — handy for typing on a phone
  --pairing-code <code>  use a fixed pairing code (4-10 digits)
  --no-watch             disable file watcher broadcasts
  --no-terms             disable the terminal (shell) feature
  --open                 try to open the browser (termux-open-url / xdg-open / open)
  -h, --help             show this help
  -v, --version          show version

Examples:
  td-code .                       # serve cwd on 0.0.0.0:4444 with token
  td-code ~/myproj -p 8080 --no-auth
  td-code . --host 127.0.0.1 --auth-token secret --open
  td-code . --pairing             # also accept a 6-digit pairing code
  td-code project1 project2       # serve multiple directories (multi-root workspace)
  td-code config init             # write a commented starter config
  td-code config validate         # check the config without starting

Config file (optional): ${userConfigPath()}
  { "port": 4444, "auth": false, "pairing": { "enabled": true } }
  { "workspaces": ["~/projects/api", {"path": "~/projects/web", "name": "web"}] }
  Precedence: defaults < config file < CLI flags < TD_CODE_* env vars.
  CLI dirs win over config workspaces; TD_CODE_WORKSPACES (OS-separated) wins over both.

In another Termux session run e.g. opencode, then open its URL
in the Browser tab (default quick-link http://localhost:4096).
`)
}

interface Args {
	dirs: string[]
	port: number | null
	host: string | null
	noAuth: boolean
	authToken: string | null
	pairing: boolean
	pairingCode: string | null
	noWatch: boolean
	noTerms: boolean
	open: boolean
}

function parseArgs(argv: string[]): Args {
	const out: Args = {
		dirs: [],
		port: null,
		host: null,
		noAuth: false,
		authToken: null,
		pairing: false,
		pairingCode: null,
		noWatch: false,
		noTerms: false,
		open: false,
	}
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === '-h' || a === '--help') {
			help()
			process.exit(0)
		} else if (a === '-v' || a === '--version') {
			console.log(VERSION)
			process.exit(0)
		} else if (a === '-p' || a === '--port') {
			const v = Number(argv[++i])
			if (!Number.isFinite(v) || v < 1 || v > 65535) {
				console.error(`invalid --port: ${argv[i]}`)
				process.exit(1)
			}
			out.port = Math.floor(v)
		} else if (a.startsWith('--port=')) {
			out.port = Number(a.split('=')[1])
		} else if (a === '--host') {
			out.host = argv[++i] ?? DEFAULT_HOST
		} else if (a.startsWith('--host=')) {
			out.host = a.split('=')[1]
		} else if (a === '--no-auth') {
			out.noAuth = true
		} else if (a === '--auth-token') {
			out.authToken = argv[++i] ?? null
		} else if (a.startsWith('--auth-token=')) {
			out.authToken = a.split('=')[1]
		} else if (a === '--pairing') {
			out.pairing = true
		} else if (a === '--pairing-code') {
			out.pairingCode = argv[++i] ?? null
		} else if (a.startsWith('--pairing-code=')) {
			out.pairingCode = a.split('=')[1]
		} else if (a === '--no-watch') {
			out.noWatch = true
		} else if (a === '--no-terms') {
			out.noTerms = true
		} else if (a === '--open') {
			out.open = true
		} else if (a.startsWith('-')) {
			console.error(`unknown flag: ${a}\n`)
			help()
			process.exit(1)
		} else {
			out.dirs.push(a)
		}
	}
	if (out.pairingCode !== null && !/^\d{4,10}$/.test(out.pairingCode)) {
		console.error(`--pairing-code must be 4-10 digits, got: ${out.pairingCode}`)
		process.exit(1)
	}
	return out
}

async function handleCompletionCommand(argv: string[]): Promise<void> {
	const [shell, ...rest] = argv
	if (shell === undefined || shell === '--help' || shell === '-h') {
		console.log(
			'Usage: td-code completion bash [--install [--target <rcfile>]]\nPrints a bash completion script to stdout.\nWith --install, writes it to ~/.td-code/completion.bash and sources it\nfrom ~/.bashrc (or --target), creating the entry once.',
		)
		return
	}
	let install = false
	let target: string | null = null
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i] ?? ''
		if (a === '--install') {
			install = true
		} else if (a === '--target') {
			target = rest[i + 1] ?? ''
			i++
			if (!target) {
				console.error(
					'usage: td-code completion bash --install [--target <rcfile>]\n',
				)
				process.exit(1)
			}
		} else if (a.startsWith('--target=')) {
			target = a.slice('--target='.length)
			if (!target) {
				console.error(
					'usage: td-code completion bash --install [--target <rcfile>]\n',
				)
				process.exit(1)
			}
		} else {
			console.error(`unknown flag for completion: ${a}\n`)
			console.log(
				'Usage: td-code completion bash [--install [--target <rcfile>]]',
			)
			process.exit(1)
		}
	}
	if (!isCompletionShell(shell)) {
		console.error(
			`unsupported shell: ${shell} (supported: ${SUPPORTED_COMPLETION_SHELLS.join(', ')})\n`,
		)
		process.exit(1)
	}
	if (target && !install) {
		console.error('--target needs --install\n')
		console.log(
			'Usage: td-code completion bash [--install [--target <rcfile>]]',
		)
		process.exit(1)
	}
	if (!install) {
		process.stdout.write(bashCompletionScript())
		return
	}
	try {
		const rcFile = target
			? path.resolve(process.cwd(), target.replace(/^~/, os.homedir()))
			: undefined
		const r = installBashCompletion(rcFile ? {rcFile} : {})
		console.log(`wrote ${r.completionFile}`)
		console.log(
			r.rcUpdated
				? `added source line to ${r.rcFile}`
				: `already sourced from ${r.rcFile} (script refreshed)`,
		)
		console.log(
			`restart your shell or run: source ${r.rcFile}\nIf you added an eval line by hand before, remove it — eval without quotes breaks the script.`,
		)
	} catch (e) {
		console.error(
			`install failed: ${e instanceof Error ? e.message : String(e)}`,
		)
		process.exit(1)
	}
}

async function handleConfigCommand(argv: string[]): Promise<void> {
	const [sub, ...rest] = argv
	if (sub === 'path') {
		if (rest.length) {
			console.error('usage: td-code config path\n')
			process.exit(1)
		}
		console.log(userConfigPath())
		return
	}
	if (sub === 'init') {
		if (rest.includes('--help') || rest.includes('-h')) {
			console.log('Usage: td-code config init [--force]')
			return
		}
		const force = rest.includes('--force') || rest.includes('-f')
		const unknownFlag = rest.find(
			r => r.startsWith('-') && r !== '--force' && r !== '-f',
		)
		if (unknownFlag) {
			console.error(`unknown flag for config init: ${unknownFlag}\n`)
			console.log('Usage: td-code config init [--force]')
			process.exit(1)
		}
		try {
			const {path: file} = initUserConfig(userConfigPath(), {force})
			console.log(`wrote starter config to ${file}`)
			console.log('edit it, then run: td-code')
		} catch (e) {
			console.error(e instanceof Error ? e.message : String(e))
			process.exit(1)
		}
		return
	}
	if (sub === 'edit') {
		if (rest.includes('--help') || rest.includes('-h')) {
			console.log(
				'Usage: td-code config edit\nOpens ~/.td-code/config.json in $VISUAL/$EDITOR,\nfalling back to the OS opener. Creates a starter file first if missing.',
			)
			return
		}
		if (rest.length) {
			console.error(`unknown flag for config edit: ${rest.join(' ')}\n`)
			console.log('Usage: td-code config edit')
			process.exit(1)
		}
		await editUserConfig()
		return
	}
	if (sub === 'validate') {
		if (rest.includes('--help') || rest.includes('-h')) {
			console.log(
				'Usage: td-code config validate\nParses ~/.td-code/config.json and reports problems without starting the server.',
			)
			return
		}
		if (rest.length) {
			console.error(`unknown flag for config validate: ${rest.join(' ')}\n`)
			console.log('Usage: td-code config validate')
			process.exit(1)
		}
		validateUserConfig()
		return
	}
	console.error(
		sub ? `unknown config subcommand: ${sub}\n` : 'missing config subcommand\n',
	)
	console.log(
		'Usage:\n  td-code config init [--force]\n  td-code config edit\n  td-code config validate\n  td-code config path',
	)
	process.exit(1)
}

/** Open the config in $VISUAL/$EDITOR (waited) or the OS opener (detached). */
async function editUserConfig(): Promise<void> {
	const file = userConfigPath()
	if (!existsSync(file)) {
		try {
			initUserConfig(file, {})
			console.log(`created starter config at ${file}`)
		} catch (e) {
			console.error(e instanceof Error ? e.message : String(e))
			process.exit(1)
		}
	}
	const editor = process.env.VISUAL || process.env.EDITOR
	if (editor) {
		const [bin, ...editorArgs] = splitCommand(editor)
		if (!bin) {
			console.error(`cannot parse $VISUAL/$EDITOR: ${JSON.stringify(editor)}`)
			process.exit(1)
		}
		const code = await runInteractive(bin, [...editorArgs, file])
		if (code !== 0) {
			console.error(`editor exited with code ${code}: ${file}`)
			process.exit(code)
		}
		// Report parse problems right away so a bad edit is caught early.
		const {error} = loadUserConfig(file)
		if (error) {
			console.error(`saved, but the config has a problem:\n  ${error}`)
			process.exit(1)
		}
		console.log(`saved ${file}`)
		return
	}
	// No $EDITOR: hand the file to the OS (Termux/desktop file association).
	try {
		const {spawn} = await import('node:child_process')
		const target =
			process.env.TERMUX_VERSION || existsSync('/data/data/com.termux')
				? (['termux-open', file] as string[])
				: os.platform() === 'darwin'
					? (['open', file] as string[])
					: os.platform() === 'win32'
						? (['cmd', '/c', 'start', '""', file] as string[])
						: (['xdg-open', file] as string[])
		const [bin, ...binArgs] = target as [string, ...string[]]
		const child = spawn(bin, binArgs, {stdio: 'ignore', detached: true})
		child.unref()
		console.log(`opened ${file} (set $EDITOR to edit inside the terminal)`)
	} catch (e) {
		console.error(
			`cannot open ${file}: ${e instanceof Error ? e.message : String(e)}\nSet $EDITOR to your editor and retry.`,
		)
		process.exit(1)
	}
}

/** Split a $VISUAL/$EDITOR string into argv, honouring single/double quotes. */
function splitCommand(cmd: string): string[] {
	const out: string[] = []
	let cur = ''
	let quote: string | null = null
	for (const ch of cmd.trim()) {
		if (quote) {
			if (ch === quote) quote = null
			else cur += ch
		} else if (ch === '"' || ch === "'") {
			quote = ch
		} else if (/\s/.test(ch)) {
			if (cur) {
				out.push(cur)
				cur = ''
			}
		} else {
			cur += ch
		}
	}
	if (cur) out.push(cur)
	return out
}

function runInteractive(bin: string, args: string[]): Promise<number> {
	return import('node:child_process').then(
		({spawn}) =>
			new Promise<number>(resolve => {
				const child = spawn(bin, args, {stdio: 'inherit'})
				child.on('error', () => resolve(127))
				child.on('close', code => resolve(code ?? 1))
			}),
	)
}

/** Parse the config and report problems without starting the server. */
function validateUserConfig(): void {
	const {config, path: file, error} = loadUserConfig()
	console.log(`config: ${file}`)
	if (error) {
		console.error(`invalid: ${error}`)
		process.exit(1)
	}
	if (!existsSync(file)) {
		console.log('no config file — all defaults apply')
		console.log('run `td-code config init` to create a starter file')
		return
	}
	const keys = Object.keys(config).filter(k => k !== 'version')
	if (!keys.length) {
		console.log('valid but empty — all defaults apply')
		return
	}
	console.log('valid:')
	for (const k of keys) {
		if (k === 'workspaces') continue
		console.log(
			`  ${k}: ${formatConfigValue(k, (config as Record<string, unknown>)[k])}`,
		)
	}
	if (config.workspaces) {
		const checked = checkWorkspacePaths(config.workspaces)
		let bad = 0
		for (const w of checked) {
			const label = w.name ? `${w.raw} (name: ${w.name})` : w.raw
			if (!w.exists) {
				console.error(`  workspaces: ${label} -> missing: ${w.resolved}`)
				bad++
			} else if (!w.isDirectory) {
				console.error(
					`  workspaces: ${label} -> not a directory: ${w.resolved}`,
				)
				bad++
			} else {
				console.log(`  workspaces: ${label} -> ${w.resolved}`)
			}
		}
		if (bad) {
			console.error(`${bad} workspace(s) would fail at startup`)
			process.exit(1)
		}
	}
}

/** Render a config value for `validate`, masking secrets. */
function formatConfigValue(key: string, v: unknown): string {
	if (key === 'authToken') return v ? '<set>' : '<unset>'
	if (key === 'pairing' && v && typeof v === 'object' && !Array.isArray(v)) {
		const p = {...(v as Record<string, unknown>)}
		if (typeof p.code === 'string' && p.code) p.code = '<set>'
		return JSON.stringify(p)
	}
	if (v === null) return 'null'
	if (typeof v === 'object') return JSON.stringify(v)
	return JSON.stringify(v) ?? String(v)
}

async function tryOpen(url: string) {
	try {
		const {spawn} = await import('node:child_process')
		const cmds: string[][] = []
		if (process.env.TERMUX_VERSION || existsSync('/data/data/com.termux')) {
			cmds.push(['termux-open-url', url])
		} else if (os.platform() === 'darwin') {
			cmds.push(['open', url])
		} else if (os.platform() === 'win32') {
			cmds.push(['cmd', '/c', 'start', '""', url])
		} else {
			cmds.push(['xdg-open', url])
		}
		for (const [bin, ...args] of cmds) {
			try {
				const child = spawn(bin as string, args, {
					stdio: 'ignore',
					detached: true,
				})
				child.unref()
				return
			} catch {
				continue
			}
		}
	} catch {
		/* ignore */
	}
}

/** Levenshtein distance, for "did you mean" suggestions. */
function editDistance(a: string, b: string): number {
	const m = a.length
	const n = b.length
	if (m === 0) return n
	if (n === 0) return m
	let prev: number[] = Array.from({length: n + 1}, (_, j) => j)
	for (let i = 1; i <= m; i++) {
		const cur: number[] = [i]
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1
			cur[j] = Math.min(
				(prev[j] ?? 0) + 1,
				(cur[j - 1] ?? 0) + 1,
				(prev[j - 1] ?? 0) + cost,
			)
		}
		prev = cur
	}
	return prev[n] ?? 0
}

const KNOWN_SUBCOMMANDS = ['config', 'completion'] as const

/**
 * If the first CLI word looks like a mistyped subcommand (and is not an
 * existing path), exit with a suggestion instead of "directory not found".
 * Paths containing /, \, ~ or . are never treated as typos.
 */
function suggestSubcommand(first: string | undefined): void {
	if (!first || first.startsWith('-')) return
	if (/[/\\~.]/.test(first)) return
	if (existsSync(first)) return
	let best: string | null = null
	let bestDist = Infinity
	for (const c of KNOWN_SUBCOMMANDS) {
		const d = editDistance(first.toLowerCase(), c)
		if (d < bestDist) {
			bestDist = d
			best = c
		}
	}
	const threshold = Math.max(
		1,
		Math.floor(Math.max(first.length, best?.length ?? 0) / 3),
	)
	if (best !== null && bestDist <= threshold) {
		console.error(
			`unknown command: ${first}\ndid you mean: td-code ${best} ?\n`,
		)
		process.exit(1)
	}
}

async function main() {
	const rawArgv = process.argv.slice(2)

	// Subcommands run before normal startup (no server, no config load needed
	// beyond the target path).
	if (rawArgv[0] === 'config') {
		await handleConfigCommand(rawArgv.slice(1))
		return
	}
	if (rawArgv[0] === 'completion') {
		await handleCompletionCommand(rawArgv.slice(1))
		return
	}
	// A bare word that is neither a subcommand, a flag, nor an existing path
	// is almost always a typo (`completions` for `completion`). Suggest instead
	// of the confusing "directory not found".
	suggestSubcommand(rawArgv[0])

	const args = parseArgs(rawArgv)

	// Optional user config; a broken file is reported but never fatal.
	const {config, path: configPath, error: configError} = loadUserConfig()
	if (configError)
		console.warn(`[td-code] ignoring ${configPath}: ${configError}`)
	else if (Object.keys(config).length) {
		console.log(`[td-code] using config ${configPath}`)
	}

	// Multi-root resolution: CLI dirs > TD_CODE_WORKSPACES > config > cwd.
	// parseArgs no longer defaults dirs to ['.'] so we can tell explicit CLI
	// input apart from "nothing given".
	const envWorkspaces = parseEnvWorkspaces()
	const configWorkspaces = config.workspaces
		? resolveConfigWorkspaces(config.workspaces)
		: []
	let dirInputs: string[]
	let dirSource: string
	if (args.dirs.length > 0) {
		dirInputs = args.dirs
		dirSource = 'cli'
	} else if (envWorkspaces.length > 0) {
		dirInputs = envWorkspaces.map(w => w.path)
		dirSource = 'TD_CODE_WORKSPACES'
	} else if (configWorkspaces.length > 0) {
		dirInputs = configWorkspaces.map(w => w.path)
		dirSource = `config ${configPath}`
	} else {
		dirInputs = ['.']
		dirSource = 'cwd'
	}
	if (dirSource !== 'cli' && dirInputs.length > 1) {
		console.log(`[td-code] using workspaces from ${dirSource}`)
	}

	const rootDirs = dirInputs.map(d =>
		path.resolve(process.cwd(), d.replace(/^~/, os.homedir())),
	)

	for (const rootDir of rootDirs) {
		if (!existsSync(rootDir)) {
			console.error(`directory not found: ${rootDir}`)
			process.exit(1)
		}
		const st = statSync(rootDir)
		if (!st.isDirectory()) {
			console.error(`not a directory: ${rootDir}`)
			process.exit(1)
		}
	}

	// defaults < config file < CLI flags < TD_CODE_* env vars
	const port = Number(
		process.env.TD_CODE_PORT ?? args.port ?? config.port ?? DEFAULT_PORT,
	)
	const host =
		process.env.TD_CODE_HOST ?? args.host ?? config.host ?? DEFAULT_HOST

	// auth: explicit --no-auth or config "auth": false disables it entirely.
	const envToken = process.env.TD_CODE_TOKEN
	const envNoAuth =
		process.env.TD_CODE_AUTH === '0' || process.env.TD_CODE_NO_AUTH === '1'
	const authOff =
		envToken === undefined &&
		(envNoAuth || args.noAuth || config.auth === false)
	let token: string | null = null
	if (!authOff) {
		token =
			envToken ??
			args.authToken ??
			config.authToken ??
			randomBytes(16).toString('hex').slice(0, 24)
	}

	// pairing: a short, typeable code accepted alongside the token
	const fixedCode = args.pairingCode ?? config.pairing?.code ?? null
	const pairingOn =
		fixedCode !== null || args.pairing || config.pairing?.enabled === true
	// A pairing code is meaningless without auth to protect, so it implies auth on.
	const pairingCode =
		pairingOn && token !== null
			? (fixedCode ?? generatePairingCode(config.pairing?.length ?? 6))
			: null

	await startServer({
		rootDirs,
		port,
		host,
		authToken: token,
		pairingCode,
		noWatch: args.noWatch || config.watch === false,
		noTerms: args.noTerms || config.terms === false,
		version: VERSION,
	})

	if (args.open || config.open) {
		const base = `http://localhost:${port}/`
		await tryOpen(token ? `${base}?token=${token}` : base)
		void lanIps
	}
}

main().catch(err => {
	console.error('[td-code] failed to start:', err)
	process.exit(1)
})
