import {
	createProvider,
	envApiKeyAuth,
	type Api,
	type Model,
	type Models,
	type ProviderStreams,
} from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'
import { googleVertexApi } from '@earendil-works/pi-ai/api/google-vertex.lazy'
import { azureOpenAIResponsesApi } from '@earendil-works/pi-ai/api/azure-openai-responses.lazy'
import { mistralConversationsApi } from '@earendil-works/pi-ai/api/mistral-conversations.lazy'
import { piMessagesApi } from '@earendil-works/pi-ai/api/pi-messages.lazy'

/** Browser chat protocols implemented by the pinned pi version, not a separate provider API. */
export const CUSTOM_MODEL_APIS = [
	{ id: 'openai-completions', label: 'OpenAI Chat Completions' },
	{ id: 'openai-responses', label: 'OpenAI Responses' },
	{ id: 'anthropic-messages', label: 'Anthropic Messages' },
	{ id: 'google-generative-ai', label: 'Google Gemini' },
	{ id: 'google-vertex', label: 'Google Vertex AI（API Key）' },
	{ id: 'azure-openai-responses', label: 'Azure OpenAI Responses' },
	{ id: 'mistral-conversations', label: 'Mistral Conversations' },
	{ id: 'pi-messages', label: 'pi Messages / Radius' },
] as const
export type BrowserModelApi = (typeof CUSTOM_MODEL_APIS)[number]['id']
export type ModelSettings = {
	/** Omitted for compatibility with the original custom OpenAI-compatible settings. */
	provider?: string
	api?: BrowserModelApi
	baseUrl?: string
	model: string
	apiKey: string
	contextWindow?: number
	/** Only the selected provider's declared, non-secret configuration fields are accepted. */
	env?: Record<string, string>
}
export type SafeModelSettings = {
	provider: string
	api: Api
	baseUrl: string
	model: string
	contextWindow: number
	env: Record<string, string>
}
export type ModelConfigField = {
	name: string
	label: string
	required?: boolean
	placeholder?: string
	type?: 'url' | 'text'
	help?: string
}
/** Display metadata only. Models and request behavior still belong to native pi providers. */
export type ModelProviderOption = {
	id: string
	name: string
	models: readonly Model<Api>[]
	fields: readonly ModelConfigField[]
	unavailableReason?: string
	note?: string
}
const azureFields: readonly ModelConfigField[] = [
	{
		name: 'AZURE_OPENAI_BASE_URL',
		label: 'Azure Endpoint',
		required: true,
		type: 'url',
		placeholder: 'https://your-resource.openai.azure.com',
	},
	{
		name: 'AZURE_OPENAI_API_VERSION',
		label: 'Azure API Version',
		placeholder: 'v1',
	},
	{
		name: 'AZURE_OPENAI_DEPLOYMENT_NAME_MAP',
		label: 'Azure 部署名称映射',
		placeholder: 'gpt-4o-mini=my-deployment',
		help: '部署名不同于模型 ID 时填写 model=deployment；多个映射用逗号分隔。',
	},
]
const cloudflareAccount: ModelConfigField = {
	name: 'CLOUDFLARE_ACCOUNT_ID',
	label: 'Cloudflare Account ID',
	required: true,
}
const cloudflareGateway: ModelConfigField = {
	name: 'CLOUDFLARE_GATEWAY_ID',
	label: 'Cloudflare Gateway ID',
	required: true,
}
export function getModelConfigFields(provider: string, api: string): readonly ModelConfigField[] {
	if (provider === 'azure') return azureFields
	// A custom Azure connection already has a required Base URL; it is also its endpoint.
	if (provider === 'custom' && api === 'azure-openai-responses') return azureFields.slice(1)
	if (provider === 'cloudflare-ai-gateway') return [cloudflareAccount, cloudflareGateway]
	if (provider === 'cloudflare-workers-ai') return [cloudflareAccount]
	return []
}
export function isBrowserModelApi(api: string): api is BrowserModelApi {
	return CUSTOM_MODEL_APIS.some((entry) => entry.id === api)
}
export function modelProviderOptions(models: Models): readonly ModelProviderOption[] {
	return models
		.getProviders()
		.map((provider) => {
			const chat = models.getModels(provider.id).filter((model) => isBrowserModelApi(model.api))
			const unavailableReason =
				provider.id === 'amazon-bedrock'
					? 'pi 的 Bedrock 实现只支持 Node，不能在浏览器执行。'
					: !provider.auth.apiKey
						? '此供应商需要 OAuth；pi 的 OAuth 登录只支持 Node。'
						: !chat.length
							? '此供应商没有浏览器可用的 Agent 对话模型。'
							: undefined
			return {
				id: provider.id,
				name: provider.name,
				models: chat,
				fields: getModelConfigFields(provider.id, chat[0]?.api ?? ''),
				unavailableReason,
				note:
					provider.id === 'google-vertex'
						? '使用 Google Cloud API Key；浏览器不读取 ADC 或服务账号文件。'
						: provider.id === 'github-copilot'
							? '填写有效的 Copilot 推理 token；普通 GitHub PAT 不会自动兑换，此页面不执行 OAuth 登录或 token 刷新。'
							: undefined,
			}
		})
		.toSorted((a, b) => a.name.localeCompare(b.name))
}

