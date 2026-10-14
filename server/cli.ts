#!/usr/bin/env node
import {randomBytes} from 'node:crypto'
import {existsSync, statSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
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
  td-code config path             print the config file path

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

function handleConfigCommand(argv: string[]): void {
	const [sub, ...rest] = argv
	if (sub === 'path') {
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
	console.error(
		sub ? `unknown config subcommand: ${sub}\n` : 'missing config subcommand\n',
	)
	console.log('Usage:\n  td-code config init [--force]\n  td-code config path')
	process.exit(1)
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

async function main() {
	const rawArgv = process.argv.slice(2)

	// Subcommands run before normal startup (no server, no config load needed
	// beyond the target path).
	if (rawArgv[0] === 'config') {
		handleConfigCommand(rawArgv.slice(1))
		return
	}

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
