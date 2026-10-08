import {
	createModels,
	fauxProvider,
	fauxAssistantMessage,
	fauxToolCall,
} from '@earendil-works/pi-ai'
import { RpcStub, RpcTarget } from 'capnweb'
import { createAgentSession } from '../../src/session.ts'
import { WorkspaceHistory, type StoredWorkspaceHistory } from '../../src/history.ts'

const pause = (milliseconds: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
const documents = [
	{
		id: 'review-api',
		title: 'Review configuration API',
		version: '1',
		text: 'api.readDto() reads the configuration. api.fail() rejects. Always await RPC.',
	},
]

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message)
}

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	deadline = Date.now() + 5000,
): Promise<void> {
	if (await predicate()) return
	if (Date.now() > deadline) throw new Error('Timed out waiting for lifecycle state')
	await pause(10)
	return waitFor(predicate, deadline)
}

class ReviewApi extends RpcTarget {
	constructor(private readonly onHold: () => void) {
		super()
	}
	readDto() {
		return { revision: 3 }
	}
	fail() {
		throw new Error('Controlled RPC rejection')
	}
	async hold() {
		this.onHold()
		await pause(300)
		return 'late old result'
	}
}

function fixture(scopeKey: string, tokensPerSecond = 50_000) {
	const faux = fauxProvider({ tokensPerSecond, tokenSize: { min: 1, max: 3 } })
	const models = createModels()
	models.setProvider(faux.provider)
	let holding = false
	let releases = 0
	const shared = new RpcStub(
		new ReviewApi(() => {
			holding = true
		}),
	)
	const acquireApi = () => {
		const api = shared.dup()
		return {
			api,
			release() {
				releases += 1
				api[Symbol.dispose]()
			},
		}
	}
	const session = createAgentSession({
		titleGeneration: false,
		scopeKey,
		documents,
		models,
		model: faux.getModel(),
		apiKey: 'review-memory-only-secret',
		acquireApi,
	})
	return { session, faux, shared, holding: () => holding, releases: () => releases }
}

async function failedBatch(code: string, status: string): Promise<void> {
	const instance = fixture(`mixed-error-${status}-${crypto.randomUUID()}`)
	instance.faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall('searchDocs', { query: 'configuration' }),
				fauxToolCall('runJavaScript', { code }),
				fauxToolCall('readDoc', { id: 'review-api' }),
			],
			{ stopReason: 'toolUse' },
		),
		fauxAssistantMessage([fauxToolCall('runJavaScript', { code })], { stopReason: 'toolUse' }),
	])
	await instance.session.send('Execute once')
	const snapshot = instance.session.getSnapshot()
	assert(
		instance.faux.state.callCount === 1,
		`Mixed successful/failed tool batch continued provider after ${status}`,
	)
	assert(
		snapshot.executions.length === 1 && snapshot.executions[0]?.status === status,
		`Failed ${status} script was repeated`,
	)
	instance.session.dispose()
	instance.shared[Symbol.dispose]()
}

function deleteReviewDatabase(databaseName: string, ownerClosed = false): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase(databaseName)
		const deadline = setTimeout(() => {
			reject(
				new Error('The isolated history database did not finish deleting after owner cleanup.'),
			)
		}, 5000)
		const fail = (error: unknown) => {
			clearTimeout(deadline)
			reject(error)
		}
		request.addEventListener(
			'success',
			() => {
				clearTimeout(deadline)
				resolve()
			},
			{ once: true },
		)
		request.addEventListener(
			'error',
			() => fail(request.error ?? new Error('Cannot delete the isolated review database')),
			{ once: true },
		)
		request.addEventListener(
			'blocked',
			() => {
				// A closed owner can still have readonly request results awaiting
				// their native transaction completion. Cleanup must await success;
				// the live-owner versionchange check below still rejects any block.
				if (!ownerClosed) fail(new Error('History retained a connection after versionchange'))
			},
			{ once: true },
		)
	})
}

export async function runHistoryVersionChangeReview(): Promise<void> {
	const databaseName = `browser-history-versionchange-${crypto.randomUUID()}`
	const history = new WorkspaceHistory(databaseName)
	const timestamp = Date.now()
	const record = (id: string): StoredWorkspaceHistory => ({
		id,
		scopeKey: 'versionchange-review',
		title: `${id} database reset`,
		createdAt: timestamp,
		updatedAt: timestamp,
		messages: [{ role: 'user', content: `${id} transcript`, timestamp }],
		executions: [],
	})
	try {
		await history.save(record('before'))
		assert(
			(await history.load('versionchange-review', 'before'))?.title === 'before database reset',
			'The isolated database did not save its initial transcript',
		)
		await deleteReviewDatabase(databaseName)
		// Keep this owner alive: deleting the database retires its native connection,
		// so the next write must reopen instead of using the cached closed handle.
		await history.save(record('after'))
		const restored = await history.load('versionchange-review', 'after')
		assert(
			restored?.title === 'after database reset' && restored.messages.length === 1,
			'The same history owner did not reopen and restore a transcript after versionchange',
		)
		const summaries = await history.list('versionchange-review')
		assert(
			summaries.length === 1 && summaries[0]?.id === 'after',
			'Listing reused stale records or a closed connection after versionchange',
		)
		assert(
			(await history.load('versionchange-review', 'before')) === undefined,
			'The deleted database retained its original transcript',
		)
	} finally {
		history.close()
		await deleteReviewDatabase(databaseName, true)
	}
}