export function validateModelBaseUrl(value: string): string {
	let url: URL
	try {
		url = new URL(value.trim())
	} catch {
		throw new Error('Base URL 必须是有效的 HTTP(S) API 地址。')
	}
	if (
		!['https:', 'http:'].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error('Base URL 必须是 HTTP(S) API 地址，不能包含凭据、查询或片段。')
	return url.href.replace(/\/+$/, '')
}
export function validateContextWindow(value: number): number {
	if (!Number.isInteger(value) || value < 1024 || value > 2_000_000)
		throw new Error('上下文窗口必须为 1024 至 2000000 的整数。')
	return value
}
export function modelConfigEnv(
	provider: string,
	api: string,
	input: Record<string, string> = {},
): Record<string, string> {
	const fields =
		provider === 'custom' && api === 'azure-openai-responses'
			? azureFields
			: getModelConfigFields(provider, api)
	if (Object.keys(input).some((name) => !fields.some((field) => field.name === name)))
		throw new Error('包含此供应商不支持的配置字段；不要把密钥放入配置字段。')
	const env: Record<string, string> = {}
	for (const field of fields) {
		const value = input[field.name]?.trim() ?? ''
		if (field.required && !value) throw new Error(`请填写 ${field.label}。`)
		if (value.length > 4096) throw new Error(`${field.label} 过长。`)
		if (!value) continue
		if (field.type === 'url') env[field.name] = validateModelBaseUrl(value)
		else {
			if (value.includes('\r') || value.includes('\n') || value.includes('\0'))
				throw new Error(`${field.label} 不能包含换行或空字符。`)
			if (field.name.startsWith('CLOUDFLARE_') && !/^[\w-]+$/.test(value))
				throw new Error(`${field.label} 只能包含字母、数字、下划线和连字符。`)
			env[field.name] = value
		}
	}
	return env
}

const customApis: Record<BrowserModelApi, () => ProviderStreams> = {
	'openai-completions': openAICompletionsApi,
	'openai-responses': openAIResponsesApi,
	'anthropic-messages': anthropicMessagesApi,
	'google-generative-ai': googleGenerativeAIApi,
	'google-vertex': googleVertexApi,
	'azure-openai-responses': azureOpenAIResponsesApi,
	'mistral-conversations': mistralConversationsApi,
	'pi-messages': piMessagesApi,
}
export function customModel(settings: ModelSettings): Model<BrowserModelApi> {
	const api = settings.api ?? 'openai-completions'
	if (!isBrowserModelApi(api)) throw new Error('请选择浏览器支持的模型协议。')
	if (!settings.model.trim()) throw new Error('请填写模型 ID。')
	const contextWindow = validateContextWindow(settings.contextWindow ?? 32_000)
	return {
		id: settings.model.trim(),
		name: settings.model.trim(),
		api,
		provider: 'workspace-custom',
		baseUrl: validateModelBaseUrl(settings.baseUrl ?? ''),
		reasoning: false,
		input: ['text'],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: Math.min(4096, Math.floor(contextWindow / 4)),
		...(api === 'openai-completions'
			? { compat: { supportsDeveloperRole: false, supportsStore: false } }
			: {}),
	}
}
export function customModelProvider(model: Model<BrowserModelApi>) {
	return createProvider({
		id: model.provider,
		name: '自定义供应商',
		auth: { apiKey: envApiKeyAuth('API Key', []) },
		models: [model],
		api: customApis[model.api](),
	})
}
