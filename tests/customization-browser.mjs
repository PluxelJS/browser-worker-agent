import { browserWorkerAgent } from '../src/vite.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, copyFile, readdir, symlink, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const background = (locator) => locator.evaluate((node) => getComputedStyle(node).backgroundColor)
async function checkPortal(page, workspace, color) {
	await workspace.getByRole('button', { name: 'Custom model setup', exact: true }).click()
	const dialog = page.getByRole('dialog', { name: '模型设置', exact: true })
	await dialog.waitFor()
	assert.equal(await background(dialog), color, 'custom welcome opens the owning themed portal')
	await page.keyboard.press('Escape')
	await dialog.waitFor({ state: 'detached' })
	assert.equal(await background(workspace.locator('.agent-workspace-thread')), color)
}

// Public package imports exercise the built core/React/UI boundaries with no source aliases.
const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'agent-customization-consumer-'))
let server, browser
try {
	await mkdir(join(root, 'node_modules', '@pluxel'), { recursive: true })
	await Promise.all(
		(await readdir(join(packageRoot, 'node_modules')))
			.filter((name) => !name.startsWith('.') && name !== '@pluxel')
			.map((name) =>
				symlink(join(packageRoot, 'node_modules', name), join(root, 'node_modules', name)),
			),
	)
	await Promise.all(
		[
			['browser-worker-agent', packageRoot],
			['browser-worker-agent-react', join(packageRoot, 'packages/react')],
			['browser-worker-agent-ui', join(packageRoot, 'packages/ui')],
		].map(([name, path]) => symlink(path, join(root, 'node_modules', '@pluxel', name))),
	)
	await Promise.all(
		['customization.html', 'customization.tsx'].map((name) =>
			copyFile(
				join(packageRoot, 'tests/browser', name === 'customization.tsx' ? `${name}.fixture` : name),
				join(root, name),
			),
		),
	)
	const screenshots = join(tmpdir(), 'browser-worker-agent-customization')
	await mkdir(screenshots, { recursive: true })
	execFileSync(
		join(packageRoot, 'node_modules/.bin/tsc'),
		[
			'--noEmit',
			'--skipLibCheck',
			'--types',
			'vite/client',
			'--jsx',
			'react-jsx',
			'--module',
			'esnext',
			'--moduleResolution',
			'bundler',
			'--target',
			'es2023',
			'--lib',
			'es2023,dom,esnext.disposable',
			'customization.tsx',
		],
		{ cwd: root, stdio: 'inherit' },
	)
	const errors = []
	server = await createServer({
		configFile: false,
		plugins: [browserWorkerAgent()],
		root,
		resolve: { conditions: ['browser', 'module', 'production'] },
		optimizeDeps: { entries: ['customization.html'] },
		server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [root, packageRoot] } },
	})
	await server.listen()
	const origin = `http://127.0.0.1:${server.httpServer.address().port}`
	browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
	page.on('pageerror', (error) => errors.push(error.message))
	await page.route('**/*', (route) => {
		if (new URL(route.request().url()).origin === origin) return route.continue()
		errors.push(`Unexpected external request: ${route.request().url()}`)
		return route.abort()
	})
	await page.goto(`${origin}/customization.html`)
	const blue = page.getByTestId('blue-workspace')
	const green = page.getByTestId('green-workspace')
	await blue.getByText('Connected research assistant', { exact: true }).waitFor()
	await green.getByText('Connect your research assistant', { exact: true }).waitFor()
	assert.equal(await background(blue.locator('.agent-workspace-thread')), 'rgb(232, 242, 255)')
	assert.equal(await background(green.locator('.agent-workspace-thread')), 'rgb(234, 250, 236)')
	await checkPortal(page, blue, 'rgb(232, 242, 255)')
	assert.equal(await background(green.locator('.agent-workspace-thread')), 'rgb(234, 250, 236)')
	await checkPortal(page, green, 'rgb(234, 250, 236)')
	assert.equal(await background(blue.locator('.agent-workspace-thread')), 'rgb(232, 242, 255)')
	await blue.getByRole('textbox', { name: '消息', exact: true }).fill('Read the research source')
	await blue.getByRole('button', { name: '发送', exact: true }).click()
	await blue
		.getByTestId('custom-text')
		.filter({ hasText: 'The verified research value is 42.' })
		.waitFor()
	await blue.getByRole('button', { name: /查看处理过程/ }).click()
	await blue
		.getByTestId('custom-tool')
		.filter({ hasText: 'Verified research value: 42.' })
		.waitFor()
	assert.match(await blue.getByTestId('custom-tool').innerText(), /readDoc/)
	assert.deepEqual(await page.evaluate(() => window.customizationState()), {
		acquisitions: 0,
		calls: 2,
		error: null,
	})
	assert.equal(await blue.getByRole('button', { name: '复制消息', exact: true }).count(), 1)
	await page.evaluate(async () => {
		await Promise.all(
			document
				.getAnimations()
				.filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
				.map((animation) => animation.finished.catch(() => {})),
		)
	})
	await page.screenshot({ path: join(screenshots, 'desktop.png'), fullPage: true })
	await page.setViewportSize({ width: 390, height: 844 })
	assert.equal(
		await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
		true,
		'mobile has no horizontal page overflow',
	)
	await page.screenshot({ path: join(screenshots, 'mobile.png'), fullPage: true })
	await green.getByRole('button', { name: 'Custom model setup', exact: true }).click()
	await page.getByRole('dialog', { name: '模型设置', exact: true }).waitFor()
	await page.screenshot({ path: join(screenshots, 'mobile-dialog.png') })
	assert.deepEqual(errors, [], 'no browser errors or external network requests')
	console.log('CUSTOMIZATION ACCEPTED', screenshots)
} finally {
	await browser?.close()
	await server?.close()
	await rm(root, { recursive: true, force: true })
}
