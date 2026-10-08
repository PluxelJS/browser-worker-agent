import { RpcStub, RpcTarget } from 'capnweb'
import type { Api, Model } from '@earendil-works/pi-ai'
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all'
import { createAgentSession, type AgentSession } from '../../src/session.ts'
import {
	CUSTOM_MODEL_APIS,
	type BrowserModelApi,
	type ModelProviderOption,
	type ModelSettings,
} from '../../src/models.ts'

const SECRET = 'controlled-memory-only-native-key'
const documents = [
	{
		id: 'api',
		title: 'Configuration public API',
		version: '1',
		text: 'api.currentDto() returns {revision:number,name:string}. Read configuration through await api.currentDto().',
	},
]
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
function assert(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message)
}
async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	deadline = Date.now() + 10_000,
): Promise<void> {
	if (await predicate()) return
	if (Date.now() > deadline) throw new Error('Timed out waiting for native provider stream')
	await pause(10)
	return waitFor(predicate, deadline)
}
class ConfigurationApi extends RpcTarget {
	calls = 0
	currentDto() {
		this.calls++
		return { revision: 7, name: 'Native provider configuration' }
	}
}
function fixture(id: string, injectedModel?: Model<Api>) {
	const target = new ConfigurationApi()
	const host = new RpcStub(target)
	let releases = 0
	const session = createAgentSession({
		titleGeneration: false,
		scopeKey: `native-provider-${id}-${crypto.randomUUID()}`,
		documents,
		model: injectedModel,
		apiKey: injectedModel ? SECRET : undefined,
		acquireApi: () => {
			const api = host.dup()
			return {
				api,
				release: () => {
					releases++
					api[Symbol.dispose]()
				},
			}
		},
	})
	return { session, target, host, releases: () => releases }
}
type NativeRequest = {
	url: string
	headers: Record<string, string>
	body: Record<string, unknown>
	toolResults: number
}
type NativeStats = { requests: NativeRequest[]; closed: number }
async function register(
	id: string,
	api: BrowserModelApi,
	mode: 'loop' | 'stop' | 'error',
	builtin = false,
): Promise<void> {
	const response = await fetch('/__providers/control', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ id, api, mode, builtin }),
	})
	assert(response.ok, 'Controlled fixture registered')
}
async function stats(id: string): Promise<NativeStats> {
	const response = await fetch(`/__providers/stats?id=${encodeURIComponent(id)}`)
	return response.json() as Promise<NativeStats>
}
function customSettings(id: string, api: BrowserModelApi): ModelSettings {
	const baseUrl = `${location.origin}/__providers/${id}`
	return {
		provider: 'custom',
		api,
		baseUrl,
		model: 'controlled',
		apiKey: SECRET,
		contextWindow: 32_000,
	}
}
function assistantText(session: AgentSession): string {
	return session
		.getSnapshot()
		.messages.filter((message) => message.role === 'assistant')
		.flatMap((message) =>
			message.content.filter((part) => part.type === 'text').map((part) => part.text),
		)
		.join('')
}
function assertAuthorization(api: BrowserModelApi, request: NativeRequest): void {
	if (api === 'anthropic-messages') {
		assert(request.headers['x-api-key'] === SECRET, 'Native Anthropic API key header')
		assert(
			request.headers['anthropic-dangerous-direct-browser-access'] === 'true',
			'Native Anthropic browser access header',
		)
	} else if (api === 'google-generative-ai' || api === 'google-vertex') {
		assert(
			request.headers['x-goog-api-key'] === SECRET || request.url.includes(`key=${SECRET}`),
			`Native ${api} explicit API key`,
		)
	} else if (api === 'azure-openai-responses') {
		assert(request.headers['api-key'] === SECRET, 'Native Azure API key header')
	} else {
		assert(request.headers.authorization === `Bearer ${SECRET}`, `Native ${api} bearer header`)
	}
}
async function verifyLoop(
	id: string,
	api: BrowserModelApi,
	settings: ModelSettings,
	builtin = false,
	injectedModel?: Model<Api>,
): Promise<NativeStats> {
	await register(id, api, 'loop', builtin)
	const instance = fixture(id, injectedModel)
	let streamed = false
	const off = instance.session.subscribe(() => {
		const text = assistantText(instance.session)
		if (
			instance.session.getSnapshot().isRunning &&
			text.includes(`native ${api}: `) &&
			(builtin || !text.includes('verified revision 7'))
		)
			streamed = true
	})
	try {
		if (!injectedModel) instance.session.setModel(settings)
		await instance.session.send('Read configuration through documents and the public API.')
		const snapshot = instance.session.getSnapshot()
		assert(!snapshot.error, `${id} native stream error: ${snapshot.error}`)
		if (
			settings.provider === 'deepseek' ||
			(settings.provider === 'moonshotai' && api === 'openai-responses')
		) {
			assert(
				snapshot.messages.some(
					(message) =>
						message.role === 'assistant' &&
						message.content.some(
							(part) =>
								part.type === 'thinking' &&
								part.thinking === 'Inspect the requested workspace data.',
						),
				),
				`${id} native reasoning events become pi thinking content`,
			)
		}
		assert(!snapshot.isRunning && !snapshot.stopped, `${id} completed pi loop`)
		assert(
			snapshot.messages.filter((message) => message.role === 'toolResult').length === 3,
			`${id} pi holds all native tool results`,
		)
		assert(
			snapshot.executions[0]?.status === 'completed' && snapshot.executions[0]?.value === 7,
			`${id} real Worker result`,
		)
		assert(
			snapshot.executions[0]?.outputs.some((line) =>
				line.includes('Native provider configuration'),
			),
			`${id} real Worker output`,
		)
		assert(
			instance.target.calls === 1 && instance.releases() === 1,
			`${id} RPC dispatch and lease released once`,
		)
		assert(
			assistantText(instance.session).endsWith(`native ${api}: verified revision 7`),
			`${id} native streamed final text`,
		)
		assert(
			streamed,
			`${id} ${builtin ? 'native text' : 'intermediate text'} reached running pi state`,
		)
		assert(!JSON.stringify(snapshot).includes(SECRET), `${id} API key absent from projected state`)
		const result = await stats(id)
		assert(
			result.requests.length === 4,
			`${id} exactly four native requests; got ${result.requests.length}`,
		)
		assert(
			result.requests.map((request) => request.toolResults).join(',') === '0,1,2,3',
			`${id} native toolResult conversion`,
		)
		if (!builtin) assertAuthorization(api, result.requests[0]!)
		const history = await instance.session.listHistory()
		assert(history.length === 1, `${id} native transcript persisted`)
		await instance.session.newConversation()
		await instance.session.restore(history[0]!.id)
		assert(
			instance.session.getSnapshot().executions[0]?.value === 7,
			`${id} native history restores Worker feedback`,
		)
		assert(
			!JSON.stringify(instance.session.getSnapshot()).includes(SECRET),
			`${id} API key absent from native history`,
		)
		assert(
			(await stats(id)).requests.length === 4 && instance.target.calls === 1,
			`${id} native history never replays provider or RPC`,
		)
		await instance.host.currentDto()
		assert(
			Number(instance.target.calls) === 2,
			`${id} shared host capability survives Worker cleanup`,
		)
		return result
	} finally {
		off()
		instance.session.dispose()
		instance.host[Symbol.dispose]()
	}
}
async function verifyStop(api: BrowserModelApi): Promise<void> {
	const id = `${api}_stop`
	await register(id, api, 'stop')
	const instance = fixture(id)
	try {
		instance.session.setModel(customSettings(id, api))
		const running = instance.session.send('Stream text until stopped.')
		await waitFor(() => assistantText(instance.session).includes(`native ${api}: `))
		const started = performance.now()
		instance.session.stop()
		await running
		assert(performance.now() - started < 1000, `${api} native stream abort settles promptly`)
		const snapshot = instance.session.getSnapshot()
		assert(snapshot.stopped && !snapshot.isRunning, `${api} stop state`)
		assert(!JSON.stringify(snapshot).includes(SECRET), `${api} stopped state contains no API key`)
		assert(
			!assistantText(instance.session).includes('verified revision 7'),
			`${api} late stream text rejected`,
		)
		assert(
			instance.target.calls === 0 && snapshot.executions.length === 0,
			`${api} stopping text dispatches no RPC`,
		)
		const result = await stats(id)
		assert(result.requests.length === 1, `${api} abort never retries the provider`)
		await waitFor(async () => (await stats(id)).closed === 1)
	} finally {
		instance.session.dispose()
		instance.host[Symbol.dispose]()
	}
}
async function verifyError(api: BrowserModelApi): Promise<void> {
	const id = `${api}_error`
	await register(id, api, 'error')
	const instance = fixture(id)
	try {
		instance.session.setModel(customSettings(id, api))
		await instance.session.send('Return the controlled HTTP error.')
		assert(
			instance.session.getSnapshot().error?.includes('CONTROLLED_NATIVE_HTTP_503'),
			`${api} native HTTP error reaches workspace: ${instance.session.getSnapshot().error}`,
		)
		assert(
			!instance.session.getSnapshot().isRunning && instance.target.calls === 0,
			`${api} error returns idle without RPC`,
		)
		assert(
			!JSON.stringify(instance.session.getSnapshot()).includes(SECRET),
			`${api} native error diagnostics contain no API key`,
		)
		assert((await stats(id)).requests.length === 1, `${api} HTTP503 has no SDK or pi retry`)
	} finally {
		instance.session.dispose()
		instance.host[Symbol.dispose]()
	}
}
function findModel(
	providers: readonly ModelProviderOption[],
	provider: string,
	api?: BrowserModelApi,
) {
	const entry = providers.find((item) => item.id === provider)
	assert(
		entry && !entry.unavailableReason,
		`${provider} native provider available with explicit key`,
	)
	const available = entry.models.filter((item) => !api || item.api === api)
	const model = available.find((item) => !item.reasoning) ?? available[0]
	assert(model, `${provider} native ${api ?? 'chat'} model present`)
	return model
}
async function verifyBuiltin(
	providers: readonly ModelProviderOption[],
	provider: string,
	api?: BrowserModelApi,
	modelId?: string,
): Promise<void> {
	const model = modelId
		? providers
				.find((entry) => entry.id === provider)!
				.models.find((entry) => entry.id === modelId)!
		: findModel(providers, provider, api)
	const protocol = model.api as BrowserModelApi
	const id = `builtin_${provider}_${protocol}${modelId ? `_${modelId.replace(/[^a-z0-9_-]/gi, '_')}` : ''}`
	const env: Record<string, string> =
		provider === 'azure'
			? {
					AZURE_OPENAI_BASE_URL: 'https://controlled-resource.openai.azure.com',
					AZURE_OPENAI_API_VERSION: '2025-04-01-preview',
					AZURE_OPENAI_DEPLOYMENT_NAME_MAP: `${model.id}=controlled-deployment`,
				}
			: provider.startsWith('cloudflare-')
				? {
						CLOUDFLARE_ACCOUNT_ID: 'controlled-account',
						...(provider === 'cloudflare-ai-gateway'
							? { CLOUDFLARE_GATEWAY_ID: 'controlled-gateway' }
							: {}),
					}
				: {}
	const result = await verifyLoop(
		id,
		protocol,
		{ provider, model: model.id, apiKey: SECRET, env },
		true,
	)
	const request = result.requests[0]!
	if (protocol === 'google-generative-ai' || protocol === 'google-vertex')
		assert(decodeURIComponent(request.url).includes(model.id), `${provider} native model in URL`)
	else
		assert(
			request.body.model ===
				(provider === 'azure' ? 'controlled-deployment' : model.id),
			`${provider} native model parameters retained`,
		)
	if (provider === 'azure') {
		assert(
			request.url.includes('controlled-resource.openai.azure.com') &&
				request.url.includes('api-version=2025-04-01-preview'),
			'Azure environment selects resource and API version',
		)
	} else if (provider.startsWith('cloudflare-')) {
		assert(
			request.url.includes('controlled-account') && !request.url.includes('%7B'),
			`${provider} native account placeholder materialized`,
		)
		if (provider === 'cloudflare-ai-gateway') {
			assert(
				request.url.includes('controlled-gateway'),
				'Cloudflare gateway placeholder materialized',
			)
			assert(
				request.headers['cf-aig-authorization'] === `Bearer ${SECRET}`,
				'Cloudflare native authentication uses gateway header',
			)
			assert(
				!request.headers.authorization && !request.headers['x-api-key'],
				'Cloudflare gateway native auth removes upstream key headers',
			)
		} else assertAuthorization(protocol, request)
	} else {
		assertAuthorization(protocol, request)
		if (provider === 'openai')
			assert(
				request.url.startsWith('https://api.openai.com/v1/responses'),
				'OpenAI native factory keeps Responses endpoint',
			)
		if (provider === 'deepseek') {
			assert(protocol === 'openai-responses', 'DeepSeek defaults to Responses')
			assert(request.url === 'https://api.deepseek.com/responses', 'DeepSeek Responses endpoint')
			assert(Array.isArray(request.body.input), 'DeepSeek input is a transcript')
			assert(
				request.body.input.some((item: { role?: string }) => item.role === 'system'),
				'DeepSeek keeps system instructions',
			)
			assert(
				!request.body.input.some((item: { role?: string }) => item.role === 'developer'),
				'DeepSeek does not downgrade system instructions to developer/user',
			)
			for (const followup of result.requests.slice(1)) {
				assert(Array.isArray(followup.body.input), 'DeepSeek followup is a transcript')
				assert(
					followup.body.input.some(
						(item: { type?: string; content?: Array<{ type: string; text: string }> }) =>
							item.type === 'reasoning' &&
							item.content?.some(
								(part) =>
									part.type === 'reasoning_text' &&
									part.text === 'Inspect the requested workspace data.',
							),
					),
					'DeepSeek plain reasoning content survives tool-turn replay',
				)
			}
		}
		if (provider === 'moonshotai') {
			assert(
				request.url ===
					`https://api.moonshot.ai/v1/${protocol === 'openai-responses' ? 'responses' : 'chat/completions'}`,
				'Moonshot keeps its global endpoint and selected model protocol',
			)
			if (model.id === 'kimi-k3') {
				assert(protocol === 'openai-responses', 'Moonshot K3 defaults to Responses')
				assert(Array.isArray(request.body.input), 'Kimi input is a transcript')
				assert(
					request.body.input.some((item: { role?: string }) => item.role === 'developer'),
					'Kimi developer role carries system instructions',
				)
				assert(
					!request.body.input.some((item: { role?: string }) => item.role === 'system'),
					'Kimi input uses only the documented message roles',
				)
				for (const followup of result.requests) {
					assert(!followup.body.reasoning, 'Kimi uses its default supported reasoning effort')
					assert(!followup.body.include, 'Kimi does not request OpenAI encrypted reasoning')
					assert(
						!followup.body.prompt_cache_retention,
						'Kimi does not receive OpenAI cache retention fields',
					)
				}
				for (const followup of result.requests.slice(1)) {
					assert(Array.isArray(followup.body.input), 'Kimi followup is a transcript')
					assert(
						followup.body.input.some(
							(item: { type?: string; summary?: Array<{ type: string; text: string }> }) =>
								item.type === 'reasoning' &&
								item.summary?.some(
									(part) =>
										part.type === 'summary_text' &&
										part.text === 'Inspect the requested workspace data.',
								),
						),
						'Kimi reasoning summary survives tool-turn replay',
					)
				}
			}
		}
		if (provider === 'anthropic')
			assert(
				request.url.startsWith('https://api.anthropic.com/v1/messages'),
				'Anthropic native factory keeps Messages endpoint',
			)
		if (provider === 'google')
			assert(
				request.url.startsWith('https://generativelanguage.googleapis.com/'),
				'Google native factory keeps Gemini endpoint',
			)
		if (provider === 'google-vertex')
			assert(
				request.url.includes('aiplatform.googleapis.com/'),
				'Vertex explicit key uses browser SDK endpoint without ADC',
			)
	}
}

