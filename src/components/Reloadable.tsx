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
import ErrorBoundary from './ErrorBoundary'

interface Props<T extends object> {
	factory: () => Promise<{default: ComponentType<T>}>
	loading: ReactNode
	failed: (retry: () => void) => ReactNode
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
	const Comp = useMemo(
		() => lazy(() => loadWithRetries(() => factoryRef.current())),
		// new lazy instance per attempt; factory identity intentionally ignored
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[attempt],
	) as ComponentType<T>
	const retry = () => setAttempt(a => a + 1)
	return (
		<ErrorBoundary
			key={attempt}
			fallback={failed(retry)}
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
