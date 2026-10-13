#!/usr/bin/env node
import {randomBytes} from 'node:crypto'
import {existsSync, statSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {lanIps, startServer} from './server.ts'

const VERSION = '0.1.0'
const DEFAULT_PORT = 4444
const DEFAULT_HOST = '0.0.0.0'

function help() {
	console.log(`td-code v${VERSION} - minimal VSCode-like editor for Termux

Usage:
  td-code [dir...] [options]

Arguments:
  dir...                 directories to serve (default: .)

Options:
  -p, --port <n>         port to listen on (default: ${DEFAULT_PORT})
  --host <addr>          host to bind (default: ${DEFAULT_HOST})
  --no-auth              disable token auth (default: enabled with random token)
  --auth-token <token>   use a fixed token instead of generating one
  --no-watch             disable file watcher broadcasts
  --no-terms             disable the terminal (shell) feature
  --open                 try to open the browser (termux-open-url / xdg-open / open)
  -h, --help             show this help
  -v, --version          show version

Examples:
  td-code .                       # serve cwd on 0.0.0.0:4444 with token
  td-code ~/myproj -p 8080 --no-auth
  td-code . --host 127.0.0.1 --auth-token secret --open
  td-code project1 project2       # serve multiple directories (multi-root workspace)

In another Termux session run e.g. opencode, then open its URL
in the Browser tab (default quick-link http://localhost:4096).
`)
}

interface Args {
	dirs: string[]
	port: number
	host: string
	noAuth: boolean
	authToken: string | null
	noWatch: boolean
	noTerms: boolean
	open: boolean
}

function parseArgs(argv: string[]): Args {
	const out: Args = {
		dirs: [],
		port: DEFAULT_PORT,
		host: DEFAULT_HOST,
		noAuth: false,
		authToken: null,
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
	if (out.dirs.length === 0) out.dirs = ['.']
	return out
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
	const args = parseArgs(process.argv.slice(2))
	const rootDirs = args.dirs.map(d =>
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

	let token: string | null = null
	if (!args.noAuth) {
		token = args.authToken ?? randomBytes(16).toString('hex').slice(0, 24)
	}

	// env overrides (useful in Termux): TD_CODE_PORT / TD_CODE_HOST / TD_CODE_TOKEN
	const port = Number(process.env.TD_CODE_PORT ?? args.port)
	const host = process.env.TD_CODE_HOST ?? args.host
	const envToken = process.env.TD_CODE_TOKEN
	if (envToken) token = envToken
	if (args.noAuth && !envToken) token = null

	await startServer({
		rootDirs,
		port,
		host,
		authToken: token,
		noWatch: args.noWatch,
		noTerms: args.noTerms,
		version: VERSION,
	})

	if (args.open) {
		const base = `http://localhost:${port}/`
		await tryOpen(token ? `${base}?token=${token}` : base)
		void lanIps
	}
}

main().catch(err => {
	console.error('[td-code] failed to start:', err)
	process.exit(1)
})