async function runNativeProviderBrowserTests() {
	const results: Array<{ name: string; durationMs: number }> = []
	async function test(name: string, run: () => Promise<unknown>): Promise<void> {
		const started = performance.now()
		await run()
		results.push({ name, durationMs: Math.round(performance.now() - started) })
	}
	const catalog = fixture('catalog')
	const providers = catalog.session.getModelProviders()
	assert(providers.length === 42, `All42 pi native providers exposed, found ${providers.length}`)
	assert(
		providers.find((provider) => provider.id === 'amazon-bedrock')?.unavailableReason,
		'Node-only Bedrock exposed with unavailable reason',
	)
	assert(
		providers.find((provider) => provider.id === 'openai-codex')?.unavailableReason,
		'Node OAuth provider exposed with unavailable reason',
	)
	catalog.session.dispose()
	catalog.host[Symbol.dispose]()
	results.push({ name: 'all42 native provider metadata and browser availability', durationMs: 0 })
	// The route fixture owns the active default endpoint. Native provider tests intentionally
	// run serially so requests, cancellation and retry counts belong to exactly one owner.
	const protocolTests = CUSTOM_MODEL_APIS.flatMap(({ id: api }) => [
		() =>
			test(`${api} native SSE → docs → Worker RPC → pi tool feedback`, () =>
				verifyLoop(`${api}_loop`, api, customSettings(`${api}_loop`, api))),
		() => test(`${api} native streaming cancellation without network retry`, () => verifyStop(api)),
		() => test(`${api} native HTTP503 error without network retry`, () => verifyError(api)),
	])
	const builtinTests = [
		'openai',
		'deepseek',
		'anthropic',
		'google',
		'google-vertex',
		'azure',
		'cloudflare-workers-ai',
		'mistral',
		'radius',
	].map(
		(provider) => () =>
			test(`${provider} native factory model, endpoint and authentication`, () =>
				verifyBuiltin(providers, provider)),
	)
	const gatewayTests = (['openai-responses', 'anthropic-messages'] as const).map(
		(api) => () =>
			test(`Cloudflare gateway ${api} native dispatch and scoped environment`, () =>
				verifyBuiltin(providers, 'cloudflare-ai-gateway', api)),
	)
	const deepseekPro = () =>
		test('DeepSeek Pro Responses reasoning and tool replay', () =>
			verifyBuiltin(providers, 'deepseek', 'openai-responses', 'deepseek-v4-pro'))
	const moonshotTests = [
		() =>
			test('Moonshot K3 Responses reasoning and tool replay', () =>
				verifyBuiltin(providers, 'moonshotai', 'openai-responses', 'kimi-k3')),
		() =>
			test('Moonshot K2.6 keeps native Chat Completions', () =>
				verifyBuiltin(providers, 'moonshotai', 'openai-completions', 'kimi-k2.6')),
		() =>
			test('Explicit native Moonshot K3 injection retains Chat Completions dispatch', async () => {
				const model = getBuiltinModel('moonshotai', 'kimi-k3')!
				const result = await verifyLoop(
					'builtin_moonshotai_injected_kimi-k3',
					'openai-completions',
					{ provider: 'moonshotai', model: model.id, apiKey: SECRET },
					true,
					model,
				)
				assert(
					result.requests.every(
						(request) => request.url === 'https://api.moonshot.ai/v1/chat/completions',
					),
					'Injected model keeps native Chat Completions through every tool turn',
				)
			}),
	]
	await [...protocolTests, ...builtinTests, deepseekPro, ...moonshotTests, ...gatewayTests].reduce(
		(previous, runTest) => previous.then(runTest),
		Promise.resolve(),
	)
	return {
		passed: results.length,
		providers: providers.length,
		protocols: CUSTOM_MODEL_APIS.length,
		cases: results,
		credentials:
			'Controlled localhost fixtures only; no real provider credentials or external connections.',
	}
}
Object.assign(window, { runNativeProviderBrowserTests })
