import {readFileSync, writeFileSync} from 'fs'

const p = 'src/components/FileTree.tsx'
const lines = readFileSync(p, 'utf8').split(/\r?\n/)
const out: string[] = []
let skip = false
let skipped = 0

for (const line of lines) {
	if (skip) {
		skipped++
		if (skipped === 2) {
			out.push('\t\t\t\t{workspaces.map((ws, i) => (')
			out.push('\t\t\t\t\t<div key={"workspace-" + ws.rootDir}>')
			out.push('\t\t\t\t\t\t{renderWorkspace(ws, i, i === activeWorkspace)}')
			out.push('\t\t\t\t\t</div>')
			out.push('\t\t\t\t)}')
			skip = false
			skipped = 0
		}
		continue
	}

	if (line.includes('workspaces.map((ws, i) =>')) {
		out.push(line)
		skip = true
		skipped = 0
	} else {
		out.push(line)
	}
}

writeFileSync(p, out.join('\r\n'))
console.log('patched')
