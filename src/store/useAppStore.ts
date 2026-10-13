import {create} from 'zustand'
import type {Workspace} from '../lib/api'
import {
	DEFAULT_SETTINGS,
	loadSettings,
	saveSettings,
	type Settings,
} from '../lib/settings'

export interface OpenTab {
	path: string
	content: string
	savedContent: string
	mtime: number
	truncated?: boolean
	binary?: boolean
	/** workspace index this tab belongs to */
	workspace?: number
}

export type Panel =
	'explorer' | 'search' | 'browser' | 'git' | 'tasks' | 'debug'

export interface DebugStopped {
	threadId: number
	reason: string
	file: string | null
	line: number | null
}

export interface Bp {
	line: number
	condition?: string
	hitCondition?: string
}

export interface DebugState {
	active: boolean
	adapter: string | null
	program: string | null
	stopped: DebugStopped | null
	error?: string
	rootDir?: string
}

interface AppState {
	workspaces: Workspace[]
	activeWorkspace: number
	connected: boolean
	saving: boolean
	status: string
	showHidden: boolean
	sidebarOpen: boolean
	terminalOpen: boolean
	paletteOpen: boolean
	panel: Panel
	tabs: OpenTab[]
	activePath: string | null
	browserUrl: string
	browserHistory: string[]
	browserIndex: number
	quickLinks: {label: string; url: string}[]
	gitBranch: string | null
	gitDirty: number
	debug: DebugState
	breakpoints: Record<string, Bp[]>
	watches: string[]
	debugJump: {path: string; line: number; nonce: number} | null
	settings: Settings

	// Workspace actions
	setWorkspaces: (ws: Workspace[]) => void
	addWorkspace: (ws: Workspace) => void
	removeWorkspace: (index: number) => void
	setActiveWorkspace: (index: number) => void

	// Derived root
	root: string

	setConnected: (c: boolean) => void
	setSaving: (s: boolean) => void
	setStatus: (s: string) => void
	setShowHidden: (v: boolean) => void
	setSidebarOpen: (v: boolean) => void
	setTerminalOpen: (v: boolean) => void
	setPaletteOpen: (v: boolean) => void
	setPanel: (p: Panel) => void
	openTab: (t: OpenTab) => void
	updateTab: (path: string, patch: Partial<OpenTab>) => void
	closeTab: (path: string) => void
	setActive: (path: string | null) => void
	navigateBrowser: (url: string) => void
	browserBack: () => void
	browserForward: () => void
	setQuickLinks: (q: {label: string; url: string}[]) => void
	setGit: (branch: string | null, dirty: number) => void
	setDebug: (patch: Partial<DebugState>) => void
	resetDebug: () => void
	toggleBreakpoint: (path: string, line: number, workspace?: number) => void
	setBreakpoints: (path: string, bps: Bp[], workspace?: number) => void
	setBreakpointCond: (
		path: string,
		line: number,
		cond: {condition?: string; hitCondition?: string},
		workspace?: number,
	) => void
	addWatch: (expr: string) => void
	removeWatch: (expr: string) => void
	jumpTo: (path: string, line: number) => void
	setSettings: (patch: Partial<Settings>) => void
	resetSettings: () => void
}

const DEFAULT_LINKS = [
	{label: 'opencode :4096', url: 'http://localhost:4096'},
	{label: 'this app :4444', url: 'http://localhost:4444'},
	{label: 'vite :5173', url: 'http://localhost:5173'},
]

const BP_KEY = 'td-code-breakpoints-v1'

function loadBreakpoints(): Record<string, Bp[]> {
	try {
		const raw = localStorage.getItem(BP_KEY)
		if (!raw) return {}
		const p = JSON.parse(raw) as Record<string, unknown>
		const out: Record<string, Bp[]> = {}
		for (const [k, v] of Object.entries(p)) {
			if (typeof k !== 'string' || !Array.isArray(v)) continue
			// accepts legacy [1,2] and current [{line, condition?}] shapes
			const bps: Bp[] = []
			for (const item of v as unknown[]) {
				const line = typeof item === 'number' ? item : (item as Bp)?.line
				if (!Number.isInteger(line) || (line as number) <= 0) continue
				const b: Bp = {line: line as number}
				if (typeof item === 'object' && item !== null) {
					const c = (item as Bp).condition
					const h = (item as Bp).hitCondition
					if (typeof c === 'string' && c) b.condition = c.slice(0, 500)
					if (typeof h === 'string' && h) b.hitCondition = h.slice(0, 100)
				}
				if (!bps.some(x => x.line === b.line)) bps.push(b)
			}
			if (bps.length) out[k] = bps.sort((a, b) => a.line - b.line)
		}
		return out
	} catch {
		return {}
	}
}

