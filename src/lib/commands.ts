import {useAppStore, type Panel} from '../store/useAppStore'
import {api} from './api'
import {nextThemeId, THEMES} from './themes'

export interface Command {
	id: string
	title: string
	hint?: string
	run: () => void | Promise<void>
}

function showPanel(panel: Panel) {
	const {setPanel, setSidebarOpen} = useAppStore.getState()
	setPanel(panel)
	setSidebarOpen(true)
}

async function saveActive() {
	const {tabs, activePath, updateTab, setSaving, setStatus} =
		useAppStore.getState()
	const tab = tabs.find(t => t.path === activePath)
	if (!tab || tab.binary || tab.truncated) return
	if (tab.content === tab.savedContent) {
		setStatus('no changes to save')
		return
	}
	setSaving(true)
	try {
		const res = await api.save(tab.path, tab.content)
		updateTab(tab.path, {savedContent: tab.content, mtime: res.mtime})
		setStatus(`saved ${tab.path}`)
	} catch (e) {
		setStatus(e instanceof Error ? e.message : 'save failed')
	} finally {
		setSaving(false)
	}
}

async function newFile() {
	const name = window.prompt('New file path (relative):')
	if (!name) return
	const {setStatus} = useAppStore.getState()
	try {
		await api.save(name.replace(/^\//, ''), '')
		setStatus(`created ${name}`)
	} catch (e) {
		setStatus(e instanceof Error ? e.message : 'create failed')
	}
}

function closeActive() {
	const {activePath, tabs, closeTab, setStatus} = useAppStore.getState()
	const tab = tabs.find(t => t.path === activePath)
	if (!tab) return
	if (
		tab.content !== tab.savedContent &&
		!window.confirm(`Close ${tab.path} with unsaved changes?`)
	)
		return
	closeTab(tab.path)
	setStatus(`closed ${tab.path}`)
}

async function stageAll(unstage: boolean) {
	const {setStatus} = useAppStore.getState()
	try {
		const s = await api.gitStatus()
		if (!s.repo) {
			setStatus('not a git repository')
			return
		}
		if (unstage) {
			const files = (s.staged ?? []).map(f => f.path)
			if (!files.length) {
				setStatus('nothing staged')
				return
			}
			await api.gitUnstage(files)
			setStatus(
				`unstaged ${files.length} file(s) — refresh the Source Control tab`,
			)
		} else {
			const files = [
				...(s.unstaged ?? []).map(f => f.path),
				...(s.untracked ?? []),
			]
			if (!files.length) {
				setStatus('nothing to stage')
				return
			}
			await api.gitStage(files)
			setStatus(
				`staged ${files.length} file(s) — refresh the Source Control tab`,
			)
		}
	} catch (e) {
		setStatus(e instanceof Error ? e.message : 'git failed')
	}
}

async function restartLsp() {
	const {setStatus} = useAppStore.getState()
	try {
		await api.lspEnsure('typescript')
		setStatus('language server restarted')
	} catch (e) {
		setStatus(e instanceof Error ? e.message : 'lsp restart failed')
	}
}

/** Full command registry. Called fresh each time the palette opens. */
export function allCommands(): Command[] {
	const s = useAppStore.getState()
	const cmds: Command[] = [
		{
			id: 'view.explorer',
			title: 'View: Show Explorer',
			run: () => showPanel('explorer'),
		},
		{
			id: 'view.search',
			title: 'View: Show Search',
			run: () => showPanel('search'),
		},
		{
			id: 'view.git',
			title: 'View: Show Source Control',
			run: () => showPanel('git'),
		},
		{
			id: 'view.tasks',
			title: 'View: Show Tasks',
			run: () => showPanel('tasks'),
		},
		{
			id: 'view.browser',
			title: 'View: Show Browser',
			run: () => s.setPanel('browser'),
		},
		{
			id: 'view.toggleSidebar',
			title: 'View: Toggle Sidebar',
			run: () => s.setSidebarOpen(!s.sidebarOpen),
		},
		{
			id: 'view.toggleTerminal',
			title: 'View: Toggle Terminal',
			hint: 'Ctrl+`',
			run: () => s.setTerminalOpen(!s.terminalOpen),
		},
		{
			id: 'file.new',
			title: 'File: New File…',
			run: () => void newFile(),
		},
		{
			id: 'file.save',
			title: 'File: Save Active File',
			hint: 'Ctrl+S',
			run: () => void saveActive(),
		},
		{
			id: 'file.close',
			title: 'File: Close Active Tab',
			run: () => closeActive(),
		},
		{
			id: 'terminal.focus',
			title: 'Terminal: Focus Terminal Drawer',
			run: () => s.setTerminalOpen(true),
		},
		{
			id: 'git.stageAll',
			title: 'Git: Stage All Changes',
			run: () => void stageAll(false),
		},
		{
			id: 'git.unstageAll',
			title: 'Git: Unstage All',
			run: () => void stageAll(true),
		},
		{
			id: 'lsp.restart',
			title: 'LSP: Restart TypeScript Language Server',
			run: () => void restartLsp(),
		},
		{
			id: 'settings.reset',
			title: 'Settings: Reset to Defaults',
			run: () => {
				s.resetSettings()
				s.setStatus('settings reset')
			},
		},
	]

	for (const t of THEMES) {
		cmds.push({
			id: `theme.${t.id}`,
			title: `Theme: ${t.label}`,
			run: () => s.setSettings({theme: t.id}),
		})
	}
	cmds.push({
		id: 'theme.cycle',
		title: 'Theme: Cycle to Next',
		run: () =>
			s.setSettings({
				theme: nextThemeId(useAppStore.getState().settings.theme),
			}),
	})

	return cmds.sort((a, b) => a.title.localeCompare(b.title))
}

/** Case-insensitive subsequence match with contiguous-run bonus. Null = no match. */
export function fuzzyScore(query: string, target: string): number | null {
	const q = query.toLowerCase()
	const t = target.toLowerCase()
	let qi = 0
	let score = 0
	let run = 0
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] === q[qi]) {
			qi++
			run++
			score += 1 + run * 2
			// bonus for word-boundary / start matches
			if (
				ti === 0 ||
				t[ti - 1] === ' ' ||
				t[ti - 1] === ':' ||
				t[ti - 1] === '/'
			)
				score += 3
		} else {
			run = 0
		}
	}
	return qi === q.length ? score : null
}
