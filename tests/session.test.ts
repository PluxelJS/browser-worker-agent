import 'fake-indexeddb/auto'
import { it, expect, vi } from 'vitest'
import {
	createModels,
	fauxProvider,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	InMemoryCredentialStore,
	type AssistantMessage,
	type SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { createAgentSession, compatibleModel } from '../src/session.ts'
import { toThreadMessages } from '../packages/react/src/messages.ts'
import { WorkspaceHistory } from '../src/history.ts'
import { fallbackConversationTitle, TITLE_LIMITS } from '../src/titles.ts'

const documents = [
	{
		id: 'api',
		title: 'Configuration',
		version: '1',
		text: 'Read configuration through the public API.',
	},
]
function fixture(scopeKey: string) {
	const faux = fauxProvider({ tokensPerSecond: 20000, tokenSize: { min: 10, max: 20 } })
	const models = createModels()
	models.setProvider(faux.provider)
	const session = createAgentSession({
		scopeKey,
		documents,
		models,
		model: faux.getModel(),
		apiKey: 'memory-only-key',
		titleGeneration: false,
		acquireApi: () => {
			throw new Error('not part of document tests')
		},
	})
	return { faux, session }
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

function titleFixture() {
	const scopeKey = crypto.randomUUID()
	const faux = fauxProvider({ tokensPerSecond: 100_000, tokenSize: { min: 100, max: 200 } })
	const models = createModels()
	models.setProvider(faux.provider)
	const model = faux.getModel()
	const acquireApi = vi.fn<() => never>(() => {
		throw new Error('Title requests must not acquire business capabilities')
	})
	const session = createAgentSession({
		scopeKey,
		documents,
		models,
		model,
		apiKey: 'memory-only-title-key',
		acquireApi,
	})
	return { scopeKey, faux, models, model, session, acquireApi }
}

it('generates one native title from bounded first-turn text without modifying the agent transcript', async () => {
	const { scopeKey, faux, models, model, session, acquireApi } = titleFixture()
	const complete = vi.spyOn(models, 'completeSimple')
	const intent = '请整理投票流程。'.repeat(100)
	const answer = '已经确认投票配置与校验方式。'.repeat(100)
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxThinking('Private planning must not enter the title request'),
				fauxToolCall('readDoc', { id: 'api' }),
			],
			{ stopReason: 'toolUse' },
		),
		fauxAssistantMessage([fauxThinking('Private final reasoning'), fauxText(answer)]),
		fauxAssistantMessage('标题：“投票流程整理”'),
		fauxAssistantMessage('Follow-up complete'),
		fauxAssistantMessage('Restored follow-up complete'),
	])
	try {
		await session.send(intent)
		await vi.waitFor(() => expect(session.getSnapshot().title).toBe('投票流程整理'))
		expect(faux.state.callCount).toBe(3)
		expect(complete).toHaveBeenCalledOnce()
		const [requestedModel, context, options] = complete.mock.calls[0]!
		expect(requestedModel).toBe(model)
		expect(context.tools).toEqual([])
		expect(context.messages).toHaveLength(1)
		expect(JSON.parse(context.messages[0]!.content as string)).toEqual({
			userIntent: intent.slice(0, TITLE_LIMITS.userCharacters),
			finalResponse: answer.slice(0, TITLE_LIMITS.answerCharacters),
		})
		expect(JSON.stringify(context)).not.toContain('Private')
		expect(JSON.stringify(context)).not.toContain(documents[0]!.text)
		expect(JSON.stringify(context)).not.toContain('readDoc')
		expect(options).toMatchObject({
			apiKey: 'memory-only-title-key',
			env: {},
			maxTokens: 96,
			reasoning: 'minimal',
			maxRetries: 0,
			timeoutMs: 10_000,
			toolChoice: 'none',
		})
		expect(session.getSnapshot().error).toBeNull()
		expect(session.getSnapshot().executions).toEqual([])
		expect(session.getSnapshot().messages).toHaveLength(5)
		expect(
			session.getSnapshot().messages.filter((message) => message.role === 'toolResult'),
		).toHaveLength(1)
		expect(JSON.stringify(session.getSnapshot().messages)).not.toContain('投票流程整理')
		expect(acquireApi).not.toHaveBeenCalled()
		const id = session.getSnapshot().id
		const probe = new WorkspaceHistory()
		expect(await probe.load(scopeKey, id)).toMatchObject({
			title: '投票流程整理',
			titleGenerated: true,
		})
		probe.close()
		expect(await session.exportHistory(id)).not.toContain('memory-only-title-key')
		await session.send('继续确认')
		await session.listHistory()
		expect(faux.state.callCount).toBe(4)
		expect(session.getSnapshot().title).toBe('投票流程整理')
		await session.newConversation()
		await session.restore(id)
		await session.send('继续查看')
		await session.listHistory()
		expect(faux.state.callCount).toBe(5)
		expect(complete).toHaveBeenCalledOnce()
	} finally {
		complete.mockRestore()
		session.dispose()
	}
})

