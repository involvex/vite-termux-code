import {create} from 'zustand'

export interface OpenTab {
	path: string
	content: string
	savedContent: string
	mtime: number
	truncated?: boolean
	binary?: boolean
}

export type Panel = 'explorer' | 'search' | 'browser' | 'git'

interface AppState {
	root: string
	connected: boolean
	saving: boolean
	status: string
	showHidden: boolean
	sidebarOpen: boolean
	terminalOpen: boolean
	panel: Panel
	tabs: OpenTab[]
	activePath: string | null
	browserUrl: string
	browserHistory: string[]
	browserIndex: number
	quickLinks: {label: string; url: string}[]
	gitBranch: string | null
	gitDirty: number

	setRoot: (r: string) => void
	setConnected: (c: boolean) => void
	setSaving: (s: boolean) => void
	setStatus: (s: string) => void
	setShowHidden: (v: boolean) => void
	setSidebarOpen: (v: boolean) => void
	setTerminalOpen: (v: boolean) => void
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
}

const DEFAULT_LINKS = [
	{label: 'opencode :4096', url: 'http://localhost:4096'},
	{label: 'this app :4444', url: 'http://localhost:4444'},
	{label: 'vite :5173', url: 'http://localhost:5173'},
]

function loadLinks(): {label: string; url: string}[] {
	try {
		const raw = localStorage.getItem('td-code-links')
		if (raw) return JSON.parse(raw) as {label: string; url: string}[]
	} catch {
		/* ignore */
	}
	return DEFAULT_LINKS
}

export const useAppStore = create<AppState>()((set, get) => ({
	root: '',
	connected: false,
	saving: false,
	status: 'ready',
	showHidden: false,
	sidebarOpen: true,
	terminalOpen: false,
	panel: 'explorer',
	tabs: [],
	activePath: null,
	browserUrl: 'http://localhost:4096',
	browserHistory: ['http://localhost:4096'],
	browserIndex: 0,
	quickLinks: loadLinks(),
	gitBranch: null,
	gitDirty: 0,

	setRoot: root => set({root}),
	setConnected: connected => set({connected}),
	setSaving: saving => set({saving}),
	setStatus: status => set({status}),
	setShowHidden: showHidden => set({showHidden}),
	setSidebarOpen: sidebarOpen => set({sidebarOpen}),
	setTerminalOpen: terminalOpen => set({terminalOpen}),
	setPanel: panel => set({panel}),
	openTab: t =>
		set(s => {
			const exists = s.tabs.some(x => x.path === t.path)
			return {
				tabs: exists ? s.tabs : [...s.tabs, t],
				activePath: t.path,
				panel: s.panel,
			}
		}),
	updateTab: (path, patch) =>
		set(s => ({
			tabs: s.tabs.map(t => (t.path === path ? {...t, ...patch} : t)),
		})),
	closeTab: path =>
		set(s => {
			const idx = s.tabs.findIndex(t => t.path === path)
			const tabs = s.tabs.filter(t => t.path !== path)
			let activePath = s.activePath
			if (activePath === path) {
				activePath =
					tabs.length === 0 ? null : (tabs[Math.max(0, idx - 1)]?.path ?? null)
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
}))
