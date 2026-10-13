import {Component, type ReactNode} from 'react'

interface Props {
	fallback: ReactNode
	children: ReactNode
}

interface State {
	failed: boolean
}

/**
 * Catches chunk-load / render crashes of a lazy pane.
 * Reset by changing `key` (see Reloadable) — a plain state reset would NOT
 * re-run a rejected React.lazy import.
 */
export default class ErrorBoundary extends Component<Props, State> {
	state: State = {failed: false}

	static getDerivedStateFromError(): State {
		return {failed: true}
	}

	componentDidCatch(err: unknown) {
		console.error('[td-code] pane crashed:', err)
	}

	render() {
		if (this.state.failed) return this.props.fallback
		return this.props.children
	}
}
