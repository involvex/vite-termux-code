import {describe, expect, test} from 'bun:test'
import {spawnSync} from 'node:child_process'
import {join} from 'node:path'
import {
	bashCompletionScript,
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
