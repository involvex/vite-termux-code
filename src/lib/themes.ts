export interface XtermTheme {
	background: string
	foreground: string
	cursor: string
	selectionBackground: string
}

export interface ThemeDef {
	id: string
	label: string
	/** CodeMirror theme mapping: 'oneDark' or 'light' (default light, no extension) */
	cm: 'oneDark' | 'light'
	xterm: XtermTheme
}

export const THEMES: ThemeDef[] = [
	{
		id: 'one-dark',
		label: 'One Dark',
		cm: 'oneDark',
		xterm: {
			background: '#1e1e1e',
			foreground: '#cccccc',
			cursor: '#aeafad',
			selectionBackground: 'rgba(0, 122, 204, 0.4)',
		},
	},
	{
		id: 'github-light',
		label: 'GitHub Light',
		cm: 'light',
		xterm: {
			background: '#ffffff',
			foreground: '#24292f',
			cursor: '#044289',
			selectionBackground: 'rgba(0, 122, 204, 0.25)',
		},
	},
	{
		id: 'dracula',
		label: 'Dracula',
		cm: 'oneDark',
		xterm: {
			background: '#282a36',
			foreground: '#f8f8f2',
			cursor: '#f8f8f2',
			selectionBackground: 'rgba(189, 147, 249, 0.4)',
		},
	},
]

export function themeById(id: string): ThemeDef {
	return THEMES.find(t => t.id === id) ?? (THEMES[0] as ThemeDef)
}

/** Cycle to the next theme, wrapping around. */
export function nextThemeId(current: string): string {
	const i = THEMES.findIndex(t => t.id === current)
	return THEMES[(i + 1) % THEMES.length]?.id ?? 'one-dark'
}
