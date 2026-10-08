import { readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'rolldown'

const root = fileURLToPath(new URL('.', import.meta.url))
const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
const external = [...Object.keys(manifest.dependencies), ...Object.keys(manifest.peerDependencies)]

await rm(new URL('./dist', import.meta.url), { recursive: true, force: true })
// Preserve the standard relative Worker URL for the consumer's bundler. Building an
// application with Vite here would instead rewrite it for this package's deployment.
await build({
	cwd: root,
	platform: 'browser',
	input: { index: 'src/index.ts', execution: 'src/execution.ts' },
	external: (id) => external.some((name) => id === name || id.startsWith(`${name}/`)),
	output: { dir: 'dist', format: 'es', entryFileNames: '[name].js' },
})
// A separate realm needs its own runtime. This standalone artifact also works when
// a host serves /worker directly and supplies its own createWorker factory.
await build({
	cwd: root,
	platform: 'browser',
	input: 'src/execution.worker.ts',
	output: { file: 'dist/execution.worker.js', format: 'es' },
})
// Build-tool entry is separate from every browser import graph.
await build({
	cwd: root,
	platform: 'node',
	input: 'src/vite.ts',
	output: { file: 'dist/vite.js', format: 'es' },
})
