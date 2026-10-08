import { expect, it } from 'vitest'
import { createAgentSession } from '../src/session.ts'
import { CUSTOM_MODEL_APIS } from '../src/models.ts'
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all'

function settingsSession() {
	return createAgentSession({
		scopeKey: crypto.randomUUID(),
		documents: [],
		acquireApi: () => {
			throw new Error('No execution in settings test')
		},
	})
}

it('retains an injected native endpoint override so a blank key cannot migrate to another endpoint', () => {
	const session = createAgentSession({
		scopeKey: crypto.randomUUID(),
		documents: [],
		acquireApi: () => {
			throw new Error('No execution')
		},
		model: { ...getBuiltinModel('openai', 'gpt-4o-mini')!, baseUrl: 'https://gateway.example/v1' },
		apiKey: 'injected-key',
	})
	try {
		expect(session.getSnapshot().modelSettings.baseUrl).toBe('https://gateway.example/v1')
		expect(() =>
			session.setModel({ provider: 'openai', model: 'gpt-4o-mini', apiKey: '' }),
		).toThrow('API Key')
		expect(() =>
			session.setModel({
				provider: 'openai',
				model: 'gpt-4o-mini',
				baseUrl: 'https://gateway.example/v1',
				apiKey: '',
			}),
		).not.toThrow()
	} finally {
		session.dispose()
	}
})

it('projects reusable model settings without exposing the in-memory credential', () => {
	const session = createAgentSession({
		scopeKey: crypto.randomUUID(),
		documents: [],
		acquireApi: () => {
			throw new Error('No execution in settings test')
		},
	})
	try {
		expect(session.getSnapshot().modelSettings).toEqual({
			provider: '',
			api: 'openai-responses',
			baseUrl: '',
			env: {},
			model: '',
			contextWindow: 128_000,
		})
		session.setModel({
			baseUrl: 'https://provider.example/v1',
			model: 'workspace-model',
			contextWindow: 16_384,
			apiKey: 'memory-only-model-secret',
		})
		expect(session.getSnapshot().modelSettings).toEqual({
			provider: 'custom',
			api: 'openai-completions',
			env: {},
			baseUrl: 'https://provider.example/v1',
			model: 'workspace-model',
			contextWindow: 16_384,
		})
		expect(JSON.stringify(session.getSnapshot())).not.toContain('memory-only-model-secret')
	} finally {
		session.dispose()
	}
})

it.each(['amazon-bedrock', 'openai-codex'])(
	'blocks the Node-only provider %s before changing the active connection',
	(provider) => {
		const session = settingsSession()
		try {
			expect(() => session.setModel({ provider, model: 'any', apiKey: 'explicit-key' })).toThrow(
				'Node',
			)
			expect(session.getSnapshot().isConfigured).toBe(false)
		} finally {
			session.dispose()
		}
	},
)

it('validates required endpoint fields and rejects hidden credential env before changing an active model', () => {
	const session = settingsSession()
	try {
		session.setModel({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'retained-key' })
		const current = session.getSnapshot().modelSettings
		expect(() =>
			session.setModel({
				provider: 'azure',
				model: 'gpt-4o-mini',
				apiKey: 'azure-key',
			}),
		).toThrow('Azure Endpoint')
		expect(() =>
			session.setModel({
				provider: 'openai',
				model: 'gpt-4o-mini',
				apiKey: 'key',
				env: { OPENAI_API_KEY: 'hidden-secret' },
			}),
		).toThrow('不支持的配置字段')
		expect(() =>
			session.setModel({ provider: 'openai', model: 'invented-model', apiKey: 'key' }),
		).toThrow('目录')
		expect(session.getSnapshot().modelSettings).toEqual(current)
		expect(JSON.stringify(session.getSnapshot())).not.toContain('retained-key')
	} finally {
		session.dispose()
	}
})

it('retains a key in memory for the same provider while requiring a new key for another credential scope', () => {
	const session = settingsSession()
	try {
		session.setModel({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'retained-openai-key' })
		session.setModel({ provider: 'openai', model: 'gpt-4o', apiKey: '' })
		expect(() =>
			session.setModel({ provider: 'google', model: 'gemini-2.5-flash', apiKey: '' }),
		).toThrow('API Key')
		expect(() =>
			session.setModel({
				provider: 'openai',
				model: 'gpt-4o-mini',
				baseUrl: 'https://other.example/v1',
				apiKey: '',
			}),
		).toThrow('API Key')
		session.setModel({
			baseUrl: 'https://custom.example/v1',
			model: 'one',
			apiKey: 'retained-custom-key',
		})
		session.setModel({ baseUrl: 'https://custom.example/v1/', model: 'two', apiKey: '' })
		expect(() =>
			session.setModel({ baseUrl: 'https://other.example/v1', model: 'two', apiKey: '' }),
		).toThrow('API Key')
		expect(() =>
			session.setModel({
				baseUrl: 'https://custom.example/v1',
				api: 'anthropic-messages',
				model: 'two',
				apiKey: '',
			}),
		).toThrow('API Key')
		expect(JSON.stringify(session.getSnapshot())).not.toContain('retained-')
	} finally {
		session.dispose()
	}
})

