import assert from 'node:assert/strict'

/** Runs against the real assistant-ui model form and session, with only the remote models endpoint controlled. */
export async function runDiscoveryChecks(page, origin, chooseProvider) {
	let requests = 0
	let mode = 'success'
	let releaseSlow
	let markSlowStarted
	const slowStarted = new Promise((resolve) => {
		markSlowStarted = resolve
	})
	const routePattern = `${origin}/discovery/v1/models`
	await page.route(routePattern, async (route) => {
		requests++
		assert.equal(route.request().headers().authorization, 'Bearer discovery-key')
		if (mode === 'error')
			return route.fulfill({ status: 401, json: { error: 'credential rejected' } })
		if (mode === 'slow')
			await new Promise((resolve) => {
				releaseSlow = resolve
				markSlowStarted()
			})
		await route
			.fulfill({
				json: {
					data: [
						{ id: 'online-only-model', name: 'Online only model' },
						{ id: 'online-other-model', name: 'Other online model' },
					],
				},
			})
			.catch(() => {})
	})
	const fetchButton = () => page.getByRole('button', { name: /^(在线获取模型|刷新在线模型)$/ })
	const settings = page.locator('form[aria-label="模型设置"]')
	async function reopen() {
		await page.getByRole('button', { name: '模型设置', exact: true }).click()
		await settings.waitFor()
	}
	async function clear() {
		await page.getByRole('button', { name: '清除连接', exact: true }).click()
		await settings.waitFor({ state: 'hidden' })
	}
	async function switchFromComposer() {
		const before = await page.evaluate(() => window.workspaceSession.getSnapshot().modelSettings)
		const requestsBefore = requests
		const composer = page.getByRole('textbox', { name: '消息', exact: true })
		await composer.fill('在线切换保留未发送的草稿。')
		await composer.evaluate((element) => {
			element.focus()
			element.setSelectionRange(4, 4)
		})
		await page.getByRole('combobox', { name: '当前模型', exact: true }).click()
		await page
			.getByRole('combobox', { name: '搜索当前供应商模型', exact: true })
			.fill('online-other')
		await page
			.getByRole('option')
			.filter({ has: page.getByText('Other online model', { exact: true }) })
			.click()
		await page.waitForFunction(
			() =>
				window.workspaceSession.getSnapshot().modelSettings.model === 'online-other-model' &&
				document.activeElement?.getAttribute('aria-label') === '消息',
		)
		assert.equal(await settings.count(), 0, 'online model switching does not reopen settings')
		assert.equal(await composer.inputValue(), '在线切换保留未发送的草稿。')
		assert.equal(await composer.evaluate((element) => element.selectionStart), 4)
		const after = await page.evaluate(() => window.workspaceSession.getSnapshot())
		assert.equal(after.modelSettings.provider, before.provider)
		assert.equal(
			after.modelSettings.api,
			before.api,
			'a models listing does not select the protocol',
		)
		assert.equal(after.modelSettings.baseUrl, before.baseUrl)
		assert.equal(after.hasModelKey, true)
		assert.equal(requests, requestsBefore, 'model switching uses the already fetched choices')
		assert(!JSON.stringify(after).includes('discovery-key'))
		await composer.fill('')
	}
	try {
		await page.getByLabel('Base URL', { exact: true }).fill(`${origin}/discovery/v1`)
		await page.getByLabel('API Key', { exact: true }).fill('discovery-key')
		assert.equal(requests, 0, 'editing connection fields does not send credentials automatically')
		await fetchButton().click()
		await page.getByText(/在线返回 2/).waitFor()
		await page.getByRole('combobox', { name: '在线模型', exact: true }).click()
		await page.getByRole('combobox', { name: '搜索在线模型', exact: true }).fill('online-only')
		await page
			.getByRole('option')
			.filter({ has: page.getByText('Online only model', { exact: true }) })
			.click()
		assert.equal(
			await page.getByLabel('模型 ID', { exact: true }).inputValue(),
			'online-only-model',
		)
		await page.getByRole('button', { name: '应用模型设置', exact: true }).click()
		await settings.waitFor({ state: 'hidden' })
		assert.equal(
			await page.evaluate(() => window.workspaceSession.getSnapshot().modelSettings.model),
			'online-only-model',
		)
		await switchFromComposer()
		await reopen()
		await clear()
		await reopen()
		await chooseProvider('openai')
		await page.getByRole('button', { name: /高级设置/ }).click()
		await page.getByLabel('Base URL', { exact: true }).fill(`${origin}/discovery/v1`)
		await page.getByLabel('API Key', { exact: true }).fill('discovery-key')
		await fetchButton().click()
		await page.getByText(/在线返回 2/).waitFor()
		await page.getByRole('combobox', { name: '模型', exact: true }).click()
		await page.getByRole('combobox', { name: '搜索模型', exact: true }).fill('online-only')
		await page
			.getByRole('option')
			.filter({ has: page.getByText('Online only model', { exact: true }) })
			.click()
		await page.getByRole('button', { name: '应用模型设置', exact: true }).click()
		await settings.waitFor({ state: 'hidden' })
		assert.equal(
			await page.evaluate(() => window.workspaceSession.getSnapshot().modelSettings.provider),
			'openai',
		)
		await switchFromComposer()
		await reopen()
		assert.equal(
			await page.getByLabel('模型 ID', { exact: true }).inputValue(),
			'online-other-model',
			'unknown catalog models remain editable after reopening',
		)
		await clear()
		await reopen()
		await chooseProvider('custom')
		await page.getByLabel('Base URL', { exact: true }).fill(`${origin}/discovery/v1`)
		await page.getByLabel('API Key', { exact: true }).fill('discovery-key')
		mode = 'error'
		await fetchButton().click()
		await page.getByRole('alert').filter({ hasText: 'HTTP 401' }).waitFor()
		await page.getByLabel('模型 ID', { exact: true }).fill('manual-fallback')
		mode = 'slow'
		await fetchButton().click()
		await Promise.race([
			slowStarted,
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error('Slow discovery request did not start')), 5000),
			),
		])
		await page.getByLabel('Base URL', { exact: true }).fill(`${origin}/other/v1`)
		releaseSlow()
		await fetchButton().waitFor()
		assert.equal(
			await page.getByText(/在线返回 2/).count(),
			0,
			'a changed endpoint cannot display stale results',
		)
		await page.getByRole('button', { name: '取消', exact: true }).click()
		await settings.waitFor({ state: 'hidden' })
		await reopen()
		await chooseProvider('custom')
		console.log(
			'MODEL DISCOVERY',
			JSON.stringify({
				requests,
				search: true,
				unknownNative: true,
				composerSwitch: true,
				manualFallback: true,
				staleGuard: true,
			}),
		)
	} finally {
		releaseSlow?.()
		await page.unroute(routePattern)
	}
}