it('uses the original native credential collection for the optional title request', async () => {
	const faux = fauxProvider({ tokensPerSecond: 100_000 })
	const credentials = new InMemoryCredentialStore()
	await credentials.modify(faux.provider.id, async () => ({
		type: 'api_key',
		key: 'native-title-key',
	}))
	faux.provider.auth.apiKey!.resolve = async ({ credential }) =>
		credential?.key ? { auth: { apiKey: credential.key } } : undefined
	const models = createModels({ credentials })
	models.setProvider(faux.provider)
	let nativeTitleOptions: SimpleStreamOptions | undefined
	faux.setResponses([
		fauxAssistantMessage('Native answer'),
		(_context, options) => {
			nativeTitleOptions = options
			return fauxAssistantMessage('Native conversation')
		},
	])
	const session = createAgentSession({
		scopeKey: crypto.randomUUID(),
		documents,
		models,
		model: faux.getModel(),
		acquireApi: () => {
			throw new Error('No business API needed')
		},
	})
	try {
		await session.send('Name a native conversation')
		await vi.waitFor(() => expect(session.getSnapshot().title).toBe('Native conversation'))
		expect(nativeTitleOptions?.apiKey).toBe('native-title-key')
		expect(session.getSnapshot().hasModelKey).toBe(false)
		expect(await session.exportHistory(session.getSnapshot().id)).not.toContain('native-title-key')
	} finally {
		session.dispose()
	}
	const credential = await credentials.read(faux.provider.id)
	expect(credential?.type === 'api_key' && credential.key).toBe('native-title-key')
})

it.each(['error', 'tools', 'thinking'])(
	'keeps a bounded fallback after an optional %s title result and never retries',
	async (outcome) => {
		const { faux, models, session, acquireApi } = titleFixture()
		const complete = vi.spyOn(models, 'completeSimple')
		const intent = '请整理\n投票设置以及后续处理。'.repeat(10)
		faux.setResponses([
			fauxAssistantMessage('Main answer remains successful'),
			outcome === 'error'
				? fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Optional title failed' })
				: outcome === 'tools'
					? fauxAssistantMessage(fauxToolCall('runJavaScript', { code: 'return api.write()' }), {
							stopReason: 'toolUse',
						})
					: fauxAssistantMessage(fauxThinking('No final title')),
			fauxAssistantMessage('Second answer'),
		])
		try {
			await session.send(intent)
			await vi.waitFor(() => expect(faux.state.callCount).toBe(2))
			await session.listHistory()
			expect(session.getSnapshot()).toMatchObject({
				title: fallbackConversationTitle(intent),
				error: null,
				historyError: null,
			})
			expect(session.getSnapshot().title.length).toBeLessThanOrEqual(TITLE_LIMITS.characters)
			expect(session.getSnapshot().executions).toEqual([])
			expect(session.getSnapshot().messages).toHaveLength(3)
			await session.send('Continue after optional naming')
			await session.listHistory()
			expect(faux.state.callCount).toBe(3)
			expect(complete).toHaveBeenCalledOnce()
			expect(acquireApi).not.toHaveBeenCalled()
		} finally {
			complete.mockRestore()
			session.dispose()
		}
	},
)

it.each(['error', 'thinking', 'length'])(
	'does not request a title without a successfully completed final answer (%s)',
	async (outcome) => {
		const { faux, models, session } = titleFixture()
		const complete = vi.spyOn(models, 'completeSimple')
		faux.setResponses([
			outcome === 'error'
				? fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Main turn failed' })
				: outcome === 'thinking'
					? fauxAssistantMessage(fauxThinking('No public final text'))
					: fauxAssistantMessage('Incomplete answer', { stopReason: 'length' }),
		])
		try {
			await session.send('A first request')
			await session.listHistory()
			expect(faux.state.callCount).toBe(1)
			expect(complete).not.toHaveBeenCalled()
			expect(session.getSnapshot().title).toBe('A first request')
			expect(session.getSnapshot().error).toBe(outcome === 'error' ? 'Main turn failed' : null)
		} finally {
			complete.mockRestore()
			session.dispose()
		}
	},
)

it('does not block sending or manual naming on a pending title and gives the manual title priority', async () => {
	const { scopeKey, faux, session } = titleFixture()
	const pending = deferred<AssistantMessage>()
	const started = deferred<AbortSignal>()
	faux.setResponses([
		fauxAssistantMessage('Main turn complete'),
		(_context, options) => {
			started.resolve(options!.signal!)
			return pending.promise
		},
		fauxAssistantMessage('Second turn complete'),
	])
	try {
		await session.send('Please name this conversation')
		const signal = await started.promise
		const id = session.getSnapshot().id
		await session.renameHistory(id, 'My manual title')
		expect(signal.aborted).toBe(true)
		pending.resolve(fauxAssistantMessage('Late model title'))
		await session.send('Continue the manually named conversation')
		await session.listHistory()
		expect(session.getSnapshot().title).toBe('My manual title')
		expect(faux.state.callCount).toBe(3)
		const probe = new WorkspaceHistory()
		expect(await probe.load(scopeKey, id)).toMatchObject({
			title: 'My manual title',
			titleEdited: true,
		})
		probe.close()
	} finally {
		pending.resolve(fauxAssistantMessage('Late model title'))
		session.dispose()
	}
})