it('validates custom protocols and projects non-secret provider configuration without exposing mutable auth inputs', () => {
	const session = settingsSession()
	try {
		for (const { id: api } of CUSTOM_MODEL_APIS) {
			session.setModel({
				provider: 'custom',
				api,
				baseUrl: 'https://custom.example/api',
				model: 'custom-model',
				apiKey: 'custom-secret',
			})
			expect(session.getSnapshot().modelSettings.api).toBe(api)
		}
		expect(() =>
			session.setModel({
				baseUrl: 'https://user:credential@custom.example',
				model: 'model',
				apiKey: 'key',
			}),
		).toThrow('凭据')
		session.setModel({
			provider: 'azure',
			model: 'gpt-4o-mini',
			apiKey: 'azure-secret',
			env: {
				AZURE_OPENAI_BASE_URL: 'https://resource.openai.azure.com',
				AZURE_OPENAI_DEPLOYMENT_NAME_MAP: 'gpt-4o-mini=deployment',
			},
		})
		session.getSnapshot().modelSettings.env.AZURE_OPENAI_BASE_URL = 'https://changed.example'
		expect(() =>
			session.setModel({
				provider: 'azure',
				model: 'gpt-4o-mini',
				apiKey: '',
				env: {
					AZURE_OPENAI_BASE_URL: 'https://changed.example',
					AZURE_OPENAI_DEPLOYMENT_NAME_MAP: 'gpt-4o-mini=deployment',
				},
			}),
		).toThrow('API Key')
		expect(JSON.stringify(session.getSnapshot())).not.toContain('azure-secret')
	} finally {
		session.dispose()
	}
})

it('uses a single Azure custom address and rejects conflicting endpoints before dispatch', () => {
	const session = settingsSession()
	try {
		session.setModel({
			provider: 'custom',
			api: 'azure-openai-responses',
			baseUrl: 'https://custom.example/openai/v1',
			model: 'deployment',
			apiKey: 'azure-secret',
		})
		expect(session.getSnapshot().modelSettings.env.AZURE_OPENAI_BASE_URL).toBe(
			'https://custom.example/openai/v1',
		)
		session.setModel({
			provider: 'custom',
			api: 'azure-openai-responses',
			baseUrl: 'https://custom.example/openai/v1/',
			model: 'deployment',
			apiKey: '',
		})
		expect(() =>
			session.setModel({
				provider: 'custom',
				api: 'azure-openai-responses',
				baseUrl: 'https://custom.example/openai/v1',
				model: 'deployment',
				apiKey: 'new-key',
				env: { AZURE_OPENAI_BASE_URL: 'https://other.example' },
			}),
		).toThrow('一致')
		expect(() =>
			session.setModel({
				provider: 'azure',
				baseUrl: 'https://custom.example/openai/v1',
				model: 'gpt-4o-mini',
				apiKey: 'new-key',
				env: { AZURE_OPENAI_BASE_URL: 'https://other.example' },
			}),
		).toThrow('一致')
	} finally {
		session.dispose()
	}
})

it('rejects a foreign protocol for an unknown native model before changing the connection', () => {
	const session = settingsSession()
	try {
		expect(() =>
			session.setModel({
				provider: 'openai',
				api: 'anthropic-messages',
				model: 'unknown',
				baseUrl: 'https://api.openai.com/v1',
				contextWindow: 32000,
				apiKey: 'secret',
			}),
		).toThrow('不支持所选协议')
		expect(session.getSnapshot().isConfigured).toBe(false)
	} finally {
		session.dispose()
	}
})

it('uses DeepSeek Responses with system-role compatibility for catalog and discovered models', () => {
	const session = settingsSession()
	try {
		const deepseek = session.getModelProviders().find((provider) => provider.id === 'deepseek')!
		for (const model of deepseek.models) {
			expect(model.api).toBe('openai-responses')
			expect(model.compat).toEqual({
				supportsDeveloperRole: false,
				supportsLongCacheRetention: false,
			})
			session.setModel({ provider: 'deepseek', model: model.id, apiKey: 'explicit-key' })
			expect(session.getSnapshot().modelSettings.api).toBe('openai-responses')
		}
		session.setModel({
			provider: 'deepseek',
			model: 'discovered-deepseek-model',
			api: 'openai-responses',
			baseUrl: 'https://api.deepseek.com',
			contextWindow: 32000,
			apiKey: 'explicit-key',
		})
		expect(session.getSnapshot().modelSettings.api).toBe('openai-responses')
		// A deliberately configured legacy-compatible endpoint still uses the selected protocol.
		session.setModel({
			provider: 'custom',
			api: 'openai-completions',
			model: 'deepseek-flash',
			baseUrl: 'https://api.deepseek.com',
			apiKey: 'explicit-key',
		})
		expect(session.getSnapshot().modelSettings.api).toBe('openai-completions')
	} finally {
		session.dispose()
	}
})

it('uses Responses for global Moonshot K3 and preserves its native model metadata', () => {
	const session = settingsSession()
	try {
		const moonshot = session.getModelProviders().find((provider) => provider.id === 'moonshotai')!
		const model = moonshot.models.find((entry) => entry.id === 'kimi-k3')!
		const original = getBuiltinModel('moonshotai', 'kimi-k3')!
		expect(model).toEqual({
			...original,
			api: 'openai-responses',
			compat: {
				supportsDeveloperRole: true,
				supportsMidConvoSystemMessages: true,
				supportsLongCacheRetention: false,
			},
		})
		session.setModel({ provider: 'moonshotai', model: model.id, apiKey: 'explicit-key' })
		expect(session.getSnapshot().modelSettings.api).toBe('openai-responses')
	} finally {
		session.dispose()
	}
})

it('retains the protocol of an explicitly injected native Moonshot K3 model', () => {
	const session = createAgentSession({
		scopeKey: crypto.randomUUID(),
		documents: [],
		model: getBuiltinModel('moonshotai', 'kimi-k3')!,
		apiKey: 'explicit-key',
		acquireApi: () => {
			throw new Error('No execution in settings test')
		},
	})
	try {
		expect(session.getSnapshot().modelSettings.api).toBe('openai-completions')
	} finally {
		session.dispose()
	}
})
