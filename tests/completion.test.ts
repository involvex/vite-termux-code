import {describe, expect, test} from 'bun:test'
import {spawnSync} from 'node:child_process'
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {
	bashCompletionScript,
	bashRcBlock,
	installBashCompletion,
	isCompletionShell,
	SUPPORTED_COMPLETION_SHELLS,
} from '../server/completion.ts'

const REPO_ROOT = join(import.meta.dir, '..')

describe('isCompletionShell', () => {
	test('accepts bash, rejects the rest', () => {
		expect(isCompletionShell('bash')).toBe(true)
		expect(isCompletionShell('zsh')).toBe(false)
		expect(isCompletionShell('fish')).toBe(false)
		expect(isCompletionShell('')).toBe(false)
		expect(SUPPORTED_COMPLETION_SHELLS).toContain('bash')
	})
})

describe('bashCompletionScript', () => {
	const script = bashCompletionScript()

	test('ends with a trailing newline (safe for tee/concat)', () => {
		expect(script.endsWith('\n')).toBe(true)
	})

	test('registers the completer for td-code', () => {
		expect(script).toContain('complete -F _td_code -o default td-code')
	})

	test('completes top-level flags', () => {
		for (const flag of ['--port', '--host', '--no-auth', '--pairing-code']) {
			expect(script).toContain(flag)
		}
	})

	test('completes subcommands and config subcommands', () => {
		expect(script).toContain('config completion')
		expect(script).toContain('init edit validate path')
	})

	test('completes config init flags', () => {
		expect(script).toContain('--force -f')
	})

	test('completes directories, not files', () => {
		expect(script).toContain('compgen -d')
		expect(script).not.toContain('compgen -f')
	})

	test('completes common --host values', () => {
		expect(script).toContain('127.0.0.1 0.0.0.0 localhost')
	})
})

describe('td-code completion (CLI dispatch)', () => {
	function run(...args: string[]) {
		const r = spawnSync('bun', [join(REPO_ROOT, 'server', 'cli.ts'), ...args], {
			cwd: REPO_ROOT,
			encoding: 'utf8',
		})
		return {
			status: r.status ?? -1,
			out: String(r.stdout ?? ''),
			err: String(r.stderr ?? ''),
		}
	}

	test('completion bash prints the script', () => {
		const r = run('completion', 'bash')
		expect(r.status).toBe(0)
		expect(r.out).toContain('complete -F _td_code -o default td-code')
		expect(r.out.endsWith('\n')).toBe(true)
	})

	test('unsupported shells fail with the supported list', () => {
		for (const shell of ['zsh', 'fish', 'powershell']) {
			const r = run('completion', shell)
			expect(r.status).toBe(1)
			expect(r.err).toContain(`unsupported shell: ${shell}`)
			expect(r.err).toContain('bash')
		}
	})

	test('missing shell and --help show usage without failing', () => {
		const missing = run('completion')
		expect(missing.status).toBe(0)
		expect(missing.out).toContain('Usage: td-code completion bash')
		const help = run('completion', '--help')
		expect(help.status).toBe(0)
		expect(help.out).toContain('Usage: td-code completion bash')
	})
})

describe('installBashCompletion', () => {
	function tempHome(): string {
		return mkdtempSync(join(tmpdir(), 'td-code-install-'))
	}

	test('writes the script and sources it from .bashrc', () => {
		const home = tempHome()
		try {
			const r = installBashCompletion({home})
			expect(r.completionFile).toBe(join(home, '.td-code', 'completion.bash'))
			expect(r.rcFile).toBe(join(home, '.bashrc'))
			expect(r.rcUpdated).toBe(true)
			expect(readFileSync(r.completionFile, 'utf8')).toBe(
				bashCompletionScript(),
			)
			expect(readFileSync(r.rcFile, 'utf8')).toContain(
				'source "$HOME/.td-code/completion.bash"',
			)
		} finally {
			rmSync(home, {recursive: true, force: true})
		}
	})

	test('second run is a no-op for the rc file but refreshes the script', () => {
		const home = tempHome()
		try {
			installBashCompletion({home})
			const rcFile = join(home, '.bashrc')
			writeFileSync(join(home, '.td-code', 'completion.bash'), 'stale', 'utf8')
			const second = installBashCompletion({home})
			expect(second.rcUpdated).toBe(false)
			expect(readFileSync(second.completionFile, 'utf8')).toBe(
				bashCompletionScript(),
			)
			const occurrences =
				readFileSync(rcFile, 'utf8').split('# td-code completion').length - 1
			expect(occurrences).toBe(1)
		} finally {
			rmSync(home, {recursive: true, force: true})
		}
	})

	test('preserves existing rc content and trailing newline handling', () => {
		const home = tempHome()
		try {
			const rcFile = join(home, '.bashrc')
			writeFileSync(rcFile, 'export FOO=1', 'utf8') // no trailing newline
			const r = installBashCompletion({home, rcFile})
			expect(r.rcUpdated).toBe(true)
			const rc = readFileSync(rcFile, 'utf8')
			expect(rc.startsWith('export FOO=1\n')).toBe(true)
			expect(rc).toContain(bashRcBlock().trim())
		} finally {
			rmSync(home, {recursive: true, force: true})
		}
	})
})

