import {
	Suspense,
	lazy,
	useMemo,
	useRef,
	useState,
	type ComponentType,
	type ReactNode,
} from 'react'
import {loadWithRetries} from '../lib/lazy'
import {classifyPaneError, type PaneErrorInfo} from '../lib/paneError'
import ErrorBoundary from './ErrorBoundary'

export type {PaneErrorInfo}

interface Props<T extends object> {
	factory: () => Promise<{default: ComponentType<T>}>
	loading: ReactNode
	failed: (retry: () => void, info: PaneErrorInfo) => ReactNode
	childKey?: string
	props: T
}

/**
 * Lazy pane with transient-failure retries AND a working Retry button.
 * Each retry builds a fresh React.lazy (new network fetch) under a fresh
 * error boundary, so a failed chunk load is actually recoverable.
 */
export default function Reloadable<T extends object>({
	factory,
	loading,
	failed,
	childKey,
	props,
}: Props<T>) {
	const [attempt, setAttempt] = useState(0)
	const factoryRef = useRef(factory)
	factoryRef.current = factory
	// Mutable holder, NOT React state: the lazy factory runs during render, so
	// we must not call setState there. Read when the boundary renders fallback.
	const loadFailure = useMemo(
		() => ({current: null as Error | null}),
		[attempt],
	)
	const Comp = useMemo(
		() =>
			lazy(() =>
				loadWithRetries(() => factoryRef.current()).then(
					mod => {
						loadFailure.current = null
						return mod
					},
					err => {
						loadFailure.current =
							err instanceof Error ? err : new Error(String(err))
						throw loadFailure.current
					},
				),
			),
		// new lazy instance per attempt; factory identity intentionally ignored
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[attempt],
	) as ComponentType<T>
	const retry = () => setAttempt(a => a + 1)
	return (
		<ErrorBoundary
			key={attempt}
			fallback={renderError =>
				failed(retry, classifyPaneError(loadFailure.current, renderError))
			}
		>
			<Suspense fallback={loading}>
				<Comp
					key={childKey}
					{...props}
				/>
			</Suspense>
		</ErrorBoundary>
	)
}