function saveBreakpoints(bp: Record<string, Bp[]>) {
	try {
		localStorage.setItem(BP_KEY, JSON.stringify(bp))
	} catch {
		/* ignore */
	}
}

const WATCH_KEY = 'td-code-watches-v1'

function loadWatches(): string[] {
	try {
		const raw = localStorage.getItem(WATCH_KEY)
		if (!raw) return []
		const p = JSON.parse(raw) as unknown
		if (!Array.isArray(p)) return []
		return [
			...new Set(p.filter((x): x is string => typeof x === 'string')),
		].slice(-50)
	} catch {
		return []
	}
}

function saveWatches(w: string[]) {
	try {
		localStorage.setItem(WATCH_KEY, JSON.stringify(w))
	} catch {
		/* ignore */
	}
}

function loadLinks(): {label: string; url: string}[] {
	try {
		const raw = localStorage.getItem('td-code-links')
		if (raw) return JSON.parse(raw) as {label: string; url: string}[]
	} catch {
		/* ignore */
	}
	return DEFAULT_LINKS
}

function loadWorkspaces(): Workspace[] {
	try {
		const raw = localStorage.getItem('td-code-workspaces-v1')
		if (raw) {
			const parsed = JSON.parse(raw) as Workspace[]
			return parsed
		}
	} catch {
		/* ignore */
	}
	return []
}

function saveWorkspaces(workspaces: Workspace[]) {
	try {
		localStorage.setItem('td-code-workspaces-v1', JSON.stringify(workspaces))
	} catch {
		/* ignore */
	}
}

