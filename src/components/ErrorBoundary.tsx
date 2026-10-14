import {Component, type ReactNode} from 'react'

interface Props {
	/** Plain node, or a builder that receives the caught error (may be null). */
	fallback: ReactNode | ((error: Error | null) => ReactNode)
	children: ReactNode
}

interface State {
	failed: boolean
	error: Error | null
}

function toError(err: unknown): Error {
	if (err instanceof Error) return err
	return new Error(typeof err === 'string' ? err : JSON.stringify(err))
}

/**
 * Catches chunk-load / render crashes of a lazy pane.
 * Reset by changing `key` (see Reloadable) — a plain state reset would NOT
 * re-run a rejected React.lazy import.
 */
export default class ErrorBoundary extends Component<Props, State> {
	state: State = {failed: false, error: null}

	static getDerivedStateFromError(err: unknown): State {
		return {failed: true, error: toError(err)}
	}

	componentDidCatch(err: unknown) {
		console.error('[td-code] pane crashed:', err)
	}

	render() {
		if (!this.state.failed) return this.props.children
		const {fallback} = this.props
		return typeof fallback === 'function'
			? fallback(this.state.error)
			: fallback
	}
}
