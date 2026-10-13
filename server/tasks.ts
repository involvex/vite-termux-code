import {promises as fs} from 'node:fs'
import path from 'node:path'
import {findOnPath} from './paths.ts'

export interface TaskDef {
	id: string
	label: string
	kind: 'bun' | 'npm' | 'make'
	script: string
	command: string
	detail?: string
}

export interface TaskRunners {
	bun: string | null
	npm: string | null
	make: string | null
}

export function detectRunners(): TaskRunners {
	return {
		bun: findOnPath('bun'),
		npm: findOnPath('npm'),
		make: findOnPath('make'),
	}
}

async function readPackageScripts(
	rootDir: string,
): Promise<Record<string, string>> {
	try {
		const raw = await fs.readFile(path.join(rootDir, 'package.json'), 'utf-8')
		const pkg = JSON.parse(raw) as {scripts?: Record<string, string>}
		if (pkg.scripts && typeof pkg.scripts === 'object') {
			const out: Record<string, string> = {}
			for (const [k, v] of Object.entries(pkg.scripts)) {
				if (typeof v === 'string') out[k] = v
			}
			return out
		}
	} catch {
		/* no package.json or invalid -> no tasks */
	}
	return {}
}

/** Parse explicit Makefile targets (Makefile, makefile, GNUmakefile). */
async function readMakeTargets(rootDir: string): Promise<string[]> {
	for (const name of ['Makefile', 'makefile', 'GNUmakefile']) {
		try {
			const raw = await fs.readFile(path.join(rootDir, name), 'utf-8')
			const seen = new Set<string>()
			for (const line of raw.split('\n')) {
				// target lines start at column 0; skip pattern rules (%),
				// dot-targets (.PHONY) and variable assignments (:=, ::=, =)
				const m = line.match(/^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/)
				if (!m) continue
				const target = m[1] as string
				if (target.includes('%') || target.startsWith('.')) continue
				seen.add(target)
				if (seen.size >= 50) break
			}
			return [...seen]
		} catch {
			/* try next name */
		}
	}
	return []
}

/** List bun/npm tasks from package.json scripts plus Makefile targets. */
export async function listTasks(rootDir: string): Promise<{
	tasks: TaskDef[]
	runners: TaskRunners
}> {
	const runners = detectRunners()
	const scripts = await readPackageScripts(rootDir)
	const targets = await readMakeTargets(rootDir)
	const tasks: TaskDef[] = []
	for (const [script, cmd] of Object.entries(scripts)) {
		if (runners.bun) {
			tasks.push({
				id: `bun:${script}`,
				label: `bun run ${script}`,
				kind: 'bun',
				script,
				command: `bun run ${script}`,
				detail: cmd.slice(0, 120),
			})
		}
		if (runners.npm) {
			tasks.push({
				id: `npm:${script}`,
				label: `npm run ${script}`,
				kind: 'npm',
				script,
				command: `npm run ${script}`,
				detail: cmd.slice(0, 120),
			})
		}
	}
	for (const target of targets) {
		if (runners.make) {
			tasks.push({
				id: `make:${target}`,
				label: `make ${target}`,
				kind: 'make',
				script: target,
				command: `make ${target}`,
			})
		} else {
			tasks.push({
				id: `missing-make:${target}`,
				label: `${target} (make not on PATH)`,
				kind: 'make',
				script: target,
				command: `make ${target}`,
			})
		}
	}
	// If neither runtime exists, still surface scripts so UI can explain.
	if (tasks.length === 0 && Object.keys(scripts).length > 0) {
		for (const [script, cmd] of Object.entries(scripts)) {
			tasks.push({
				id: `missing:${script}`,
				label: `${script} (no bun/npm on PATH)`,
				kind: 'npm',
				script,
				command: `npm run ${script}`,
				detail: cmd.slice(0, 120),
			})
		}
	}
	return {tasks, runners}
}

/** Resolve a task id back to its runnable command. Re-reads package.json so ids stay valid. */
export async function resolveTask(
	rootDir: string,
	id: string,
): Promise<TaskDef | null> {
	const {tasks} = await listTasks(rootDir)
	return tasks.find(t => t.id === id) ?? null
}
