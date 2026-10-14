#!/usr/bin/env bun
/**
 * td-code headless smoke test.
 *
 * Boots the built app, drives it with a real headless Chrome/Edge over the
 * DevTools protocol, and asserts the critical path still works:
 *
 *   1. app boots, no uncaught exceptions
 *   2. Explorer lists files
 *   3. clicking a file mounts the CodeMirror editor (regression guard for
 *      "Editor failed to load" — a CodeMirror state error used to surface
 *      there with a bogus network message)
 *   4. the breakpoint gutter toggles a breakpoint and it persists
 *   5. the terminal drawer starts a real PTY session
 *   6. no "failed to load" pane anywhere
 *
 * Usage:
 *   bun run smoke                    # builds nothing, requires dist/ to exist
 *   bun run smoke -- --url=http://127.0.0.1:4444   # test a running server
 *   bun run smoke -- --dir=../other  # serve a different directory
 *   bun run smoke -- --browser=/path/to/chrome
 *   bun run smoke -- --keep          # leave the browser open on failure
 *
 * Exit code 0 = all checks passed, 1 = at least one failed.
 */
import {spawn, type ChildProcess} from 'node:child_process'
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs'
import net from 'node:net'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

interface Options {
	url: string | null
	dir: string
	browser: string | null
	keep: boolean
	timeoutMs: number
}

const argv = process.argv.slice(2)
const flag = (name: string): string | null => {
	const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))
	if (!hit) return null
	return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : 'true'
}

const opts: Options = {
	url: flag('url'),
	dir: flag('dir') ?? process.cwd(),
	browser: flag('browser') ?? process.env.TD_CODE_SMOKE_BROWSER ?? null,
	keep: flag('keep') !== null,
	timeoutMs: Number(flag('timeout') ?? 15000),
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function freePort(): Promise<number> {
	return new Promise((res, rej) => {
		const srv = net.createServer()
		srv.on('error', rej)
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address()
			const port = typeof addr === 'object' && addr ? addr.port : 0
			srv.close(() => res(port))
		})
	})
}

async function waitFor(fn: () => Promise<boolean>, ms: number, what: string) {
	const deadline = Date.now() + ms
	while (Date.now() < deadline) {
		if (await fn()) return true
		await sleep(150)
	}
	throw new Error(`timed out after ${ms}ms waiting for ${what}`)
}

/** Like waitFor, but yields the value the poll function found. */
async function waitForValue<T>(
	fn: () => Promise<T | null>,
	ms: number,
	what: string,
): Promise<T | null> {
	const deadline = Date.now() + ms
	while (Date.now() < deadline) {
		const v = await fn()
		if (v !== null) return v
		await sleep(150)
	}
	throw new Error(`timed out after ${ms}ms waiting for ${what}`)
}

// ---------------------------------------------------------------- browser ---

const BROWSERS_WINDOWS = [
	'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
	'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
	'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
	'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const BROWSERS_UNIX = [
	'/usr/bin/google-chrome',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
]

function findBrowser(): string {
	if (opts.browser) {
		if (!existsSync(opts.browser))
			throw new Error(`browser not found: ${opts.browser}`)
		return opts.browser
	}
	const candidates =
		process.platform === 'win32' ? BROWSERS_WINDOWS : BROWSERS_UNIX
	const found = candidates.find(p => existsSync(p))
	if (!found) {
		throw new Error(
			`no Chrome/Edge found. Install one or pass --browser=<path>\ntried:\n  ${candidates.join('\n  ')}`,
		)
	}
	return found
}

let browserProc: ChildProcess | null = null
let profileDir = ''

async function launchBrowser(bin: string): Promise<string> {
	profileDir = mkdtempSync(join(tmpdir(), 'td-code-smoke-'))
	// In containers/CI the Chrome sandbox is unavailable (no user namespaces) and
	// /dev/shm is tiny, so relax those two only where it's actually needed.
	const isCI = process.env.CI === 'true' || process.env.CI === '1'
	const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
	const containerFlags =
		isCI || isRoot ? ['--no-sandbox', '--disable-dev-shm-usage'] : []
	browserProc = spawn(
		bin,
		[
			'--headless=new',
			'--remote-debugging-port=0',
			'--no-first-run',
			'--no-default-browser-check',
			'--disable-extensions',
			'--disable-gpu',
			'--disable-background-networking',
			...containerFlags,
			`--user-data-dir=${profileDir}`,
			'about:blank',
		],
		{stdio: 'ignore'},
	)
	const portFile = join(profileDir, 'DevToolsActivePort')
	await waitFor(
		async () => existsSync(portFile),
		20000,
		'browser devtools port file',
	)
	const raw = readFileSync(portFile, 'utf8')
	const devtoolsPort = Number(raw.split(/\r?\n/)[0])
	if (!Number.isFinite(devtoolsPort)) throw new Error('bad DevToolsActivePort')
	return `http://127.0.0.1:${devtoolsPort}`
}