it.each(['new', 'delete', 'stop', 'model', 'clear', 'dispose', 'next-send', 'restore'])(
	'cancels pending naming on %s and ignores late provider results',
	async (action) => {
		const { scopeKey, faux, session, acquireApi } = titleFixture()
		const pending = deferred<AssistantMessage>()
		const started = deferred<AbortSignal>()
		faux.setResponses([
			fauxAssistantMessage('First answer'),
			(_context, options) => {
				started.resolve(options!.signal!)
				return pending.promise
			},
			fauxAssistantMessage('Second answer'),
		])
		try {
			await session.send('First intent')
			const signal = await started.promise
			const id = session.getSnapshot().id
			if (action === 'new') await session.newConversation()
			if (action === 'delete') await session.deleteHistory(id)
			if (action === 'stop') session.stop()
			if (action === 'model')
				session.setModel({
					baseUrl: 'https://models.example.test/v1',
					model: 'another-model',
					api: 'openai-responses',
					apiKey: 'changed-model-key',
				})
			if (action === 'clear') session.clearModel()
			if (action === 'dispose') session.dispose()
			if (action === 'next-send') await session.send('Second intent')
			if (action === 'restore') await session.restore(id)
			expect(signal.aborted).toBe(true)
			pending.resolve(fauxAssistantMessage('Late model title'))
			await new Promise((resolve) => setTimeout(resolve, 0))
			const probe = new WorkspaceHistory()
			const retained = await probe.load(scopeKey, id)
			expect(retained === undefined).toBe(action === 'delete')
			expect(retained?.title).toBe(action === 'delete' ? undefined : 'First intent')
			expect(retained?.titleGenerated).toBeUndefined()
			expect(session.getSnapshot().id === id).toBe(action !== 'new' && action !== 'delete')
			expect(session.getSnapshot().title).toBe(
				action === 'new' || action === 'delete' ? '新会话' : 'First intent',
			)
			expect(acquireApi).not.toHaveBeenCalled()
			probe.close()
		} finally {
			pending.resolve(fauxAssistantMessage('Late model title'))
			session.dispose()
		}
	},
)

it('keeps archive metadata when a pending title completes', async () => {
	const { scopeKey, faux, session } = titleFixture()
	const pending = deferred<AssistantMessage>()
	const started = deferred<AbortSignal>()
	faux.setResponses([
		fauxAssistantMessage('First answer'),
		(_context, options) => {
			started.resolve(options!.signal!)
			return pending.promise
		},
	])
	try {
		await session.send('Archive this conversation')
		const signal = await started.promise
		const id = session.getSnapshot().id
		await session.archiveHistory(id, true)
		const archivedAt = session.getSnapshot().archivedAt
		expect(signal.aborted).toBe(false)
		pending.resolve(fauxAssistantMessage('Archived conversation topic'))
		await vi.waitFor(() => expect(session.getSnapshot().title).toBe('Archived conversation topic'))
		expect(session.getSnapshot().archivedAt).toBe(archivedAt)
		const probe = new WorkspaceHistory()
		expect(await probe.load(scopeKey, id)).toMatchObject({
			title: 'Archived conversation topic',
			titleGenerated: true,
			archivedAt,
		})
		probe.close()
	} finally {
		pending.resolve(fauxAssistantMessage('Archived conversation topic'))
		session.dispose()
	}
})

it('keeps optional title persistence failures out of the completed conversation outcome', async () => {
	const { faux, session } = titleFixture()
	const generate = vi
		.spyOn(WorkspaceHistory.prototype, 'generateTitle')
		.mockRejectedValue(new Error('Metadata quota denied'))
	faux.setResponses([
		fauxAssistantMessage('First answer'),
		fauxAssistantMessage('Model title'),
		fauxAssistantMessage('Second answer'),
	])
	try {
		await session.send('Fallback intent')
		await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce())
		await session.listHistory()
		expect(session.getSnapshot()).toMatchObject({
			title: 'Fallback intent',
			error: null,
			historyError: null,
			historySaveState: 'saved',
		})
		await session.send('No automatic retry')
		await session.listHistory()
		expect(generate).toHaveBeenCalledOnce()
		expect(faux.state.callCount).toBe(3)
	} finally {
		generate.mockRestore()
		session.dispose()
	}
})

