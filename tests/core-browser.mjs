import { browserWorkerAgent } from '../src/vite.ts'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import tailwindcss from '@tailwindcss/vite'

const root = fileURLToPath(new URL('..', import.meta.url))
let server, browser
try {
	server = await createServer({
		configFile: false,
		root,
		plugins: [browserWorkerAgent(), tailwindcss()],
		resolve: { dedupe: ['react', 'react-dom'] },
		optimizeDeps: { entries: ['tests/browser/index.html'] },
		server: { host: '127.0.0.1', port: 0, hmr: false },
	})
	await server.listen()
	browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
	const page = await browser.newPage()
	const errors = []
	page.on('pageerror', (error) => errors.push(error.message))
	await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/browser/index.html`)
	await page.waitForFunction(() => typeof window.runCoreBrowserTests === 'function')
	const results = await page.evaluate(() => window.runCoreBrowserTests())
	assert.deepEqual(errors, [])
	console.log('CORE BROWSER ACCEPTED', JSON.stringify(results))
} finally {
	await browser?.close()
	await server?.close()
}
