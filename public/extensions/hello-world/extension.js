/**
 * td-code example extension — Hello World.
 *
 * Plain ESM, no build step: td-code loads it with `import()`.
 * The entry point exports `activate(ctx)` and optionally `deactivate()`.
 *
 * Install it from the Extensions panel (🧩 → install box):
 *   http://<your-td-code-host>/extensions/hello-world/package.json
 */

const config = (ctx, key, fallback) => {
	const v = ctx.workspaceStorage.get(key)
	return v === undefined ? fallback : v
}

export function activate(ctx) {
	const sayHi = () => {
		const greeting = config(ctx, 'greeting', 'Hello')
		const shout = config(ctx, 'shout', false)
		const text = shout ? greeting.toUpperCase() : greeting
		ctx.showMessage(`${text}, world from ${ctx.extensionId}!`, 'info')
	}

	ctx.registerCommand('hello.sayHi', sayHi)

	ctx.registerCommand('hello.insertTimestamp', async () => {
		const target = config(ctx, 'targetFile', 'hello-world.txt')
		const stamp = new Date().toISOString()
		let existing = ''
		try {
			existing = await ctx.readFile(target)
		} catch {
			// file does not exist yet — create it
		}
		await ctx.writeFile(target, `${existing}${stamp}\n`)
		ctx.showMessage(`appended ${stamp} to ${target}`, 'info')
	})

	// Fires whenever the user saves any file in any workspace
	ctx.onDidSaveFile((event, workspace) => {
		console.log(`[hello-world] ${event.path} saved in workspace ${workspace}`)
	})
}

export function deactivate() {
	console.log('[hello-world] deactivated')
}