export const useAppStore = create<AppState>()((set, get) => {
	const initialWorkspaces = loadWorkspaces()
	const initialActive = 0

	return {
		workspaces:
			initialWorkspaces.length > 0
				? initialWorkspaces
				: [{rootDir: '', name: 'Workspace', index: 0}],
		activeWorkspace: initialActive,
		connected: false,
		saving: false,
		status: 'ready',
		showHidden: false,
		sidebarOpen: true,
		terminalOpen: false,
		paletteOpen: false,
		panel: 'explorer',
		tabs: [],
		activePath: null,
		browserUrl: 'http://localhost:4096',
		browserHistory: ['http://localhost:4096'],
		browserIndex: 0,
		quickLinks: loadLinks(),
		gitBranch: null,
		gitDirty: 0,
		debug: {active: false, adapter: null, program: null, stopped: null},
		breakpoints: loadBreakpoints(),
		watches: loadWatches(),
		debugJump: null,
		settings: loadSettings(),

		get root() {
			const ws = get().workspaces[get().activeWorkspace]
			return ws?.rootDir ?? ''
		},

		setWorkspaces: workspaces => set({workspaces}),
		addWorkspace: ws =>
			set(s => {
				const next = [...s.workspaces, {...ws, index: s.workspaces.length}]
				saveWorkspaces(next)
				return {workspaces: next}
			}),
		removeWorkspace: index =>
			set(s => {
				if (s.workspaces.length <= 1) return s
				const next = s.workspaces
					.filter((_, i) => i !== index)
					.map((w, i) => ({...w, index: i}))
				saveWorkspaces(next)
				const newActive = Math.min(s.activeWorkspace, next.length - 1)
				return {workspaces: next, activeWorkspace: newActive}
			}),
		setActiveWorkspace: index =>
			set(s => {
				if (index < 0 || index >= s.workspaces.length) return s
				return {activeWorkspace: index}
			}),

		setConnected: connected => set({connected}),
		setSaving: saving => set({saving}),
		setStatus: status => set({status}),
		setShowHidden: showHidden => set({showHidden}),
		setSidebarOpen: sidebarOpen => set({sidebarOpen}),
		setTerminalOpen: terminalOpen => set({terminalOpen}),
		setPaletteOpen: paletteOpen => set({paletteOpen}),
		setPanel: panel => set({panel}),
		openTab: t =>
			set(s => {
				const exists = s.tabs.some(
					x => x.path === t.path && x.workspace === t.workspace,
				)
				return {
					tabs: exists ? s.tabs : [...s.tabs, t],
					activePath: t.path,
					panel: s.panel,
				}
			}),
		updateTab: (path, patch) =>
			set(s => ({
				tabs: s.tabs.map(t =>
					t.path === path && t.workspace === patch.workspace
						? {...t, ...patch}
						: t,
				),
			})),
		closeTab: path =>
			set(s => {
				const idx = s.tabs.findIndex(t => t.path === path)
				const tabs = s.tabs.filter(t => t.path !== path)
				let activePath = s.activePath
				if (activePath === path) {
					activePath =
						tabs.length === 0
							? null
							: (tabs[Math.max(0, idx - 1)]?.path ?? null)
				}
				return {tabs, activePath}
			}),
		setActive: activePath => set({activePath}),
		navigateBrowser: url =>
			set(s => {
				const history = [...s.browserHistory.slice(0, s.browserIndex + 1), url]
				return {
					browserUrl: url,
					browserHistory: history,
					browserIndex: history.length - 1,
				}
			}),
		browserBack: () => {
			const {browserIndex, browserHistory} = get()
			if (browserIndex > 0) {
				const i = browserIndex - 1
				set({browserIndex: i, browserUrl: browserHistory[i] as string})
			}
		},
		browserForward: () => {
			const {browserIndex, browserHistory} = get()
			if (browserIndex < browserHistory.length - 1) {
				const i = browserIndex + 1
				set({browserIndex: i, browserUrl: browserHistory[i] as string})
			}
		},
		setQuickLinks: quickLinks => {
			localStorage.setItem('td-code-links', JSON.stringify(quickLinks))
			set({quickLinks})
		},
		setGit: (gitBranch, gitDirty) => set({gitBranch, gitDirty}),
		setDebug: patch => set(s => ({debug: {...s.debug, ...patch}})),
		resetDebug: () =>
			set({
				debug: {active: false, adapter: null, program: null, stopped: null},
			}),
		toggleBreakpoint: (path, line, workspace) =>
			set(s => {
				const key = workspace !== undefined ? `${workspace}:${path}` : path
				const cur = s.breakpoints[key] ?? []
				const next = cur.some(b => b.line === line)
					? cur.filter(b => b.line !== line)
					: [...cur, {line}].sort((a, b) => a.line - b.line)
				const breakpoints = {...s.breakpoints, [key]: next}
				if (next.length === 0) delete breakpoints[key]
				saveBreakpoints(breakpoints)
				return {breakpoints}
			}),
		setBreakpoints: (path, bps, workspace) =>
			set(s => {
				const key = workspace !== undefined ? `${workspace}:${path}` : path
				const seen = new Set<number>()
				const clean: Bp[] = []
				for (const b of bps) {
					if (!Number.isInteger(b.line) || b.line <= 0 || seen.has(b.line))
						continue
					seen.add(b.line)
					clean.push({
						line: b.line,
						...(b.condition ? {condition: b.condition} : {}),
						...(b.hitCondition ? {hitCondition: b.hitCondition} : {}),
					})
				}
				clean.sort((a, b) => a.line - b.line)
				const breakpoints = {...s.breakpoints, [key]: clean}
				if (clean.length === 0) delete breakpoints[key]
				saveBreakpoints(breakpoints)
				return {breakpoints}
			}),
		setBreakpointCond: (path, line, cond, workspace) =>
			set(s => {
				const key = workspace !== undefined ? `${workspace}:${path}` : path
				const cur = s.breakpoints[key] ?? []
				if (!cur.some(b => b.line === line)) return s
				const breakpoints = {
					...s.breakpoints,
					[key]: cur.map(b =>
						b.line === line
							? {
									line,
									...(cond.condition ? {condition: cond.condition} : {}),
									...(cond.hitCondition
										? {hitCondition: cond.hitCondition}
										: {}),
								}
							: b,
					),
				}
				saveBreakpoints(breakpoints)
				return {breakpoints}
			}),
		addWatch: expr =>
			set(s => {
				const e = expr.trim().slice(0, 500)
				if (!e || s.watches.includes(e)) return s
				const watches = [...s.watches, e].slice(-50)
				saveWatches(watches)
				return {watches}
			}),
		removeWatch: expr =>
			set(s => {
				const watches = s.watches.filter(w => w !== expr)
				saveWatches(watches)
				return {watches}
			}),
		jumpTo: (path, line) =>
			set(s => ({
				debugJump: {path, line, nonce: (s.debugJump?.nonce ?? 0) + 1},
			})),
		setSettings: patch =>
			set(s => {
				const settings = {...s.settings, ...patch}
				saveSettings(settings)
				return {settings}
			}),
		resetSettings: () => {
			saveSettings({...DEFAULT_SETTINGS})
			set({settings: {...DEFAULT_SETTINGS}})
		},
	}
})
