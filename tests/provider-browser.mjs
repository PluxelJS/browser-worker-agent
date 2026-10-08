import { browserWorkerAgent } from '../src/vite.ts'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { controlledProviderFixturePlugin } from './provider-fixtures.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const state = { cases: new Map(), active: undefined }
const failures = []
const server = await createServer({
	configFile: false,
	root: packageRoot,
	optimizeDeps: { entries: ['tests/browser/providers.html'] },
	plugins: [browserWorkerAgent(), controlledProviderFixturePlugin(state)],
	server: { host: '127.0.0.1', port: 0, hmr: false },
})
await server.listen()
const origin = `http://127.0.0.1:${server.httpServer.address().port}`
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
	const page = await browser.newPage()
	page.on('pageerror', (error) => failures.push(error.message))
	// Native factory defaults keep their real endpoint. Intercept every external request;
	// the only HTTP client exercised on the network connects to our localhost fixtures.
	await page.route('**/*', async (route) => {
		const request = route.request()
		const url = new URL(request.url())
		if (url.origin === origin) {
			await route.continue()
			return
		}
		const fixture = state.active
		if (!fixture || fixture.mode !== 'loop' || !fixture.builtin) {
			failures.push(`Unregistered external request ${url.origin}${url.pathname}`)
			await route.abort('blockedbyclient')
			return
		}
		const response = await route.fetch({
			url: `${origin}/__providers/${fixture.id}/native${url.pathname}${url.search}`,
			headers: { ...request.headers(), 'x-controlled-original-url': request.url() },
			maxRetries: 0,
			maxRedirects: 0,
		})
		await route.fulfill({ response })
	})
	await page.goto(`${origin}/tests/browser/providers.html`)
	await page.waitForFunction(() => typeof window.runNativeProviderBrowserTests === 'function')
	const result = await page.evaluate(() => window.runNativeProviderBrowserTests())
	assert.deepEqual(failures, [], 'no page errors or unregistered external connections')
	console.log('NATIVE PI PROVIDERS', JSON.stringify(result))
} finally {
	await browser.close()
	await server.close()
}
