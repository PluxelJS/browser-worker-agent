import { createProvider, type Api, type Model } from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'

/** DeepSeek's Responses endpoint treats developer messages as user messages. */
export function deepseekResponsesModel(model: Model<Api>): Model<'openai-responses'> {
	return {
		...model,
		api: 'openai-responses',
		// Do not carry Chat Completions-specific reasoning/strict-mode flags across protocols.
		compat: { supportsDeveloperRole: false, supportsLongCacheRetention: false },
	}
}

export function workspaceBuiltinModels() {
	const models = builtinModels({
		// Explicit browser credentials only; never read the host's environment or files.
		authContext: { env: async () => undefined, fileExists: async () => false },
	})
	const deepseek = models.getProvider('deepseek')!
	// pi 1.1.0's DeepSeek factory predates its Responses support. Keep pi's current
	// model metadata/auth and native streaming adapter, with provider-specific compatibility.
	// https://api-docs.deepseek.com/guides/responses_api/
	models.setProvider(
		createProvider<'openai-responses' | 'openai-completions'>({
			id: deepseek.id,
			name: deepseek.name,
			baseUrl: deepseek.baseUrl,
			auth: deepseek.auth,
			models: deepseek.getModels().map(deepseekResponsesModel),
			api: {
				'openai-responses': openAIResponsesApi(),
				// Explicit injected pi models retain their protocol and dispatch correctly.
				'openai-completions': openAICompletionsApi(),
			},
		}),
	)
	const moonshot = models.getProvider('moonshotai')!
	// The global Moonshot endpoint documents Responses for K3 only. Older models
	// and the separate China/Coding endpoints keep their native protocol.
	// https://platform.kimi.ai/docs/api/responses
	models.setProvider(
		createProvider({
			id: moonshot.id,
			name: moonshot.name,
			baseUrl: moonshot.baseUrl,
			auth: moonshot.auth,
			models: moonshot.getModels().map((model) =>
				model.id === 'kimi-k3'
					? {
							...model,
							api: 'openai-responses',
							compat: {
								// Kimi treats developer messages as system instructions.
								supportsDeveloperRole: true,
								supportsMidConvoSystemMessages: true,
								// Kimi uses its own 5m/1h cache tiers, not OpenAI's 24h field.
								supportsLongCacheRetention: false,
							},
						}
					: model,
			),
			api: {
				'openai-responses': openAIResponsesApi(),
				'openai-completions': openAICompletionsApi(),
			},
		}),
	)
	return models
}
