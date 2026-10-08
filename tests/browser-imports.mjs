import { browserWorkerAgent } from '../src/vite.ts'
import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createLogger, createServer } from 'vite'

// Exercise the dependency optimizer AND import-analysis, which a production build skips.
const root = await mkdtemp(join(tmpdir(), 'agent-browser-imports-'))
const warnings = []
const logger = createLogger('warn')
const originalWarn = logger.warn.bind(logger)
logger.warn = (message, options) => {
	warnings.push(message)
	originalWarn(message, options)
}
let server, browser
try {
	await symlink(
		fileURLToPath(new URL('../node_modules', import.meta.url)),
		join(root, 'node_modules'),
	)
	await writeFile(join(root, 'index.html'), '<script type="module" src="/main.js"></script>')
	await writeFile(
		join(root, 'main.js'),
		`
		import { builtinModels } from '@earendil-works/pi-ai/providers/all';
		const models = builtinModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
		window.providerCount = models.getProviders().length;
	`,
	)
	server = await createServer({
		configFile: false,
		plugins: [browserWorkerAgent()],
		root,
		customLogger: logger,
		server: { host: '127.0.0.1', port: 0 },
		optimizeDeps: { include: ['@earendil-works/pi-ai/providers/all'] },
	})
	await server.listen()
	browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
	const page = await browser.newPage()
	const errors = []
	const nodeRequests = []
	page.on('pageerror', (error) => errors.push(error.message))
	page.on('request', (request) => {
		if (
			/bedrock-converse-stream\.js|auth\/oauth\/(anthropic|openai)|node:(fs|os|path)/.test(
				request.url(),
			)
		)
			nodeRequests.push(request.url())
	})
	await page.goto(server.resolvedUrls.local[0])
	await page.waitForFunction(() => window.providerCount > 0)
	assert.equal(await page.evaluate(() => window.providerCount), 42)
	assert.deepEqual(errors, [])
	assert.deepEqual(nodeRequests, [])
	assert.deepEqual(
		warnings.filter((warning) => warning.includes('cannot be analyzed by Vite')),
		[],
	)
	console.log(
		'Vite optimized pi catalog: 42 providers; no dynamic-import analysis warnings or Node-only requests',
	)
} finally {
	await browser?.close()
	await server?.close()
	await rm(root, { recursive: true, force: true })
}
