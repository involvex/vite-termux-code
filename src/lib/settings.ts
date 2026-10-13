export interface Settings {
	/** theme id, see src/lib/themes.ts */
	theme: string
	/** editor font size in px */
	fontSize: number
	/** terminal font size in px */
	termFontSize: number
	/** indent width */
	tabSize: number
	/** true = spaces, false = tabs */
	insertSpaces: boolean
	wordWrap: boolean
}

export const DEFAULT_SETTINGS: Settings = {
	theme: 'one-dark',
	fontSize: 14,
	termFontSize: 14,
	tabSize: 2,
	insertSpaces: true,
	wordWrap: true,
}

const KEY = 'td-code-settings-v1'

function clamp(n: unknown, min: number, max: number, fallback: number): number {
	return typeof n === 'number' && Number.isFinite(n)
		? Math.max(min, Math.min(max, Math.floor(n)))
		: fallback
}

/** Load + validate, merging over defaults so new keys survive upgrades. */
export function loadSettings(): Settings {
	try {
		const raw = localStorage.getItem(KEY)
		if (!raw) return {...DEFAULT_SETTINGS}
		const p = JSON.parse(raw) as Partial<Settings>
		return {
			theme:
				typeof p.theme === 'string' && p.theme
					? p.theme
					: DEFAULT_SETTINGS.theme,
			fontSize: clamp(p.fontSize, 10, 24, DEFAULT_SETTINGS.fontSize),
			termFontSize: clamp(
				p.termFontSize,
				10,
				22,
				DEFAULT_SETTINGS.termFontSize,
			),
			tabSize: clamp(p.tabSize, 1, 8, DEFAULT_SETTINGS.tabSize),
			insertSpaces:
				typeof p.insertSpaces === 'boolean'
					? p.insertSpaces
					: DEFAULT_SETTINGS.insertSpaces,
			wordWrap:
				typeof p.wordWrap === 'boolean'
					? p.wordWrap
					: DEFAULT_SETTINGS.wordWrap,
		}
	} catch {
		return {...DEFAULT_SETTINGS}
	}
}

export function saveSettings(s: Settings) {
	try {
		localStorage.setItem(KEY, JSON.stringify(s))
	} catch {
		/* storage full / private mode — settings just won't persist */
	}
}
