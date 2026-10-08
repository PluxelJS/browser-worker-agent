import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { createModels, fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai'
import { createAgentSession, type ModelChoice } from '../src/session.ts'
import type { BrowserModelApi, ModelSettings } from '../src/models.ts'

afterEach(() => vi.unstubAllGlobals())

function sessionFixture() {
	return createAgentSession({
		scopeKey: crypto.randomUUID(),
		documents: [],
		acquireApi: () => {
			throw new Error('No execution in model-choice tests')
		},
	})
}

const customSettings: ModelSettings = {
	provider: 'custom',
	api: 'openai-responses',
	baseUrl: 'https://gateway.example/v1',
	model: 'selected',
	contextWindow: 16_000,
	apiKey: 'connection-secret',
}

function selectChoice(choice: ModelChoice, provider: string): ModelSettings {
	return {
		provider,
		model: choice.id,
		api: choice.api as BrowserModelApi,
		baseUrl: choice.baseUrl,
		contextWindow: choice.contextWindow,
		apiKey: '',
	}
}

it('retains discovered custom choices for the applied connection and switches without another key', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				data: [
					{ id: 'remote-a', name: 'Remote A', context_length: 64_000 },
					{ id: 'remote-b', api: 'anthropic-messages' },
				],
			}),
		),
	)
	const session = sessionFixture()
	try {
		const unconfigured = session.getModelChoices()
		expect(session.getModelChoices()).toBe(unconfigured)
		await session.discoverModels({ ...customSettings, baseUrl: 'https://gateway.example/v1/' })
		expect(session.getModelChoices()).toEqual([])
		session.setModel(customSettings)
		const applied = session.getModelChoices()
		expect(applied).not.toBe(unconfigured)
		expect(session.getModelChoices()).toBe(applied)
		expect(session.getModelChoices()).toEqual([
			{
				id: 'selected',
				name: 'selected',
				api: 'openai-responses',
				baseUrl: customSettings.baseUrl,
				contextWindow: 16_000,
				source: 'current',
			},
			{
				id: 'remote-a',
				name: 'Remote A',
				api: 'openai-responses',
				baseUrl: customSettings.baseUrl,
				contextWindow: 64_000,
				source: 'online',
			},
			{
				id: 'remote-b',
				name: 'remote-b',
				api: 'openai-responses',
				baseUrl: customSettings.baseUrl,
				contextWindow: 32_000,
				source: 'online',
			},
		])
		session.setModel(selectChoice(session.getModelChoices()[2]!, 'custom'))
		expect(session.getModelChoices()).not.toBe(applied)
		expect(session.getSnapshot().modelSettings).toMatchObject({
			model: 'remote-b',
			api: 'openai-responses',
			contextWindow: 32_000,
		})
		expect(session.getModelChoices().map((choice) => choice.id)).toEqual(['remote-a', 'remote-b'])
		expect(JSON.stringify([session.getSnapshot(), session.getModelChoices()])).not.toContain(
			'connection-secret',
		)
		session.clearModel()
		expect(session.getModelChoices()).toEqual([])
		session.setModel(customSettings)
		expect(session.getModelChoices().map((choice) => choice.id)).toEqual(['selected'])
	} finally {
		session.dispose()
	}
})

it('uses catalog metadata for known native models and explicit defaults for unknown online IDs', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				data: [{ id: 'gpt-4o-mini', context_length: 1024 }, { id: 'new-model' }],
			}),
		),
	)
	const session = sessionFixture()
	try {
		session.setModel({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'native-secret' })
		const reference = session.getModelChoices()
		await session.discoverModels({ provider: 'openai', model: 'gpt-4o-mini', apiKey: '' })
		expect(session.getModelChoices()).not.toBe(reference)
		const known = session.getModelChoices().find((choice) => choice.id === 'gpt-4o-mini')!
		expect(known.contextWindow).toBe(128_000)
		const unknown = session.getModelChoices().find((choice) => choice.id === 'new-model')!
		expect(unknown).toMatchObject({
			api: 'openai-responses',
			contextWindow: 32_000,
			source: 'online',
		})
		session.setModel(selectChoice(unknown, 'openai'))
		expect(session.getSnapshot().modelSettings.model).toBe('new-model')
		expect(session.getModelChoices().map((choice) => choice.id)).toEqual([
			'gpt-4o-mini',
			'new-model',
		])
	} finally {
		session.dispose()
	}
})

it('does not attach a list fetched with a different key until that exact connection is applied', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ id: 'private-model' }] })),
	)
	const session = sessionFixture()
	try {
		session.setModel(customSettings)
		await session.discoverModels({ ...customSettings, apiKey: 'other-secret' })
		expect(session.getModelChoices().map((choice) => choice.id)).toEqual(['selected'])
		session.setModel({ ...customSettings, apiKey: 'other-secret' })
		expect(session.getModelChoices().some((choice) => choice.id === 'private-model')).toBe(true)
		session.setModel(customSettings)
		expect(session.getModelChoices().map((choice) => choice.id)).toEqual(['selected'])
		expect(JSON.stringify([session.getSnapshot(), session.getModelChoices()])).not.toContain(
			'secret',
		)
	} finally {
		session.dispose()
	}
})