it('advertises only a validated host entry ID without preloading docs or starting tools', () => {
	const content = 'Unique private contract text only available through readDoc'
	const hostDocuments = [{ id: 'host.start', title: 'Entry', version: '1', text: content }]
	const options = {
		scopeKey: crypto.randomUUID(),
		documents: hostDocuments,
		entryDocumentId: 'host.start',
		acquireApi: () => {
			throw new Error('No automatic API acquisition')
		},
	}
	const session = createAgentSession(options)
	try {
		const prompt = session.getSnapshot().messages.find((message) => message.role === 'system')
		expect(prompt?.role === 'system' && prompt.content).toContain('readDoc({"id":"host.start"})')
		expect(JSON.stringify(session.getSnapshot())).not.toContain(content)
		expect(session.getSnapshot().executions).toEqual([])
		expect(() => createAgentSession({ ...options, entryDocumentId: 'other' })).toThrow(
			'entry document',
		)
	} finally {
		session.dispose()
	}
})
it('borrows native Models credentials without overriding them with an empty key or deleting the host store', async () => {
	const faux = fauxProvider({ tokensPerSecond: 20000 })
	const credentials = new InMemoryCredentialStore()
	await credentials.modify(faux.provider.id, async () => ({
		type: 'api_key',
		key: 'host-model-key',
	}))
	faux.provider.auth.apiKey!.resolve = async ({ credential }) =>
		credential?.key ? { auth: { apiKey: credential.key } } : undefined
	const models = createModels({ credentials })
	models.setProvider(faux.provider)
	const session = createAgentSession({
		scopeKey: crypto.randomUUID(),
		documents,
		models,
		model: faux.getModel(),
		titleGeneration: false,
		acquireApi: () => {
			throw new Error('No execution in native credential test')
		},
	})
	try {
		faux.setResponses([fauxAssistantMessage('Native credentials work')])
		await session.send('Use the host-configured native provider')
		expect(session.getSnapshot().error).toBeNull()
		expect(faux.state.callCount).toBe(1)
		expect(session.getSnapshot().hasModelKey).toBe(false)
		expect(JSON.stringify(session.getSnapshot())).not.toContain('host-model-key')
	} finally {
		session.dispose()
	}
	const stored = await credentials.read(faux.provider.id)
	expect(stored?.type === 'api_key' && stored.key).toBe('host-model-key')
})
it('pi owns document tools, streamed transcript and continuation; restored history never executes', async () => {
	const scopeKey = crypto.randomUUID()
	const { faux, session } = fixture(scopeKey)
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall('searchDocs', { query: 'configuration' })], {
			stopReason: 'toolUse',
		}),
		fauxAssistantMessage([fauxToolCall('readDoc', { id: 'api' })], { stopReason: 'toolUse' }),
		fauxAssistantMessage('Read complete'),
	])
	const frames: number[] = []
	const off = session.subscribe(() => {
		frames.push(session.getSnapshot().messages.length)
	})
	try {
		await session.send('Read docs')
		expect(faux.state.callCount).toBe(3)
		expect(
			session.getSnapshot().messages.filter((message) => message.role === 'toolResult'),
		).toHaveLength(2)
		expect(frames.length).toBeGreaterThan(6)
		const entries = await session.listHistory()
		expect(entries).toHaveLength(1)
		expect(entries[0]!.title).toBe('Read docs')
		expect(entries[0]!.messageCount).toBe(1)
		const storage = new WorkspaceHistory()
		const record = await storage.load(scopeKey, entries[0]!.id)
		expect(JSON.stringify(record)).not.toContain('memory-only-key')
		expect(await storage.list('other-account')).toEqual([])
		storage.close()
		await session.newConversation()
		await session.restore(entries[0]!.id)
		expect(faux.state.callCount).toBe(3)
		expect(
			session.getSnapshot().messages.filter((message) => message.role === 'system'),
		).toHaveLength(1)
		await session.deleteHistory(entries[0]!.id)
		expect(await session.listHistory()).toEqual([])
	} finally {
		off()
		session.dispose()
	}
})

it('renames, archives and exports conversations without resetting models or replaying tools', async () => {
	const scopeKey = crypto.randomUUID()
	const { faux, session } = fixture(scopeKey)
	try {
		faux.setResponses([
			fauxAssistantMessage('First answer'),
			fauxAssistantMessage('Follow-up answer'),
		])
		await session.send('Original auto title')
		const [entry] = await session.listHistory()
		expect(session.getSnapshot()).toMatchObject({
			title: 'Original auto title',
			historySaveState: 'saved',
			historySavedAt: expect.any(Number),
			contextUsage: {
				estimatedTokens: expect.any(Number),
				contextWindow: faux.getModel().contextWindow,
			},
		})
		await session.renameHistory(entry!.id, 'Personal draft')
		await session.renameHistory(entry!.id, '新会话')
		expect(session.getSnapshot().title).toBe('新会话')
		await session.renameHistory(entry!.id, 'Personal draft')
		await session.archiveHistory(entry!.id, true)
		const archivedAt = session.getSnapshot().archivedAt
		await session.send('Continue the same conversation')
		const [updated] = await session.listHistory()
		expect(updated).toMatchObject({
			title: 'Personal draft',
			messageCount: 2,
			archivedAt,
			preview: 'Follow-up answer',
		})
		const exported = await session.exportHistory(entry!.id)
		expect(exported).not.toContain('memory-only-key')
		expect(exported).not.toContain('scopeKey')
		expect(JSON.parse(exported)).toMatchObject({
			version: 1,
			conversation: { id: entry!.id, title: 'Personal draft', archivedAt, executions: [] },
		})
		await session.newConversation()
		await session.restore(entry!.id)
		expect(session.getSnapshot()).toMatchObject({
			id: entry!.id,
			title: 'Personal draft',
			archivedAt,
			historySaveState: 'saved',
		})
		expect(faux.state.callCount).toBe(2)
		expect(session.getSnapshot().isConfigured).toBe(true)
		await session.archiveHistory(entry!.id, false)
		expect(session.getSnapshot().archivedAt).toBeNull()
	} finally {
		session.dispose()
	}
})