async function closeBrowser() {
	if (!browserProc) return
	try {
		browserProc.kill()
	} catch {
		/* ignore */
	}
	if (opts.keep) {
		console.log(
			`\n[smoke] --keep: browser left running, profile at ${profileDir}`,
		)
		browserProc = null
		return
	}
	if (profileDir) {
		try {
			rmSync(profileDir, {recursive: true, force: true})
		} catch {
			/* ignore */
		}
	}
	browserProc = null
}

// -------------------------------------------------------------------- cdp ---

interface Cdp {
	send: (method: string, params?: unknown) => Promise<any>
	evaluate: <T = any>(expression: string) => Promise<T>
	exceptions: string[]
	consoleErrors: string[]
	close: () => void
}

async function connect(wsUrl: string): Promise<Cdp> {
	const ws = new WebSocket(wsUrl)
	const pending = new Map<number, (v: any) => void>()
	const exceptions: string[] = []
	const consoleErrors: string[] = []
	let id = 0

	ws.onmessage = ev => {
		const msg = JSON.parse(ev.data as string)
		if (msg.id && pending.has(msg.id)) {
			pending.get(msg.id)!(msg)
			pending.delete(msg.id)
			return
		}
		if (msg.method === 'Runtime.exceptionThrown') {
			const d = msg.params.exceptionDetails
			exceptions.push(
				`${d.text} ${d.exception?.description ?? d.exception?.value ?? ''}`.trim(),
			)
		}
		if (
			msg.method === 'Runtime.consoleAPICalled' &&
			msg.params.type === 'error'
		) {
			consoleErrors.push(
				(msg.params.args ?? [])
					.map((a: any) => a.value ?? a.description ?? '?')
					.join(' '),
			)
		}
		if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
			const e = msg.params.entry
			// favicon / manifest noise in headless is not a smoke failure
			if (!/favicon|manifest/i.test(`${e.text} ${e.url ?? ''}`)) {
				consoleErrors.push(`${e.text} ${e.url ?? ''}`.trim())
			}
		}
	}

	const send = (method: string, params: unknown = {}) =>
		new Promise<any>(resolve => {
			const myId = ++id
			pending.set(myId, (m: any) => resolve(m.result ?? m.error))
			ws.send(JSON.stringify({id: myId, method, params}))
		})

	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve()
		ws.onerror = () => reject(new Error('CDP websocket failed'))
	})
	await send('Runtime.enable')
	await send('Log.enable')
	await send('Page.enable')

	const evaluate = async <T>(expression: string): Promise<T> => {
		const r = await send('Runtime.evaluate', {
			expression,
			returnByValue: true,
			awaitPromise: true,
		})
		if (r.exceptionDetails) {
			throw new Error(
				`page evaluate failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
			)
		}
		return r.result.value as T
	}

	return {send, evaluate, exceptions, consoleErrors, close: () => ws.close()}
}

// ----------------------------------------------------------------- checks ---

interface Check {
	name: string
	ok: boolean
	detail?: string
}
const checks: Check[] = []
const record = (name: string, ok: boolean, detail?: string) => {
	checks.push({name, ok, detail})
	console.log(
		`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`,
	)
}

// ------------------------------------------------------------------- main ---

let serverProc: ChildProcess | null = null

async function main() {
	const bin = findBrowser()
	let url = opts.url

	if (!url) {
		const cli = resolve(process.cwd(), 'dist/cli.js')
		if (!existsSync(cli)) {
			console.error('[smoke] dist/cli.js missing — run `bun run build` first.')
			process.exit(1)
		}
		const port = await freePort()
		url = `http://127.0.0.1:${port}/`
		serverProc = spawn(
			'bun',
			[
				cli,
				opts.dir,
				'--port',
				String(port),
				'--host',
				'127.0.0.1',
				'--no-auth',
			],
			{stdio: 'ignore'},
		)
		await waitFor(
			async () => {
				try {
					const r = await fetch(new URL('/api/health', url))
					return r.ok
				} catch {
					return false
				}
			},
			20000,
			'td-code server',
		)
	}

	console.log(`[smoke] browser: ${bin}`)
	console.log(`[smoke] url:     ${url}`)

	const devtools = await launchBrowser(bin)
	const targets = await (await fetch(`${devtools}/json/list`)).json()
	const page = (targets as any[]).find(t => t.type === 'page')
	if (!page) throw new Error('no page target in headless browser')
	const cdp = await connect(page.webSocketDebuggerUrl)

	await cdp.send('Page.navigate', {url})

	// 1. boot
	try {
		await waitFor(
			async () =>
				(await cdp.evaluate<boolean>(
					`!!document.querySelector('.statusbar') && !!document.querySelector('.activitybar')`,
				)) === true,
			opts.timeoutMs,
			'app shell',
		)
		record('app boots (shell + statusbar)', true)
	} catch (e) {
		record('app boots (shell + statusbar)', false, (e as Error).message)
		throw e
	}

	// 2. explorer lists files
	const FIRST_FILE_JS = `(() => {
		const rows = Array.from(document.querySelectorAll('.tree-row'));
		const hit = rows.find(r => /\\.(md|txt|ts|tsx|json|js|html|css)$/i
			.test(r.querySelector('.tree-name')?.textContent || ''));
		return hit ? hit.querySelector('.tree-name').textContent : null;
	})()`
	let fileRow: string | null = null
	try {
		fileRow = await waitForValue(
			() => cdp.evaluate<string | null>(FIRST_FILE_JS),
			opts.timeoutMs,
			'explorer file rows',
		)
	} catch {
		fileRow = null
	}
	record('explorer lists files', Boolean(fileRow), fileRow ?? 'no file rows')

	// 3. click the file -> CodeMirror mounts
	if (fileRow) {
		await cdp.evaluate(`(() => {
			const rows = Array.from(document.querySelectorAll('.tree-row'));
			const hit = rows.find(r => /\\.(md|txt|ts|tsx|json|js|html|css)$/i
				.test(r.querySelector('.tree-name')?.textContent || ''));
			hit?.click();
			return true;
		})()`)
		let mounted = false
		try {
			await waitFor(
				async () =>
					(await cdp.evaluate<boolean>(
						`!!document.querySelector('.cm-host .cm-editor .cm-content')`,
					)) === true,
				opts.timeoutMs,
				'CodeMirror mount',
			)
			mounted = true
		} catch {
			mounted = false
		}
		const hasContent = await cdp.evaluate<boolean>(
			`(document.querySelector('.cm-content')?.textContent ?? '').length > 20`,
		)
		record('clicking a file mounts the editor', mounted)
		record('editor renders document text', hasContent)

		// 4. breakpoint gutter round-trip
		const bpResult = await cdp.evaluate<string>(`(async () => {
			const line = document.querySelector('.bp-gutter .cm-gutterElement');
			if (!line) return 'no gutter';
			const r = line.getBoundingClientRect();
			line.dispatchEvent(new MouseEvent('mousedown', {
				bubbles: true, cancelable: true,
				clientX: r.left + 2, clientY: r.top + Math.min(4, r.height / 2)
			}));
			await new Promise(r => setTimeout(r, 400));
			const dot = !!document.querySelector('.bp-gutter .bp-dot');
			const stored = localStorage.getItem('td-code-breakpoints-v1') || '';
			return JSON.stringify({dot, storedLines: stored.length});
		})()`)
		const bp = JSON.parse(bpResult ?? '{}') as {
			dot?: boolean
			storedLines?: number
		}
		record(
			'breakpoint gutter toggles a breakpoint',
			bp.dot === true,
			bpResult ?? '',
		)
		record('breakpoint persists to localStorage', (bp.storedLines ?? 0) > 2)
	}

	// 5. terminal drawer starts a PTY
	await cdp.evaluate(`(() => {
		const btn = Array.from(document.querySelectorAll('.act'))
			.find(b => (b.getAttribute('title') || '').includes('Terminal'));
		btn?.click();
		return true;
	})()`)
	let term = false
	try {
		await waitFor(
			async () =>
				(await cdp.evaluate<boolean>(
					`!!document.querySelector('.xterm-screen')`,
				)) === true,
			opts.timeoutMs,
			'xterm screen',
		)
		term = true
	} catch {
		term = false
	}
	record('terminal drawer opens an xterm session', term)

	// 6. bundled example extension: install, then run its command from the palette
	//    (covers the whole extension path: manifest fetch, module import,
	//     activate(), registerCommand(), palette wiring, on-demand activation)
	const manifestUrl = `${new URL(url).origin}/extensions/hello-world/package.json`
	await cdp.evaluate(`(() => {
		Array.from(document.querySelectorAll('.act'))
			.find(b => (b.getAttribute('title') || '') === 'Extensions')
			?.click();
		return true;
	})()`)
	let installed = false
	try {
		await waitFor(
			async () =>
				(await cdp.evaluate<boolean>(
					`!!Array.from(document.querySelectorAll('input')).find(i => (i.placeholder || '').includes('GitHub URL'))`,
				)) === true,
			opts.timeoutMs,
			'extensions panel install box',
		)
		await cdp.evaluate(`(() => {
			const inp = Array.from(document.querySelectorAll('input'))
				.find(i => (i.placeholder || '').includes('GitHub URL'));
			const setter = Object.getOwnPropertyDescriptor(
				window.HTMLInputElement.prototype, 'value').set;
			setter.call(inp, ${JSON.stringify(manifestUrl)});
			inp.dispatchEvent(new Event('input', {bubbles: true}));
			Array.from(document.querySelectorAll('button'))
				.find(b => (b.getAttribute('title') || '') === 'Install from URL')
				?.click();
			return true;
		})()`)
		await waitFor(
			async () =>
				(await cdp.evaluate<boolean>(
					`!!Array.from(document.querySelectorAll('.extension-item')).find(i => /Hello World/.test(i.textContent || ''))`,
				)) === true,
			opts.timeoutMs,
			'installed extension card',
		)
		installed = true
	} catch {
		installed = false
	}
	record('bundled example extension installs', installed, manifestUrl)

	let ranCommand = false
	if (installed) {
		await cdp.evaluate(`(() => {
			Array.from(document.querySelectorAll('.act'))
				.find(b => (b.getAttribute('title') || '').includes('Command Palette'))
				?.click();
			return true;
		})()`)
		await waitFor(
			async () =>
				(await cdp.evaluate<boolean>(
					`!!document.querySelector('.palette-input')`,
				)) === true,
			opts.timeoutMs,
			'command palette input',
		)
		await cdp.evaluate(`(() => {
			const inp = document.querySelector('.palette-input');
			const setter = Object.getOwnPropertyDescriptor(
				window.HTMLInputElement.prototype, 'value').set;
			setter.call(inp, 'say hi');
			inp.dispatchEvent(new Event('input', {bubbles: true}));
			return true;
		})()`)
		const listed = await waitFor(
			async () =>
				(await cdp.evaluate<boolean>(
					`!!Array.from(document.querySelectorAll('.palette-item')).find(i => /Say Hi/.test(i.textContent || ''))`,
				)) === true,
			opts.timeoutMs,
			'extension command in palette',
		)
		record('extension command appears in the palette', listed)
		if (listed) {
			await cdp.evaluate(`(() => {
				Array.from(document.querySelectorAll('.palette-item'))
					.find(i => /Say Hi/.test(i.textContent || ''))
					?.click();
				return true;
			})()`)
			try {
				await waitFor(
					async () =>
						(await cdp.evaluate<boolean>(
							`/td-code\\.hello-world/.test(document.querySelector('.statusbar')?.innerText || '')`,
						)) === true,
					opts.timeoutMs,
					'extension command output',
				)
				ranCommand = true
			} catch {
				ranCommand = false
			}
		}
		record('extension command runs from the palette', ranCommand)
	}

	// 7. no failed-pane text anywhere
	const failedText = await cdp.evaluate<string | null>(`(() => {
		const el = document.querySelector('.pane-failure');
		return el ? el.innerText.slice(0, 400) : null;
	})()`)
	record(
		'no pane-failure UI visible',
		failedText === null,
		failedText ?? undefined,
	)

	// 7. error hygiene
	record(
		'no uncaught exceptions',
		cdp.exceptions.length === 0,
		cdp.exceptions.slice(0, 3).join(' | '),
	)
	record(
		'no console errors',
		cdp.consoleErrors.length === 0,
		cdp.consoleErrors.slice(0, 3).join(' | '),
	)

	cdp.close()
}

let exitCode = 0
try {
	await main()
} catch (e) {
	console.error(`\n[smoke] aborted: ${(e as Error).message}`)
	record('smoke run completed', false, (e as Error).message)
}

const failed = checks.filter(c => !c.ok)
console.log(
	`\n[smoke] ${checks.length - failed.length}/${checks.length} checks passed`,
)
if (failed.length) {
	console.log('[smoke] failures:')
	for (const f of failed)
		console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`)
	exitCode = 1
}

try {
	serverProc?.kill()
} catch {
	/* ignore */
}
await closeBrowser()
process.exit(exitCode)
