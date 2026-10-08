import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build, createServer, preview } from 'vite'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../examples/local-react', import.meta.url))
const configFile = `${root}/vite.config.ts`
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })

async function verify(server, mode) {
	const origin = `http://127.0.0.1:${server.httpServer.address().port}`
	const page = await browser.newPage()
	const errors = []
	page.on('pageerror', (error) => errors.push(error.message))
	await page.route('**/*', (route) => {
		if (new URL(route.request().url()).origin === origin) return route.continue()
		errors.push(`External request: ${route.request().url()}`)
		return route.abort()
	})
	try {
		await page.goto(origin)
		await page
			.getByRole('textbox', { name: 'Local note', exact: true })
			.fill('keep this entirely local')
		await page.getByRole('textbox', { name: '消息', exact: true }).fill('Uppercase my note')
		await page.getByRole('button', { name: '发送', exact: true }).click()
		await page.getByText('The local note is now uppercase.', { exact: true }).waitFor()
		assert.equal(
			await page.getByRole('textbox', { name: 'Local note', exact: true }).inputValue(),
			'KEEP THIS ENTIRELY LOCAL',
		)
		await page.getByRole('combobox', { name: 'Notebook', exact: true }).selectOption('Work')
		await page.getByRole('region', { name: 'Work assistant', exact: true }).waitFor()
		assert.equal(
			await page.getByText('The local note is now uppercase.', { exact: true }).count(),
			0,
		)
		assert.equal(
			await page.getByRole('textbox', { name: 'Local note', exact: true }).inputValue(),
			'A note from Work',
		)
		await page.getByRole('textbox', { name: '消息', exact: true }).fill('Use the new notebook')
		await page.getByRole('button', { name: '发送', exact: true }).click()
		await page.getByText('The local note is now uppercase.', { exact: true }).waitFor()
		assert.equal(
			await page.getByRole('textbox', { name: 'Local note', exact: true }).inputValue(),
			'A NOTE FROM WORK',
		)
		await page.getByRole('button', { name: 'Close notebook', exact: true }).click()
		assert.equal(await page.getByRole('region', { name: 'Work assistant', exact: true }).count(), 0)
		await page.getByRole('button', { name: 'Open notebook', exact: true }).click()
		await page.getByRole('textbox', { name: '消息', exact: true }).waitFor()
		assert.equal(
			await page.getByText('The local note is now uppercase.', { exact: true }).count(),
			0,
		)
		assert.equal(
			await page.getByRole('textbox', { name: 'Local note', exact: true }).inputValue(),
			'A note from Work',
		)
		assert.deepEqual(errors, [])
		console.log(
			`Local frontend example (${mode}): Worker RPC, scope replacement, unmount/reopen; no external requests`,
		)
	} finally {
		await page.close()
	}
}

try {
	const server = await createServer({
		root,
		configFile,
		server: { host: '127.0.0.1', port: 0, hmr: false },
	})
	try {
		await server.listen()
		await verify(server, 'development + StrictMode')
	} finally {
		await server.close()
	}
	await build({ root, configFile })
	const production = await preview({ root, configFile, preview: { host: '127.0.0.1', port: 0 } })
	try {
		await verify(production, 'production')
	} finally {
		await production.close()
	}
} finally {
	await browser.close()
}