it('reports failed saves, retains unsaved memory on navigation and can export, retry or explicitly discard', async () => {
	const { faux, session } = fixture(crypto.randomUUID())
	const save = vi
		.spyOn(WorkspaceHistory.prototype, 'save')
		.mockRejectedValue(new Error('Quota denied'))
	try {
		faux.setResponses([fauxAssistantMessage('Keep this answer')])
		await session.send('Do not lose this request')
		const before = session.getSnapshot()
		await session.listHistory()
		expect(session.getSnapshot()).toMatchObject({
			historySaveState: 'error',
			historySavedAt: null,
			historyError: 'Quota denied',
		})
		await expect(session.newConversation()).rejects.toThrow('尚未保存')
		await expect(session.restore('another')).rejects.toThrow('尚未保存')
		expect(session.getSnapshot().id).toBe(before.id)
		expect(session.getSnapshot().messages).toEqual(before.messages)
		expect(await session.exportHistory(before.id)).toContain('Keep this answer')
		await expect(session.retrySaveHistory()).rejects.toThrow('Quota denied')
		save.mockRestore()
		await session.retrySaveHistory()
		expect(session.getSnapshot()).toMatchObject({
			historySaveState: 'saved',
			historySavedAt: expect.any(Number),
			historyError: null,
		})
		await session.newConversation()
		expect(session.getSnapshot()).toMatchObject({
			title: '新会话',
			historySaveState: 'empty',
			historySavedAt: null,
		})
		const failure = vi
			.spyOn(WorkspaceHistory.prototype, 'save')
			.mockRejectedValue(new Error('Denied'))
		try {
			faux.setResponses([fauxAssistantMessage('Explicit discard answer')])
			await session.send('Explicit discard request')
			await session.listHistory()
			await session.newConversation({ discardUnsaved: true })
			expect(session.getSnapshot().messages.filter((message) => message.role !== 'system')).toEqual(
				[],
			)
		} finally {
			failure.mockRestore()
		}
	} finally {
		save.mockRestore()
		session.dispose()
	}
})

it('rejects management failures without replacing the active transcript and clears successful recovery errors', async () => {
	const { faux, session } = fixture(crypto.randomUUID())
	try {
		faux.setResponses([fauxAssistantMessage('Existing answer')])
		await session.send('Existing conversation')
		const [entry] = await session.listHistory()
		await expect(session.renameHistory(entry!.id, ' ')).rejects.toThrow('80')
		expect(session.getSnapshot().title).toBe('Existing conversation')
		expect(session.getSnapshot().historyError).toContain('80')
		await session.renameHistory(entry!.id, 'Recovered title')
		expect(session.getSnapshot()).toMatchObject({ title: 'Recovered title', historyError: null })
		await expect(session.restore('missing')).rejects.toThrow('当前范围')
		expect(session.getSnapshot().id).toBe(entry!.id)
		const deletion = vi
			.spyOn(WorkspaceHistory.prototype, 'delete')
			.mockRejectedValue(new Error('Delete denied'))
		try {
			await expect(session.deleteHistory(entry!.id)).rejects.toThrow('Delete denied')
			expect(session.getSnapshot().id).toBe(entry!.id)
		} finally {
			deletion.mockRestore()
		}
		await session.deleteHistory(entry!.id)
		expect(session.getSnapshot().id).not.toBe(entry!.id)
		expect(session.getSnapshot().historyError).toBeNull()
		expect(await session.listHistory()).toEqual([])
	} finally {
		session.dispose()
	}
})

it.each(['record', 'error'])(
	'keeps a late history %s from replacing a newer conversation and blocks sending during restoration',
	async (outcome) => {
		const { faux, session } = fixture(crypto.randomUUID())
		const loaded = deferred<void>()
		const release = deferred<void>()
		let load: ReturnType<typeof vi.spyOn> | undefined
		try {
			faux.setResponses([fauxAssistantMessage('Old answer')])
			await session.send('Old conversation')
			const [entry] = await session.listHistory()
			await session.newConversation()
			const actualLoad = WorkspaceHistory.prototype.load
			load = vi.spyOn(WorkspaceHistory.prototype, 'load').mockImplementation(async function (
				this: WorkspaceHistory,
				scopeKey,
				id,
			) {
				const record = await actualLoad.call(this, scopeKey, id)
				loaded.resolve()
				await release.promise
				if (outcome === 'error') throw new Error('Obsolete storage failure')
				return record
			})
			const restoration = session.restore(entry!.id)
			await loaded.promise
			expect(session.getSnapshot().isHistoryLoading).toBe(true)
			await expect(session.send('Must not target old history')).rejects.toThrow('管理操作')
			await session.newConversation()
			const newerId = session.getSnapshot().id
			release.resolve()
			await restoration
			expect(session.getSnapshot()).toMatchObject({
				id: newerId,
				title: '新会话',
				isHistoryLoading: false,
				historySaveState: 'empty',
				historyError: null,
			})
			expect(faux.state.callCount).toBe(1)
		} finally {
			release.resolve()
			load?.mockRestore()
			session.dispose()
		}
	},
)

it('waits for in-flight saves and deletion before closing storage without recreating deleted history', async () => {
	const scopeKey = crypto.randomUUID()
	const { faux, session } = fixture(scopeKey)
	const started = deferred<void>()
	const release = deferred<void>()
	const actualSave = WorkspaceHistory.prototype.save
	const save = vi.spyOn(WorkspaceHistory.prototype, 'save').mockImplementation(async function (
		this: WorkspaceHistory,
		record,
	) {
		started.resolve()
		await release.promise
		return actualSave.call(this, record)
	})
	const storage = new WorkspaceHistory()
	try {
		faux.setResponses([fauxAssistantMessage('Deletion answer')])
		await session.send('Deletion request')
		await started.promise
		const id = session.getSnapshot().id
		expect(session.getSnapshot()).toMatchObject({
			historySaveState: 'saving',
			historySavedAt: null,
		})
		const deletion = session.deleteHistory(id)
		await expect(session.send('Cannot send during deletion')).rejects.toThrow('管理操作')
		session.dispose()
		release.resolve()
		await deletion
		expect(await storage.load(scopeKey, id)).toBeUndefined()
		await new Promise<void>((resolve) => setTimeout(resolve, 0))
		expect(await storage.list(scopeKey)).toEqual([])
	} finally {
		release.resolve()
		save.mockRestore()
		session.dispose()
		storage.close()
	}
})

