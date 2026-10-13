/**
 * Load a dynamic import with retries. On mobile networks a chunk can fail to
 * load once; without retries the pane stays blank forever with no feedback.
 */
export function loadWithRetries<T>(
	factory: () => Promise<T>,
	retries = 3,
	baseDelayMs = 800,
): Promise<T> {
	let attempt = 0
	const load = (): Promise<T> =>
		factory().catch(err => {
			attempt += 1
			if (attempt > retries) throw err
			return new Promise<T>((resolve, reject) => {
				window.setTimeout(() => {
					load().then(resolve, reject)
				}, baseDelayMs * attempt)
			})
		})
	return load()
}