it.each([
	{ name: 'endpoint', change: { ...customSettings, baseUrl: 'https://other.example/v1' } },
	{ name: 'protocol', change: { ...customSettings, api: 'openai-completions' as const } },
	{
		name: 'provider',
		change: { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'native-secret' },
	},
])('clears online choices across $name changes', async ({ change }) => {
	vi.stubGlobal(
		'fetch',
		vi
			.fn<typeof fetch>()
			.mockImplementation(async () => Response.json({ data: [{ id: 'online-only' }] })),
	)
	const session = sessionFixture()
	try {
		session.setModel(customSettings)
		await session.discoverModels({ ...customSettings, apiKey: '' })
		const online = session.getModelChoices()
		expect(online.some((choice) => choice.source === 'online')).toBe(true)
		session.setModel(change)
		expect(session.getModelChoices()).not.toBe(online)
		expect(session.getModelChoices().some((choice) => choice.id === 'online-only')).toBe(false)
	} finally {
		session.dispose()
	}
})

it('clears online choices when provider configuration changes', async () => {
	vi.stubGlobal(
		'fetch',
		vi
			.fn<typeof fetch>()
			.mockImplementation(async () => Response.json({ data: [{ id: 'online-only' }] })),
	)
	const session = sessionFixture()
	try {
		const provider = session
			.getModelProviders()
			.find((entry) => entry.id === 'cloudflare-ai-gateway')!
		const model = provider.models.find((entry) => entry.api === 'openai-responses')!
		const cloudflare: ModelSettings = {
			provider: provider.id,
			model: model.id,
			api: 'openai-responses',
			baseUrl: 'https://gateway.example/v1',
			apiKey: 'cloudflare-secret',
			env: { CLOUDFLARE_ACCOUNT_ID: 'first', CLOUDFLARE_GATEWAY_ID: 'gateway' },
		}
		session.setModel(cloudflare)
		await session.discoverModels({ ...cloudflare, apiKey: '' })
		expect(session.getModelChoices().some((choice) => choice.source === 'online')).toBe(true)
		session.setModel({ ...cloudflare, env: { ...cloudflare.env, CLOUDFLARE_ACCOUNT_ID: 'second' } })
		expect(session.getModelChoices().some((choice) => choice.id === 'online-only')).toBe(false)
	} finally {
		session.dispose()
	}
})

it('rejects superseded or externally cancelled discoveries even when fetch ignores abort', async () => {
	let resolveOld!: (response: Response) => void
	const fetcher = vi
		.fn<typeof fetch>()
		.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveOld = resolve
				}),
		)
		.mockResolvedValueOnce(Response.json({ data: [{ id: 'fresh' }] }))
	vi.stubGlobal('fetch', fetcher)
	const session = sessionFixture()
	try {
		session.setModel(customSettings)
		const pending = session.discoverModels({ ...customSettings, apiKey: '' })
		const oldOutcome = pending.catch((error: unknown) => error)
		await session.discoverModels({ ...customSettings, apiKey: '' })
		resolveOld(Response.json({ data: [{ id: 'stale' }] }))
		await expect(oldOutcome).resolves.toMatchObject({ name: 'AbortError' })
		expect(session.getModelChoices().map((choice) => choice.id)).toEqual(['selected', 'fresh'])
		let resolveCancelled!: (response: Response) => void
		fetcher.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveCancelled = resolve
				}),
		)
		const controller = new AbortController()
		const cancelled = session.discoverModels({ ...customSettings, apiKey: '' }, controller.signal)
		const cancelledOutcome = cancelled.catch((error: unknown) => error)
		controller.abort()
		resolveCancelled(Response.json({ data: [{ id: 'cancelled' }] }))
		await expect(cancelledOutcome).resolves.toMatchObject({ name: 'AbortError' })
		expect(session.getModelChoices().map((choice) => choice.id)).toEqual(['selected', 'fresh'])
	} finally {
		session.dispose()
	}
})

it.each(['clear', 'dispose'] as const)(
	'invalidates pending and retained choices on %s',
	async (close) => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockImplementation(async () => Response.json({ data: [{ id: 'ready' }] }))
		vi.stubGlobal('fetch', fetcher)
		const session = sessionFixture()
		try {
			session.setModel(customSettings)
			await session.discoverModels({ ...customSettings, apiKey: '' })
			const ready = session.getModelChoices()
			expect(ready.some((choice) => choice.id === 'ready')).toBe(true)
			let resolvePending!: (response: Response) => void
			fetcher.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolvePending = resolve
					}),
			)
			const pending = session.discoverModels({ ...customSettings, apiKey: '' })
			const outcome = pending.catch((error: unknown) => error)
			if (close === 'clear') session.clearModel()
			else session.dispose()
			resolvePending(Response.json({ data: [{ id: 'late' }] }))
			await expect(outcome).resolves.toMatchObject({ name: 'AbortError' })
			expect(session.getModelChoices()).toEqual([])
			expect(session.getModelChoices()).not.toBe(ready)
		} finally {
			session.dispose()
		}
	},
)

it('retains a stable model-choice array throughout streamed message updates', async () => {
	const faux = fauxProvider({ tokensPerSecond: 20_000, tokenSize: { min: 2, max: 3 } })
	const models = createModels()
	models.setProvider(faux.provider)
	const session = createAgentSession({
		scopeKey: crypto.randomUUID(),
		documents: [],
		acquireApi: () => {
			throw new Error('No RPC in model-choice streaming test')
		},
		models,
		model: faux.getModel(),
		apiKey: 'injected-secret',
	})
	const choices = session.getModelChoices()
	const frames: Array<readonly ModelChoice[]> = []
	const unsubscribe = session.subscribe(() => frames.push(session.getModelChoices()))
	try {
		faux.setResponses([fauxAssistantMessage('Streamed message updates retain model choices.')])
		await session.send('Reply using the configured model')
		expect(session.getSnapshot().error).toBeNull()
		expect(frames.length).toBeGreaterThan(2)
		expect(frames.every((frame) => frame === choices)).toBe(true)
		expect(session.getModelChoices()).toBe(choices)
	} finally {
		unsubscribe()
		session.dispose()
	}
})