it('retains unsaved final messages if deleting a pending conversation fails', async () => {
	const { faux, session } = fixture(crypto.randomUUID())
	const started = deferred<void>()
	const release = deferred<void>()
	const actualSave = WorkspaceHistory.prototype.save
	const save = vi.spyOn(WorkspaceHistory.prototype, 'save').mockImplementation(async function (
		this: WorkspaceHistory,
		record,
	) {
		started.resolve()
		await release.promise
		return actualSave.call(this, record)
	})
	const deletion = vi
		.spyOn(WorkspaceHistory.prototype, 'delete')
		.mockRejectedValue(new Error('Delete denied'))
	try {
		faux.setResponses([fauxAssistantMessage('Only final memory copy')])
		await session.send('Preserve this request')
		await started.promise
		const id = session.getSnapshot().id
		const deleting = session.deleteHistory(id)
		release.resolve()
		await expect(deleting).rejects.toThrow('Delete denied')
		expect(session.getSnapshot()).toMatchObject({
			id,
			historySaveState: 'error',
			isHistoryLoading: false,
		})
		await expect(session.newConversation()).rejects.toThrow('尚未保存')
		expect(await session.exportHistory(id)).toContain('Only final memory copy')
		await session.retrySaveHistory()
		expect(session.getSnapshot()).toMatchObject({ historySaveState: 'saved', historyError: null })
		expect((await session.listHistory())[0]!.preview).toBe('Only final memory copy')
	} finally {
		release.resolve()
		save.mockRestore()
		deletion.mockRestore()
		session.dispose()
	}
})
it('provider failures are visible and a subsequent user request can proceed', async () => {
	const { faux, session } = fixture(crypto.randomUUID())
	try {
		faux.setResponses([
			fauxAssistantMessage('', {
				stopReason: 'error',
				errorMessage: 'Controlled provider unavailable',
			}),
		])
		await session.send('fail')
		expect(session.getSnapshot().error).toBe('Controlled provider unavailable')
		expect(session.getSnapshot().isRunning).toBe(false)
		faux.setResponses([fauxAssistantMessage('available')])
		await session.send('again')
		expect(session.getSnapshot().error).toBeNull()
	} finally {
		session.dispose()
	}
})

it('keeps buffered stream text complete without publishing once per tiny delta', async () => {
	const faux = fauxProvider({ tokensPerSecond: 1_000_000, tokenSize: { min: 1, max: 1 } })
	const models = createModels()
	models.setProvider(faux.provider)
	const session = createAgentSession({
		scopeKey: crypto.randomUUID(),
		documents,
		models,
		model: faux.getModel(),
		titleGeneration: false,
		acquireApi: () => {
			throw new Error('No RPC in streaming test')
		},
	})
	const text = 'complete stream '.repeat(300)
	faux.setResponses([fauxAssistantMessage(text)])
	let publications = 0
	const unsubscribe = session.subscribe(() => {
		publications++
	})
	try {
		await session.send('Read the buffered stream')
		const answer = session
			.getSnapshot()
			.messages.findLast((message) => message.role === 'assistant')
		expect(answer?.role === 'assistant' && answer.content).toEqual([{ type: 'text', text }])
		expect(publications).toBeLessThan(text.length / 20)
		expect(session.getSnapshot().isRunning).toBe(false)
	} finally {
		unsubscribe()
		session.dispose()
	}
})

it('returns compact actionable document errors and continues to a corrected contract read', async () => {
	const { faux, session } = fixture(crypto.randomUUID())
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall('readDoc', { id: 'missing' })], { stopReason: 'toolUse' }),
		fauxAssistantMessage(
			[fauxToolCall('readDoc', { id: 'api', startLine: 1, startCharacter: 5 })],
			{ stopReason: 'toolUse' },
		),
		fauxAssistantMessage('Contract corrected'),
	])
	try {
		await session.send('Find the current contract')
		const results = session
			.getSnapshot()
			.messages.filter((message) => message.role === 'toolResult')
		expect(results).toHaveLength(2)
		const failed = results[0]!
		const read = results[1]!
		expect(failed.isError).toBe(true)
		if (failed.content[0]?.type !== 'text' || read.content[0]?.type !== 'text')
			throw new Error('Expected text tools')
		expect(JSON.parse(failed.content[0].text)).toMatchObject({
			error: { code: 'unknown_document', id: 'missing' },
		})
		expect(JSON.parse(read.content[0].text)).toMatchObject({
			text: documents[0]!.text.slice(5),
			startCharacter: 5,
		})
		expect(faux.state.callCount).toBe(3)
		expect(session.getSnapshot().error).toBeNull()
	} finally {
		session.dispose()
	}
})
it('invalid model settings, oversized input and near-full context cannot dispatch', async () => {
	const { session, faux } = fixture(crypto.randomUUID())
	try {
		expect(() =>
			compatibleModel({ baseUrl: 'https://user:secret@example.test/v1', model: 'm', apiKey: 'k' }),
		).toThrow('凭据')
		expect(() =>
			session.setModel({ baseUrl: 'https://example.test/v1', model: 'm', apiKey: '' }),
		).toThrow('API Key')
		await session.send('x'.repeat(32_001))
		expect(session.getSnapshot().error).toContain('输入过长')
		expect(faux.state.callCount).toBe(0)
		faux.setResponses([fauxAssistantMessage('large history '.repeat(300))])
		await session.send('build history')
		session.setModel({
			baseUrl: 'https://example.test/v1',
			model: 'm',
			apiKey: 'k',
			contextWindow: 1024,
		})
		expect(session.getSnapshot().contextWarning).toBe(true)
		await session.send('tiny budget')
		expect(session.getSnapshot().error).toContain('上下文上限')
		expect(faux.state.callCount).toBe(1)
	} finally {
		session.dispose()
	}
})