export async function runAgentLifecycleReview(): Promise<
	Array<{ name: string; durationMs: number }>
> {
	const results: Array<{ name: string; durationMs: number }> = []
	async function test(name: string, run: () => Promise<void>): Promise<void> {
		const started = performance.now()
		await run()
		results.push({ name, durationMs: Math.round(performance.now() - started) })
	}

	await test(
		'the same history owner reopens after native IndexedDB versionchange and database deletion',
		runHistoryVersionChangeReview,
	)

	await test('disposing an active Worker persists stopped records only in the retired identity scope', async () => {
		const scopeKey = `retired-scope-${crypto.randomUUID()}`
		const old = fixture(scopeKey)
		old.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall('runJavaScript', {
						code: 'print("before-retirement"); return await api.hold();',
					}),
				],
				{ stopReason: 'toolUse' },
			),
			fauxAssistantMessage('OLD PROVIDER MUST NOT CONTINUE'),
		])
		let notifications = 0
		old.session.subscribe(() => {
			notifications += 1
		})
		const id = old.session.getSnapshot().id
		const running = old.session.send('Read old community')
		await waitFor(old.holding)
		await pause(20)
		old.session.dispose()
		const notificationsAfterDisposal = notifications
		const current = fixture(`current-scope-${crypto.randomUUID()}`)
		current.faux.setResponses([fauxAssistantMessage('Current community only')])
		await current.session.send('Read new community')
		await running
		const history = new WorkspaceHistory()
		await waitFor(
			async () => (await history.load(scopeKey, id))?.executions[0]?.status === 'stopped',
		)
		const stored = await history.load(scopeKey, id)
		assert(
			stored?.executions[0]?.outputs.includes('before-retirement'),
			'Retirement discarded already produced output',
		)
		assert(
			!JSON.stringify(stored).includes('review-memory-only-secret'),
			'Retired history retained a model key',
		)
		await pause(330)
		assert(
			notifications === notificationsAfterDisposal,
			'Disposed session published a late notification',
		)
		assert(
			old.releases() === 1 && old.faux.state.callCount === 1,
			'Retirement leaked a lease or continued the provider loop',
		)
		assert(
			!JSON.stringify(current.session.getSnapshot()).includes('before-retirement'),
			'Old execution polluted the new owner',
		)
		assert((await old.shared.readDto()).revision === 3, 'Retirement closed host shared capability')
		history.close()
		current.session.dispose()
		old.shared[Symbol.dispose]()
		current.shared[Symbol.dispose]()
	})

	await test('provider streaming abort is distinct from completion and never retries', async () => {
		const instance = fixture(`provider-abort-${crypto.randomUUID()}`, 100)
		instance.faux.setResponses([
			fauxAssistantMessage('Slow partial response '.repeat(20)),
			fauxAssistantMessage('MUST NOT RETRY'),
		])
		const running = instance.session.send('Stream then stop')
		await waitFor(() =>
			instance.session
				.getSnapshot()
				.messages.some(
					(message) =>
						message.role === 'assistant' &&
						message.content.some((part) => part.type === 'text' && part.text.length > 0),
				),
		)
		instance.session.stop()
		await running
		const snapshot = instance.session.getSnapshot()
		assert(
			snapshot.stopped && !snapshot.isRunning && snapshot.executions.length === 0,
			'Provider stop was reported as completed execution',
		)
		assert(
			snapshot.messages.some(
				(message) => message.role === 'assistant' && message.stopReason === 'aborted',
			),
			'pi did not retain provider abort status',
		)
		assert(
			instance.faux.state.callCount === 1 && instance.faux.getPendingResponseCount() === 1,
			'Provider request retried after stop',
		)
		instance.session.dispose()
		instance.shared[Symbol.dispose]()
	})

	await test('a syntax failure ends a mixed tool batch without automatic repair or script replay', () =>
		failedBatch('await api.', 'syntax_error'))
	await test('an RPC failure ends a mixed tool batch without automatic script replay', () =>
		failedBatch('return await api.fail();', 'rpc_error'))

	await test('new conversation cancellation can finish quietly after the owner unmounts', async () => {
		const instance = fixture(`new-and-retire-${crypto.randomUUID()}`)
		instance.faux.setResponses([
			fauxAssistantMessage([fauxToolCall('runJavaScript', { code: 'return await api.hold();' })], {
				stopReason: 'toolUse',
			}),
		])
		const running = instance.session.send('Hold')
		await waitFor(instance.holding)
		const changing = instance.session.newConversation()
		instance.session.dispose()
		await changing
		await running
		assert(instance.releases() === 1, 'New conversation/unmount leaked the worker lease')
		instance.shared[Symbol.dispose]()
	})

	return results
}
