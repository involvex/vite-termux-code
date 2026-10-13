/**
 * Extension Marketplace Index
 *
 * A simple JSON-based marketplace for td-code extensions.
 * Can be hosted as a static file or served from a CDN.
 */

export interface MarketplaceIndex {
	version: number
	updatedAt: string
	extensions: MarketplaceEntry[]
}

export interface MarketplaceEntry {
	name: string
	publisher: string
	version: string
	displayName: string
	description: string
	categories: string[]
	icon?: string
	repository: string
	downloads: number
	rating: number
	updatedAt: string
	// Installation info
	installUrl: string // GitHub repo, npm package, or direct URL
	// Optional: specific release/tag
	releaseTag?: string
	// Keywords for search
	keywords?: string[]
}

// Default marketplace index (can be overridden by user)
export const DEFAULT_MARKETPLACE_INDEX: MarketplaceIndex = {
	version: 1,
	updatedAt: new Date().toISOString(),
	extensions: [
		{
			name: 'sample-extension',
			publisher: 'td-code',
			version: '1.0.0',
			displayName: 'Sample Extension',
			description: 'A sample extension demonstrating the extension API',
			categories: ['Other'],
			repository: 'https://github.com/td-code/sample-extension',
			downloads: 0,
			rating: 5,
			updatedAt: new Date().toISOString(),
			installUrl: 'github:td-code/sample-extension',
			keywords: ['sample', 'demo', 'api'],
		},
		{
			name: 'markdown-preview',
			publisher: 'community',
			version: '1.2.0',
			displayName: 'Markdown Preview',
			description: 'Live preview Markdown files in the browser tab',
			categories: ['Formatters'],
			repository: 'https://github.com/td-code/markdown-preview',
			downloads: 1234,
			rating: 4.5,
			updatedAt: '2026-01-15T00:00:00Z',
			installUrl: 'github:td-code/markdown-preview',
			keywords: ['markdown', 'preview', 'render'],
		},
		{
			name: 'git-lens',
			publisher: 'community',
			version: '2.1.0',
			displayName: 'Git Lens',
			description: 'Enhanced Git integration with blame, history, and more',
			categories: ['Other'],
			repository: 'https://github.com/td-code/git-lens',
			downloads: 5678,
			rating: 4.8,
			updatedAt: '2026-02-20T00:00:00Z',
			installUrl: 'github:td-code/git-lens',
			keywords: ['git', 'blame', 'history', 'diff'],
		},
		{
			name: 'theme-dracula',
			publisher: 'td-code',
			version: '1.0.0',
			displayName: 'Dracula Theme',
			description: 'Official Dracula theme for td-code',
			categories: ['Themes'],
			repository: 'https://github.com/td-code/theme-dracula',
			downloads: 9876,
			rating: 4.9,
			updatedAt: '2026-03-10T00:00:00Z',
			installUrl: 'github:td-code/theme-dracula',
			keywords: ['theme', 'dracula', 'dark'],
		},
		{
			name: 'prettier',
			publisher: 'community',
			version: '1.0.0',
			displayName: 'Prettier Formatter',
			description: 'Format code with Prettier on save or on demand',
			categories: ['Formatters'],
			repository: 'https://github.com/td-code/prettier-extension',
			downloads: 3456,
			rating: 4.6,
			updatedAt: '2026-04-05T00:00:00Z',
			installUrl: 'github:td-code/prettier-extension',
			keywords: ['prettier', 'format', 'formatter', 'code-style'],
		},
		{
			name: 'eslint',
			publisher: 'community',
			version: '1.0.0',
			displayName: 'ESLint',
			description: 'Lint JavaScript and TypeScript with ESLint',
			categories: ['Linters'],
			repository: 'https://github.com/td-code/eslint-extension',
			downloads: 2345,
			rating: 4.4,
			updatedAt: '2026-05-12T00:00:00Z',
			installUrl: 'github:td-code/eslint-extension',
			keywords: ['eslint', 'lint', 'javascript', 'typescript'],
		},
		{
			name: 'python-debug',
			publisher: 'td-code',
			version: '1.0.0',
			displayName: 'Python Debug Adapter',
			description: 'Debug Python code using debugpy',
			categories: ['Debuggers'],
			repository: 'https://github.com/td-code/python-debug',
			downloads: 1122,
			rating: 4.3,
			updatedAt: '2026-06-18T00:00:00Z',
			installUrl: 'github:td-code/python-debug',
			keywords: ['python', 'debug', 'debugpy', 'dap'],
		},
	],
}

/**
 * Fetch marketplace index from a URL
 */
export async function fetchMarketplaceIndex(
	url: string = 'https://raw.githubusercontent.com/td-code/marketplace/main/index.json',
): Promise<MarketplaceIndex> {
	try {
		const response = await fetch(url)
		if (!response.ok) throw new Error(`HTTP ${response.status}`)
		return await response.json()
	} catch (e) {
		console.warn('Failed to fetch marketplace index, using default:', e)
		return DEFAULT_MARKETPLACE_INDEX
	}
}

/**
 * Search marketplace extensions
 */
export function searchMarketplace(
	index: MarketplaceIndex,
	query: string,
	category?: string,
): MarketplaceEntry[] {
	const q = query.toLowerCase()
	return index.extensions.filter(ext => {
		const matchesQuery =
			!q ||
			ext.name.toLowerCase().includes(q) ||
			ext.displayName.toLowerCase().includes(q) ||
			ext.description.toLowerCase().includes(q) ||
			ext.keywords?.some(k => k.toLowerCase().includes(q)) ||
			ext.publisher.toLowerCase().includes(q)

		const matchesCategory = !category || ext.categories.includes(category)

		return matchesQuery && matchesCategory
	})
}

/**
 * Get all categories from marketplace
 */
export function getMarketplaceCategories(index: MarketplaceIndex): string[] {
	const categories = new Set<string>()
	for (const ext of index.extensions) {
		for (const cat of ext.categories) {
			categories.add(cat)
		}
	}
	return Array.from(categories).sort()
}

/**
 * Get marketplace extension by ID
 */
export function getMarketplaceExtension(
	index: MarketplaceIndex,
	extensionId: string, // format: publisher.name
): MarketplaceEntry | undefined {
	return index.extensions.find(
		ext => `${ext.publisher}.${ext.name}` === extensionId,
	)
}