describe('td-code completion --install (CLI dispatch)', () => {
	function runWithHome(args: string[], home: string) {
		const r = spawnSync('bun', [join(REPO_ROOT, 'server', 'cli.ts'), ...args], {
			cwd: REPO_ROOT,
			env: {...process.env, HOME: home, USERPROFILE: home},
			encoding: 'utf8',
		})
		return {
			status: r.status ?? -1,
			out: String(r.stdout ?? ''),
			err: String(r.stderr ?? ''),
		}
	}

	test('--install writes the script and rc entry', () => {
		const home = mkdtempSync(join(tmpdir(), 'td-code-cli-install-'))
		try {
			const r = runWithHome(['completion', 'bash', '--install'], home)
			expect(r.status).toBe(0)
			expect(r.out).toContain('completion.bash')
			expect(r.out).toContain('source')
			expect(existsSync(join(home, '.td-code', 'completion.bash'))).toBe(true)
			expect(readFileSync(join(home, '.bashrc'), 'utf8')).toContain(
				'# td-code completion',
			)
			const again = runWithHome(['completion', 'bash', '--install'], home)
			expect(again.status).toBe(0)
			expect(again.out).toContain('already sourced')
		} finally {
			rmSync(home, {recursive: true, force: true})
		}
	})

	test('--target overrides the rc file', () => {
		const home = mkdtempSync(join(tmpdir(), 'td-code-cli-target-'))
		try {
			const target = join(home, 'myrc')
			const r = runWithHome(
				['completion', 'bash', '--install', '--target', target],
				home,
			)
			expect(r.status).toBe(0)
			expect(existsSync(target)).toBe(true)
			expect(existsSync(join(home, '.bashrc'))).toBe(false)
		} finally {
			rmSync(home, {recursive: true, force: true})
		}
	})

	test('--target without --install fails', () => {
		const home = mkdtempSync(join(tmpdir(), 'td-code-cli-notarget-'))
		try {
			const r = runWithHome(
				['completion', 'bash', '--target', join(home, 'myrc')],
				home,
			)
			expect(r.status).toBe(1)
			expect(r.err).toContain('--target needs --install')
		} finally {
			rmSync(home, {recursive: true, force: true})
		}
	})
})

describe('subcommand typo suggestions (CLI dispatch)', () => {
	function runIn(dir: string, ...args: string[]) {
		const r = spawnSync('bun', [join(REPO_ROOT, 'server', 'cli.ts'), ...args], {
			cwd: dir,
			encoding: 'utf8',
		})
		return {
			status: r.status ?? -1,
			out: String(r.stdout ?? ''),
			err: String(r.stderr ?? ''),
		}
	}

	test('`completions` suggests `completion`', () => {
		const dir = mkdtempSync(join(tmpdir(), 'td-code-typo-'))
		try {
			const r = runIn(dir, 'completions', 'bash')
			expect(r.status).toBe(1)
			expect(r.err).toContain('did you mean: td-code completion')
		} finally {
			rmSync(dir, {recursive: true, force: true})
		}
	})

	test('an existing directory named like a typo is still served, not hijacked', () => {
		const dir = mkdtempSync(join(tmpdir(), 'td-code-typo-'))
		try {
			writeFileSync(join(dir, 'completions'), 'not a dir', 'utf8')
			const r = runIn(dir, 'completions', '--port', '1', '--host', '127.0.0.1')
			expect(r.status).toBe(1)
			expect(r.err).toContain('not a directory')
			expect(r.err).not.toContain('did you mean')
		} finally {
			rmSync(dir, {recursive: true, force: true})
		}
	})

	test('unrelated missing dirs keep the old error without suggestions', () => {
		const dir = mkdtempSync(join(tmpdir(), 'td-code-typo-'))
		try {
			const r = runIn(dir, 'definitely-not-a-dir-xyz')
			expect(r.status).toBe(1)
			expect(r.err).toContain('directory not found')
			expect(r.err).not.toContain('did you mean')
		} finally {
			rmSync(dir, {recursive: true, force: true})
		}
	})
})