function memoryModelStorage(): Storage {
	const values = new Map<string, string>()
	return {
		get length() {
			return values.size
		},
		clear: () => values.clear(),
		getItem: (key) => values.get(key) ?? null,
		key: (index) => [...values.keys()][index] ?? null,
		removeItem: (key) => {
			values.delete(key)
		},
		setItem: (key, value) => {
			values.set(key, value)
		},
	}
}
function connectionSession(scopeKey: string, modelStorage?: Storage) {
	return createAgentSession({
		scopeKey,
		documents,
		modelStorage,
		acquireApi: () => {
			throw new Error('Connection settings do not acquire business capabilities')
		},
	})
}
const savedConnection = {
	provider: 'custom',
	api: 'openai-responses' as const,
	baseUrl: 'https://example.test/v1',
	model: 'my-model',
	apiKey: 'tab-scoped-key',
	contextWindow: 32000,
}

it('restores an opted-in connection in its own scope without exposing credentials in snapshots or history', async () => {
	const storage = memoryModelStorage()
	const scope = crypto.randomUUID()
	const first = connectionSession(scope, storage)
	try {
		expect(first.getSnapshot()).toMatchObject({
			isConfigured: false,
			modelSettings: { provider: '', model: '' },
		})
		first.setModel(savedConnection)
		expect(first.getSnapshot().remembersModelConnection).toBe(true)
	} finally {
		first.dispose()
	}
	const restored = connectionSession(scope, storage)
	const other = connectionSession(`${scope}:another-account`, storage)
	try {
		expect(restored.getSnapshot()).toMatchObject({
			isConfigured: true,
			hasModelKey: true,
			modelStorageError: null,
			modelSettings: { model: 'my-model' },
		})
		expect(JSON.stringify(restored.getSnapshot())).not.toContain(savedConnection.apiKey)
		expect(await restored.listHistory()).toEqual([])
		expect(other.getSnapshot()).toMatchObject({ isConfigured: false, hasModelKey: false })
		restored.setModel({ ...savedConnection, model: 'another-model', apiKey: '' })
		expect(restored.getSnapshot().hasModelKey).toBe(true)
		restored.clearModel()
		expect(restored.getSnapshot()).toMatchObject({
			isConfigured: false,
			hasModelKey: false,
			modelSettings: { provider: '', model: '' },
		})
	} finally {
		restored.dispose()
		other.dispose()
	}
	const cleared = connectionSession(scope, storage)
	try {
		expect(cleared.getSnapshot().isConfigured).toBe(false)
	} finally {
		cleared.dispose()
	}
})

it('keeps connections ephemeral when storage was not explicitly supplied', () => {
	const scope = crypto.randomUUID()
	const first = connectionSession(scope)
	try {
		first.setModel(savedConnection)
		expect(first.getSnapshot().remembersModelConnection).toBe(false)
	} finally {
		first.dispose()
	}
	const next = connectionSession(scope)
	try {
		expect(next.getSnapshot().isConfigured).toBe(false)
	} finally {
		next.dispose()
	}
})

it('survives denied storage reads and writes while reporting that the applied connection was not saved', () => {
	const storage = memoryModelStorage()
	storage.getItem = () => {
		throw new DOMException('Denied', 'SecurityError')
	}
	storage.setItem = () => {
		throw new DOMException('Quota', 'QuotaExceededError')
	}
	const session = connectionSession(crypto.randomUUID(), storage)
	try {
		expect(session.getSnapshot()).toMatchObject({
			isConfigured: false,
			modelStorageError: expect.stringContaining('恢复'),
		})
		session.setModel(savedConnection)
		expect(session.getSnapshot()).toMatchObject({
			isConfigured: true,
			hasModelKey: true,
			modelStorageError: expect.stringContaining('未能保存'),
		})
		storage.removeItem = () => {
			throw new DOMException('Denied', 'SecurityError')
		}
		expect(() => session.clearModel()).toThrow('未能移除')
		expect(session.getSnapshot().modelStorageError).toContain('未能移除')
	} finally {
		session.dispose()
	}
})

it('rejects malformed saved connections without preventing a fresh configuration', () => {
	for (const raw of [
		'not-json',
		JSON.stringify({ ...savedConnection, apiKey: 17 }),
		JSON.stringify({ ...savedConnection, baseUrl: 'javascript:alert(1)' }),
	]) {
		const storage = memoryModelStorage()
		const scope = crypto.randomUUID()
		storage.setItem(`agent-workspace:model:v1:${scope}`, raw)
		const session = connectionSession(scope, storage)
		try {
			expect(session.getSnapshot()).toMatchObject({
				isConfigured: false,
				modelStorageError: expect.stringContaining('恢复'),
			})
			session.setModel(savedConnection)
			expect(session.getSnapshot()).toMatchObject({ isConfigured: true, modelStorageError: null })
		} finally {
			session.dispose()
		}
	}
})

