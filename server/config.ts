/**
 * Optional user config: ~/.td-code/config.json
 *
 * Precedence (weakest to strongest): built-in defaults < config file < CLI
 * flags < TD_CODE_* environment variables. Everything is optional — without
 * the file, td-code behaves exactly as before.
 *
 * Example ~/.td-code/config.json:
 * {
 *   "port": 4444,
 *   "host": "0.0.0.0",
 *   "auth": false,
 *   "pairing": { "enabled": true, "length": 6 },
 *   "watch": true,
 *   "terms": true
 * }
 */
import {readFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface PairingConfig {
	/** Accept a short, human-typable code in addition to the token. */
	enabled?: boolean
	/** Fixed code. Omit to generate a random one on every start. */
	code?: string
	/** Length of a generated code (digits only). Default 6. */
	length?: number
}

export interface UserConfig {
	port?: number
	host?: string
	/** false disables auth entirely (trusted networks only). */
	auth?: boolean
	/** Fixed auth token, instead of a random one per start. */
	authToken?: string
	pairing?: PairingConfig
	/** false disables the file watcher. */
	watch?: boolean
	/** false disables terminals. */
	terms?: boolean
	/** Launch a browser when the server starts. */
	open?: boolean
	/** Rejects unknown keys so typos surface instead of being ignored. */
	version?: number
}

export interface LoadedConfig {
	config: UserConfig
	/** Absolute path that was consulted (whether or not it exists). */
	path: string
	/** Set when the file exists but could not be parsed. */
	error?: string
}

export const CONFIG_DIR_NAME = '.td-code'
export const CONFIG_FILE_NAME = 'config.json'

export function userConfigPath(): string {
	return path.join(os.homedir(), CONFIG_DIR_NAME, CONFIG_FILE_NAME)
}

const KNOWN_KEYS = new Set([
	'port',
	'host',
	'auth',
	'authToken',
	'pairing',
	'watch',
	'terms',
	'open',
	'version',
])

/** Parse raw JSON into a validated UserConfig. Throws with a clear message. */
export function parseConfig(raw: string, source = 'config'): UserConfig {
	// Windows editors (Notepad, PowerShell 5.1 `Set-Content -Encoding UTF8`)
	// prepend a BOM, which JSON.parse rejects outright.
	const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
	let data: unknown
	try {
		data = JSON.parse(text)
	} catch (e) {
		throw new Error(
			`${source} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
		)
	}
	if (!data || typeof data !== 'object' || Array.isArray(data)) {
		throw new Error(`${source} must contain a JSON object`)
	}
	const obj = data as Record<string, unknown>
	const unknown = Object.keys(obj).filter(k => !KNOWN_KEYS.has(k))
	if (unknown.length) {
		throw new Error(
			`${source} has unknown key(s): ${unknown.join(', ')} (allowed: ${[...KNOWN_KEYS].join(', ')})`,
		)
	}

	const cfg: UserConfig = {}

	if (obj.port !== undefined) {
		const n = Number(obj.port)
		if (!Number.isInteger(n) || n < 1 || n > 65535)
			throw new Error(`${source}: "port" must be an integer 1-65535`)
		cfg.port = n
	}
	if (obj.host !== undefined) {
		if (typeof obj.host !== 'string' || !obj.host)
			throw new Error(`${source}: "host" must be a non-empty string`)
		cfg.host = obj.host
	}
	if (obj.auth !== undefined) {
		if (typeof obj.auth !== 'boolean')
			throw new Error(`${source}: "auth" must be true or false`)
		cfg.auth = obj.auth
	}
	if (obj.authToken !== undefined) {
		if (typeof obj.authToken !== 'string' || !obj.authToken)
			throw new Error(`${source}: "authToken" must be a non-empty string`)
		cfg.authToken = obj.authToken
	}
	if (obj.watch !== undefined) {
		if (typeof obj.watch !== 'boolean')
			throw new Error(`${source}: "watch" must be true or false`)
		cfg.watch = obj.watch
	}
	if (obj.terms !== undefined) {
		if (typeof obj.terms !== 'boolean')
			throw new Error(`${source}: "terms" must be true or false`)
		cfg.terms = obj.terms
	}
	if (obj.open !== undefined) {
		if (typeof obj.open !== 'boolean')
			throw new Error(`${source}: "open" must be true or false`)
		cfg.open = obj.open
	}
	if (obj.version !== undefined) {
		if (obj.version !== 1)
			throw new Error(`${source}: unsupported "version" (expected 1)`)
		cfg.version = 1
	}
	if (obj.pairing !== undefined) {
		if (
			!obj.pairing ||
			typeof obj.pairing !== 'object' ||
			Array.isArray(obj.pairing)
		)
			throw new Error(`${source}: "pairing" must be an object`)
		const p = obj.pairing as Record<string, unknown>
		const pairing: PairingConfig = {}
		if (p.enabled !== undefined) {
			if (typeof p.enabled !== 'boolean')
				throw new Error(`${source}: "pairing.enabled" must be true or false`)
			pairing.enabled = p.enabled
		}
		if (p.code !== undefined) {
			if (typeof p.code !== 'string' || !/^\d{4,10}$/.test(p.code))
				throw new Error(
					`${source}: "pairing.code" must be 4-10 digits (easier to type on a phone)`,
				)
			pairing.code = p.code
		}
		if (p.length !== undefined) {
			const n = Number(p.length)
			if (!Number.isInteger(n) || n < 4 || n > 10)
				throw new Error(`${source}: "pairing.length" must be an integer 4-10`)
			pairing.length = n
		}
		cfg.pairing = pairing
	}

	return cfg
}

/** Read ~/.td-code/config.json. Missing file is not an error. */
export function loadUserConfig(file = userConfigPath()): LoadedConfig {
	let raw: string
	try {
		raw = readFileSync(file, 'utf8')
	} catch (e) {
		const code = (e as NodeJS.ErrnoException)?.code
		if (code === 'ENOENT' || code === 'EACCES' || code === 'EISDIR') {
			return {config: {}, path: file}
		}
		return {config: {}, path: file, error: String(e)}
	}
	try {
		return {config: parseConfig(raw, file), path: file}
	} catch (e) {
		return {config: {}, path: file, error: (e as Error).message}
	}
}

/** Generate a numeric pairing code of the given length. */
export function generatePairingCode(length = 6): string {
	const len = Math.min(10, Math.max(4, Math.floor(length)))
	let out = ''
	for (let i = 0; i < len; i++) out += String(Math.floor(Math.random() * 10))
	return out
}
