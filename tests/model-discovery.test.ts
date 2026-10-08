import { afterEach, expect, it, vi } from 'vitest'
import { discoverModels } from '../src/model-discovery.ts'

afterEach(() => vi.unstubAllGlobals())

it('discovers searchable IDs from the configured OpenAI-compatible endpoint without leaking credentials in URLs', async () => {
	const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
		Response.json({
			data: [{ id: 'model-b' }, { id: 'model-a', name: 'A' }, { id: 'model-b' }, { id: 42 }],
		}),
	)
	vi.stubGlobal('fetch', fetcher)
	expect(
		await discoverModels({
			api: 'openai-responses',
			baseUrl: 'https://gateway.example/v1/',
			apiKey: 'secret',
		}),
	).toEqual([
		{ id: 'model-a', name: 'A' },
		{ id: 'model-b', name: 'model-b' },
	])
	expect(String(fetcher.mock.calls[0]![0])).toBe('https://gateway.example/v1/models')
	expect(fetcher.mock.calls[0]![1]).toMatchObject({
		headers: { Authorization: 'Bearer secret' },
		credentials: 'omit',
		redirect: 'error',
	})
})

it('uses Anthropic auth and follows bounded model pagination', async () => {
	const fetcher = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(
			Response.json({
				data: [{ id: 'first', display_name: 'First', max_input_tokens: 200000 }],
				has_more: true,
				last_id: 'first',
			}),
		)
		.mockResolvedValueOnce(Response.json({ data: [{ id: 'last' }], has_more: false }))
	vi.stubGlobal('fetch', fetcher)
	const models = await discoverModels({
		api: 'anthropic-messages',
		baseUrl: 'https://api.anthropic.com',
		apiKey: 'secret',
	})
	expect(models[0]).toEqual({ id: 'first', name: 'First', contextWindow: 200000 })
	expect(String(fetcher.mock.calls[1]![0])).toContain('/v1/models?limit=1000&after_id=first')
	expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({
		'x-api-key': 'secret',
		'anthropic-version': '2023-06-01',
	})
})

it('rejects malformed pagination and never echoes a provider error body that may contain secrets', async () => {
	vi.stubGlobal(
		'fetch',
		vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ error: { message: 'secret' } }, { status: 401 })),
	)
	await expect(
		discoverModels({
			api: 'openai-completions',
			baseUrl: 'https://example.com/v1',
			apiKey: 'secret',
		}),
	).rejects.toThrow('HTTP 401')
	vi.stubGlobal(
		'fetch',
		vi
			.fn<typeof fetch>()
			.mockImplementation(async () => Response.json({ data: [], has_more: true, last_id: 'same' })),
	)
	await expect(
		discoverModels({
			api: 'anthropic-messages',
			baseUrl: 'https://example.com/v1',
			apiKey: 'secret',
		}),
	).rejects.toThrow('分页游标')
})

it('does not send requests for unsupported protocols, invalid URLs or aborted input', async () => {
	const fetcher = vi.fn<typeof fetch>()
	vi.stubGlobal('fetch', fetcher)
	await expect(
		discoverModels({ api: 'google-vertex', baseUrl: 'https://example.com', apiKey: 'secret' }),
	).rejects.toThrow('暂不支持')
	await expect(
		discoverModels({
			api: 'openai-responses',
			baseUrl: 'https://user:password@example.com',
			apiKey: 'secret',
		}),
	).rejects.toThrow('凭据')
	await expect(
		discoverModels({
			api: 'openai-completions',
			baseUrl:
				'https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/compat',
			apiKey: 'secret',
		}),
	).rejects.toThrow('运行时参数')
	const controller = new AbortController()
	controller.abort()
	await expect(
		discoverModels(
			{ api: 'openai-responses', baseUrl: 'https://example.com', apiKey: 'secret' },
			controller.signal,
		),
	).rejects.toThrow(/abort/i)
	expect(fetcher).not.toHaveBeenCalled()
})