it('requires explicit protocol, URL and context size for online models outside the native catalog', () => {
	const session = connectionSession(crypto.randomUUID())
	try {
		const unknown = { provider: 'openai', model: 'unknown-new-model', apiKey: 'native-key' }
		for (const settings of [
			unknown,
			{ ...unknown, api: 'openai-responses' as const },
			{ ...unknown, api: 'openai-responses' as const, baseUrl: 'https://example.test/v1' },
		]) {
			expect(() => session.setModel(settings)).toThrow('目录外模型')
		}
		session.setModel({
			...unknown,
			api: 'openai-responses',
			baseUrl: 'https://example.test/v1',
			contextWindow: 64000,
		})
		expect(session.getSnapshot()).toMatchObject({
			isConfigured: true,
			modelSettings: {
				provider: 'openai',
				model: unknown.model,
				api: 'openai-responses',
				contextWindow: 64000,
			},
		})
	} finally {
		session.dispose()
	}
})

it('never reactivates a completed assistant turn when the next prompt starts', async () => {
	const { faux, session } = fixture(crypto.randomUUID())
	try {
		faux.setResponses([fauxAssistantMessage('First answer'), fauxAssistantMessage('Second answer')])
		await session.send('First prompt')
		const previousId = toThreadMessages(session.getSnapshot()).find(
			(message) => message.role === 'assistant',
		)!.id
		const statuses: Array<string | undefined> = []
		const unsubscribe = session.subscribe(() => {
			statuses.push(
				toThreadMessages(session.getSnapshot()).find((message) => message.id === previousId)?.status
					?.type,
			)
		})
		await session.send('Second prompt')
		unsubscribe()
		expect(statuses.length).toBeGreaterThan(0)
		expect(new Set(statuses)).toEqual(new Set(['complete']))
	} finally {
		session.dispose()
	}
})

it.each([
	{ generation: undefined, modelLimit: 8192, expectedTokens: 4096, expectedTimeout: 60_000 },
	{
		generation: { maxTokens: 9000, timeoutMs: 120_000 },
		modelLimit: 2048,
		expectedTokens: 2048,
		expectedTimeout: 120_000,
	},
	{
		generation: { maxTokens: 1000, timeoutMs: 5000 },
		modelLimit: 8192,
		expectedTokens: 1000,
		expectedTimeout: 5000,
	},
])(
	'applies the generation budget to real model requests: $expectedTokens tokens',
	async ({ generation, modelLimit, expectedTokens, expectedTimeout }) => {
		const faux = fauxProvider({ tokensPerSecond: 100_000 })
		const models = createModels()
		models.setProvider(faux.provider)
		const stream = vi.spyOn(models, 'streamSimple')
		const session = createAgentSession({
			scopeKey: crypto.randomUUID(),
			documents,
			models,
			model: { ...faux.getModel(), maxTokens: modelLimit },
			generation,
			timeoutMs: 123,
			titleGeneration: false,
			acquireApi: () => {
				throw new Error('Unexpected acquisition')
			},
		})
		faux.setResponses([fauxAssistantMessage('Budget accepted')])
		try {
			await session.send('Hello')
			expect(session.getSnapshot().error).toBeNull()
			expect(stream).toHaveBeenCalledOnce()
			expect(stream.mock.calls[0]![2]).toMatchObject({
				maxTokens: expectedTokens,
				timeoutMs: expectedTimeout,
				maxRetries: 0,
				signal: expect.any(AbortSignal),
			})
		} finally {
			session.dispose()
			stream.mockRestore()
		}
	},
)

it.each(['maxTokens', 'timeoutMs'] as const)(
	'rejects invalid generation.%s before starting a session',
	(key) => {
		for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() =>
				createAgentSession({
					scopeKey: crypto.randomUUID(),
					documents,
					acquireApi: () => {
						throw new Error('Unexpected acquisition')
					},
					generation: { [key]: value },
				}),
			).toThrow(`generation.${key} must be a positive safe integer.`)
		}
	},
)

it('passes the host Worker factory through tool execution and releases its API lease on failure', async () => {
	const faux = fauxProvider({ tokensPerSecond: 100_000 })
	const models = createModels()
	models.setProvider(faux.provider)
	const release = vi.fn()
	const createWorker = vi.fn(() => {
		throw new Error('Host factory failure')
	})
	const session = createAgentSession({
		scopeKey: crypto.randomUUID(),
		documents,
		models,
		model: faux.getModel(),
		titleGeneration: false,
		createWorker,
		acquireApi: () => ({ api: {} as import('../src/rpc.ts').ApiLease['api'], release }),
	})
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall('runJavaScript', { code: 'return await api.readDto();' }), {
			stopReason: 'toolUse',
		}),
	])
	try {
		await session.send('Read the API')
		expect(createWorker).toHaveBeenCalledOnce()
		expect(release).toHaveBeenCalledOnce()
		expect(session.getSnapshot().executions).toMatchObject([
			{ status: 'execution_error', error: 'Host factory failure' },
		])
		expect(faux.state.callCount).toBe(1)
	} finally {
		session.dispose()
	}
})
