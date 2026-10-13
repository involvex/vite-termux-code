import {useAppStore} from '../store/useAppStore'
import {api} from './api'

/** Open a workspace file (if not binary), activate it, and jump to a line. */
export async function openAt(path: string, line?: number) {
	const {openTab, setActive, setStatus, jumpTo} = useAppStore.getState()
	try {
		const data = await api.read(path)
		if (data.binary) {
			setStatus(`${path} is binary`)
			return
		}
		openTab({
			path,
			content: data.content ?? '',
			savedContent: data.content ?? '',
			mtime: data.mtime,
			truncated: data.truncated,
		})
		setActive(path)
		if (typeof line === 'number') jumpTo(path, line)
		else setStatus(path)
	} catch (e) {
		setStatus(e instanceof Error ? e.message : 'open failed')
	}
}
