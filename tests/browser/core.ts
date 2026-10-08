import { newMessagePortRpcSession, RpcStub, RpcTarget } from 'capnweb'
import { EXECUTION_LIMITS, runJavaScript } from '../../src/execution.ts'
import { WorkspaceHistory } from '../../src/history.ts'
import type { ApiLease } from '../../src/rpc.ts'
import { runAgentLifecycleReview } from './review.ts'
import {
	runReactSessionReplacementReview,
	runReactGeneratedTitleReview,
	runReactGroupedPartsReview,
	runReactNativeCodeReview,
} from './react-review.ts'

const pause = (milliseconds: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
const missingAcquisition = () => {
	throw new Error('Missing acquisition resolver')
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message)
}

class ChildApi extends RpcTarget {
	constructor(private readonly disposed: () => void) {
		super()
	}
	readDto() {
		return { revision: 7, label: 'child' }
	}
	[Symbol.dispose]() {
		this.disposed()
	}
}

interface FixtureState {
	disposed: number
	childrenDisposed: number
	reads: number
	activeReads: number
	maximumActive: number
}

class FixtureApi extends RpcTarget {
	#state: FixtureState
	constructor(state: FixtureState) {
		super()
		this.#state = state
	}
	readDto() {
		this.#state.reads += 1
		return { revision: 1, title: 'synthetic draft' }
	}
	child() {
		return new ChildApi(() => {
			this.#state.childrenDisposed += 1
		})
	}
	mixed() {
		return {
			child: new ChildApi(() => {
				this.#state.childrenDisposed += 1
			}),
			label: 'container',
		}
	}
	listDto() {
		return ['one', 'two']
	}
	fail() {
		throw new Error('RPC permission denied')
	}
	async readDelay(value: string | number, milliseconds: number) {
		this.#state.reads += 1
		this.#state.activeReads += 1
		this.#state.maximumActive = Math.max(this.#state.maximumActive, this.#state.activeReads)
		await pause(milliseconds)
		this.#state.activeReads -= 1
		return value
	}
	[Symbol.dispose]() {
		this.#state.disposed += 1
	}
}

function owner() {
	const state = { disposed: 0, childrenDisposed: 0, reads: 0, activeReads: 0, maximumActive: 0 }
	const shared = new RpcStub(new FixtureApi(state))
	let releases = 0
	const acquireApi = (): ApiLease => {
		const api = shared.dup()
		return {
			api,
			release() {
				releases += 1
				api[Symbol.dispose]()
			},
		}
	}
	return { state, shared, acquireApi, releases: () => releases }
}

interface BrowserCoreTestResult {
	name: string
	durationMs: number
}

declare global {
	interface Window {
		runCoreBrowserTests: () => Promise<BrowserCoreTestResult[]>
	}
}

window.runCoreBrowserTests = async () => {
	const results: BrowserCoreTestResult[] = []
	async function test(name: string, run: () => Promise<void>): Promise<void> {
		const start = performance.now()
		await run()
		results.push({ name, durationMs: Math.round(performance.now() - start) })
	}

	await test('custom Worker factory preserves RPC execution and owned termination', async () => {
		const host = owner()
		let created = 0
		let terminated = 0
		const createWorker = () => {
			created += 1
			const worker = new Worker(new URL('../../src/execution.worker.ts', import.meta.url), {
				type: 'module',
			})
			const terminate = worker.terminate.bind(worker)
			worker.terminate = () => {
				terminated += 1
				terminate()
			}
			return worker
		}
		try {
			for (let i = 0; i < 2; i += 1) {
				const record = await runJavaScript({
					acquireApi: host.acquireApi,
					createWorker,
					code: 'return await api.child().readDto();',
				})
				assert(record.status === 'completed', record.error ?? 'Custom Worker failed')
				assert(
					JSON.stringify(record.value) === JSON.stringify({ revision: 7, label: 'child' }),
					'Pipelined result lost',
				)
			}
			assert(
				created === 2 && terminated === 2 && host.releases() === 2,
				'Each run must own one fresh Worker and lease',
			)
		} finally {
			host.shared[Symbol.dispose]()
		}
	})

	await test('custom Worker factory failures and synchronous cancellation release the acquired lease', async () => {
		const host = owner()
		try {
			const failed = await runJavaScript({
				acquireApi: host.acquireApi,
				code: 'return 1',
				createWorker: () => {
					throw new Error('Host Worker unavailable')
				},
			})
			assert(
				failed.status === 'execution_error' && failed.error === 'Host Worker unavailable',
				'Factory failure was not reported',
			)
			assert(host.releases() === 1, 'Factory failure leaked lease')
			const controller = new AbortController()
			let terminated = 0
			const stopped = await runJavaScript({
				acquireApi: host.acquireApi,
				code: 'return 1',
				signal: controller.signal,
				createWorker: () => {
					const worker = new Worker(new URL('../../src/execution.worker.ts', import.meta.url), {
						type: 'module',
					})
					const terminate = worker.terminate.bind(worker)
					worker.terminate = () => {
						terminated += 1
						terminate()
					}
					controller.abort()
					return worker
				},
			})
			assert(
				stopped.status === 'stopped' && terminated === 1 && host.releases() === 2,
				'Cancellation within factory leaked resources',
			)
		} finally {
			host.shared[Symbol.dispose]()
		}
	})

	await test('real Worker navigation, child capability and independent reference cleanup', async () => {
		const host = owner()
		const record = await runJavaScript({
			acquireApi: host.acquireApi,
			code: 'const child = await api.child(); print(await child.readDto()); return await api.readDto();',
		})
		assert(record.status === 'completed', `Child navigation failed: ${record.error}`)
		assert(
			JSON.stringify(record.value) === JSON.stringify({ revision: 1, title: 'synthetic draft' }),
			'Wrong root DTO',
		)
		assert(record.outputs[0]?.includes('child'), 'Missing child DTO output')
		await pause(30)
		assert(
			host.state.childrenDisposed === 1,
			`Child leaked: disposed=${host.state.childrenDisposed}`,
		)
		assert(host.releases() === 1, 'Execution did not release its lease exactly once')
		assert(host.state.disposed === 0, 'Execution closed the host shared capability')
		assert((await host.shared.readDto()).revision === 1, 'Host API stopped working after execution')
		host.shared[Symbol.dispose]()
		assert(Number(host.state.disposed) === 1, 'Host owner could not dispose its own resource')
	})

	await test('Cap’n Web promise pipelining retains reference semantics', async () => {
		const host = owner()
		const record = await runJavaScript({
			acquireApi: host.acquireApi,
			code: 'return await api.child().readDto();',
		})
		assert(record.status === 'completed', `Pipelining failed: ${record.error}`)
		assert((record.value as { revision: number }).revision === 7, 'Wrong pipelined DTO')
		await pause(20)
		assert(host.state.childrenDisposed === 1, 'Pipelined child was not released')
		assert(host.releases() === 1 && host.state.disposed === 0, 'Pipelining retired the shared root')
		assert((await host.shared.readDto()).revision === 1, 'Pipelining cleanup broke the shared root')
		host.shared[Symbol.dispose]()
	})

	await test('native using releases a child at block exit while later root RPC and the Worker remain live', async () => {
		const host = owner()
		let earlyRelease = false
		const record = await runJavaScript({
			acquireApi: host.acquireApi,
			code: '{ using child = await api.child(); print(await child.readDto()); } const root = await api.readDto(); print("after-using:" + root.revision); return await api.readDelay("root-alive", 60);',
			onOutput(text) {
				if (text === 'after-using:1') {
					earlyRelease =
						host.state.childrenDisposed === 1 && host.releases() === 0 && host.state.disposed === 0
				}
			},
		})
		assert(
			record.status === 'completed' && record.value === 'root-alive',
			`Native using failed: ${record.error}`,
		)
		assert(earlyRelease, 'Lexical using only released its child when the whole Worker retired')
		assert(
			record.outputs[0]?.includes('child') && record.outputs.includes('after-using:1'),
			'Native using lost the child result or the subsequent root RPC output',
		)
		assert(
			host.state.childrenDisposed === 1 && host.releases() === 1 && host.state.disposed === 0,
			'Native using leaked its child/lease or disposed the shared root',
		)
		assert(
			(await host.shared.readDto()).revision === 1,
			'Lexical child disposal closed the shared root',
		)
		host.shared[Symbol.dispose]()
	})

	await test('mixed capability container supports retaining a duplicate before disposal', async () => {
		const host = owner()
		const record = await runJavaScript({
			acquireApi: host.acquireApi,
			code: 'const container = await api.mixed(); const child = container.child.dup(); container[Symbol.dispose](); try { print(await child.readDto()); return { label: "retained", omitted: child }; } finally { child[Symbol.dispose](); }',
		})
		assert(record.status === 'completed', `Mixed container failed: ${record.error}`)
		assert(
			record.outputs[0]?.includes('child') && record.truncated,
			'Mixed capability was not usable or omitted from feedback',
		)
		assert(
			JSON.stringify(record.value).includes('RPC capability omitted'),
			'Feedback retained a live capability',
		)
		await pause(30)
		assert(
			host.state.childrenDisposed === 1 && host.state.disposed === 0,
			'Mixed child or host ownership leaked',
		)
		host.shared[Symbol.dispose]()
	})

	await test('native Cap’n Web map instructions are counted as one observed call', async () => {
		const host = owner()
		const record = await runJavaScript({
			acquireApi: host.acquireApi,
			code: 'return await api.listDto().map(value => api.readDelay(value, 5));',
		})
		assert(
			record.status === 'completed' && JSON.stringify(record.value) === '["one","two"]',
			`Native map changed semantics: ${record.status}: ${record.error}`,
		)
		host.shared[Symbol.dispose]()
	})

	await test('independent RPC reads run concurrently in the native Worker', async () => {
		const host = owner()
		const record = await runJavaScript({
			acquireApi: host.acquireApi,
			code: 'return await Promise.all([api.readDelay(1, 40), api.readDelay(2, 40), api.readDelay(3, 40)]);',
		})
		assert(
			record.status === 'completed' && JSON.stringify(record.value) === '[1,2,3]',
			`Concurrency failed: ${record.error}`,
		)
		assert(host.state.maximumActive === 3, 'RPC reads were serialized')
		host.shared[Symbol.dispose]()
	})

	await test('syntax, RPC rejection and execution errors remain distinct and retain output', async () => {
		const host = owner()
		const syntax = await runJavaScript({ acquireApi: host.acquireApi, code: 'await api.' })
		assert(syntax.status === 'syntax_error', `Wrong syntax status: ${syntax.status}`)
		const rpc = await runJavaScript({
			acquireApi: host.acquireApi,
			code: 'print("before-rpc"); return await api.fail();',
		})
		assert(
			rpc.status === 'rpc_error' && rpc.error?.includes('permission denied'),
			`Wrong RPC error: ${rpc.error}`,
		)
		assert(rpc.outputs[0] === 'before-rpc', 'RPC error lost earlier output')
		const execution = await runJavaScript({
			acquireApi: host.acquireApi,
			code: 'print("before-error"); const child = await api.child(); await child.readDto(); throw new Error("script boom");',
		})
		assert(
			execution.status === 'execution_error' && execution.error === 'script boom',
			'Execution error was misclassified',
		)
		assert(
			execution.outputs[0] === 'before-error' && host.releases() === 3,
			'Error cleanup/output failed',
		)
		await pause(20)
		assert(
			host.state.childrenDisposed === 1 && host.state.disposed === 0,
			'Throw without finally leaked a child or retired the shared root',
		)
		assert(
			(await host.shared.readDto()).revision === 1,
			'The shared root failed after throwing with a live child',
		)
		host.shared[Symbol.dispose]()
	})

	await test('return with an unawaited RPC is a failure and closes dispatch', async () => {
		const host = owner()
		const record = await runJavaScript({
			acquireApi: host.acquireApi,
			code: 'print("before-return"); api.readDelay("late", 150); return "too early";',
		})
		assert(
			record.status === 'execution_error' && record.error?.includes('unawaited'),
			`Unawaited RPC reported success: ${record.status}`,
		)
		assert(
			record.value === undefined && record.outputs[0] === 'before-return',
			'Unawaited RPC result was accepted',
		)
		await pause(180)
		assert(
			host.releases() === 1 && host.state.disposed === 0,
			'Unawaited RPC leaked or closed host',
		)
		const readsBefore = host.state.reads
		const completed = await runJavaScript({
			acquireApi: host.acquireApi,
			code: 'setTimeout(() => api.readDto(), 30); return 1;',
		})
		assert(completed.status === 'completed', 'Plain synchronous return failed')
		await pause(60)
		assert(host.state.reads === readsBefore, 'A timer dispatched RPC after the script returned')
		host.shared[Symbol.dispose]()
	})

	await test('stop terminates a busy loop, preserves output and allows a fresh execution', async () => {
		const host = owner()
		const controller = new AbortController()
		const record = await runJavaScript({
			acquireApi: host.acquireApi,
			signal: controller.signal,
			timeoutMs: 5000,
			code: 'const child = await api.child(); await child.readDto(); print("ready"); while (true) {}',
			onOutput() {
				setTimeout(() => controller.abort(), 10)
			},
		})
		assert(
			record.status === 'stopped' && record.outputs[0] === 'ready',
			`Busy loop stop failed: ${record.status}`,
		)
		await pause(20)
		assert(
			host.state.childrenDisposed === 1 && host.releases() === 1 && host.state.disposed === 0,
			'Abort without finally leaked a child or retired the shared root',
		)
		assert(
			(await host.shared.readDto()).revision === 1,
			'The shared root failed after aborting with a live child',
		)
		const next = await runJavaScript({
			acquireApi: host.acquireApi,
			code: 'return await api.readDto();',
		})
		assert(
			next.status === 'completed' && host.state.disposed === 0,
			'Stop prevented the next execution or closed host',
		)
		host.shared[Symbol.dispose]()
	})

	await test('timeout terminates a busy loop while retaining previous output', async () => {
		const host = owner()
		const record = await runJavaScript({
			acquireApi: host.acquireApi,
			timeoutMs: 300,
			code: 'const child = await api.child(); await child.readDto(); print("before-timeout"); while (true) {}',
		})
		assert(
			record.status === 'timeout' && record.outputs[0] === 'before-timeout',
			`Timeout failed: ${record.status}`,
		)
		assert(host.releases() === 1 && host.state.disposed === 0, 'Timeout cleanup closed shared API')
		await pause(20)
		assert(host.state.childrenDisposed === 1, 'Timeout without finally leaked its live child')
		assert(
			(await host.shared.readDto()).revision === 1,
			'The shared root failed after timing out with a live child',
		)
		host.shared[Symbol.dispose]()
	})

	await test('late API acquisition is immediately released after cancellation', async () => {
		const host = owner()
		let arrive: (lease: ApiLease) => void = missingAcquisition
		const acquiring = new Promise<ApiLease>((resolve) => {
			arrive = resolve
		})
		const controller = new AbortController()
		const running = runJavaScript({
			code: 'return await api.readDto();',
			acquireApi: () => acquiring,
			signal: controller.signal,
		})
		controller.abort()
		const record = await running
		assert(
			record.status === 'stopped' && host.releases() === 0,
			'Cancellation waited for acquisition',
		)
		arrive(host.acquireApi())
		await pause(20)
		assert(
			host.releases() === 1 && host.state.reads === 0 && host.state.disposed === 0,
			'Late lease ran or leaked',
		)
		host.shared[Symbol.dispose]()
	})

	await test('scope invalidation rejects late results from the old execution', async () => {
		const host = owner()
		const controller = new AbortController()
		const oldOutput: string[] = []
		const old = runJavaScript({
			acquireApi: host.acquireApi,
			signal: controller.signal,
			code: 'print(await api.readDelay("old-scope", 250)); return "old-scope";',
			onOutput: (value) => oldOutput.push(value),
		})
		setTimeout(() => controller.abort(), 60)
		const oldRecord = await old
		const current = await runJavaScript({
			acquireApi: host.acquireApi,
			code: 'return "new-scope";',
		})
		await pause(300)
		assert(
			oldRecord.status === 'stopped' && oldRecord.value === undefined && oldOutput.length === 0,
			'Old scope published a late result',
		)
		assert(
			current.status === 'completed' && current.value === 'new-scope',
			'New scope was polluted by old execution',
		)
		assert(host.state.disposed === 0, 'Scope invalidation closed shared owner')
		host.shared[Symbol.dispose]()
	})

	await test('real upstream MessagePort disconnect propagates RPC error to the Worker', async () => {
		const host = owner()
		const channel = new MessageChannel()
		const server = newMessagePortRpcSession(channel.port1, host.shared.dup())
		const shared = newMessagePortRpcSession<FixtureApi>(channel.port2)
		const acquireApi = (): ApiLease => {
			const api = shared.dup()
			return { api, release: () => api[Symbol.dispose]() }
		}
		const pending = runJavaScript({
			acquireApi,
			timeoutMs: 5000,
			code: 'print("before-break"); return await api.readDelay("late-rpc", 300);',
		})
		setTimeout(() => server[Symbol.dispose](), 100)
		const record = await pending
		assert(
			record.status === 'rpc_error' && record.outputs[0] === 'before-break',
			`Disconnect was not surfaced: ${record.status}: ${record.error}`,
		)
		assert(record.value === undefined, 'Disconnected RPC published a late value')
		shared[Symbol.dispose]()
		host.shared[Symbol.dispose]()
	})

	await test('Worker onRpcBroken callbacks retire with their bridge and cannot affect a new owner', async () => {
		const host = owner()
		const oldOutput: string[] = []
		const old = await runJavaScript({
			acquireApi: host.acquireApi,
			code: 'api.onRpcBroken(() => print("retired callback")); print("current output"); return await api.readDto();',
			onOutput: (value) => oldOutput.push(value),
		})
		assert(
			old.status === 'completed' && oldOutput.join('') === 'current output',
			'Bridge cleanup published its broken callback',
		)
		host.shared[Symbol.dispose]()
		const current = owner()
		const result = await runJavaScript({
			acquireApi: current.acquireApi,
			code: 'return await api.readDto();',
		})
		await pause(30)
		assert(
			result.status === 'completed' && oldOutput.join('') === 'current output',
			'Retired listener affected the new owner',
		)
		current.shared[Symbol.dispose]()
	})

	await test('code, explicit output and returned values are bounded', async () => {
		const host = owner()
		const code = await runJavaScript({
			acquireApi: host.acquireApi,
			code: ' '.repeat(EXECUTION_LIMITS.codeCharacters + 1),
		})
		assert(
			code.status === 'execution_error' && code.truncated && host.releases() === 0,
			'Oversized code was executed',
		)
		const record = await runJavaScript({
			acquireApi: host.acquireApi,
			code: 'for (let i = 0; i < 100000; i++) print("entry " + i + "x".repeat(4000)); return "\\\\".repeat(100000);',
		})
		assert(
			record.status === 'completed' && record.truncated,
			`Bounded output failed: ${record.error}`,
		)
		assert(record.outputs.length <= EXECUTION_LIMITS.outputEntries, 'Output entry limit exceeded')
		assert(
			record.outputs.join('').length <= EXECUTION_LIMITS.outputCharacters,
			'Output character limit exceeded',
		)
		assert(
			JSON.stringify(record.value).length <= EXECUTION_LIMITS.valueCharacters,
			'Return limit exceeded',
		)
		host.shared[Symbol.dispose]()
	})

	await test('generated global postMessage cannot crash the receiver or bypass feedback limits', async () => {
		const host = owner()
		const invalid = await runJavaScript({
			acquireApi: host.acquireApi,
			code: 'globalThis.postMessage(null); globalThis.postMessage({type:"output",text:null}); globalThis.postMessage({type:"result",status:"invalid",truncated:false}); return 42;',
		})
		assert(
			invalid.status === 'completed' && invalid.value === 42,
			'Invalid protocol packets contaminated execution',
		)
		const large = await runJavaScript({
			acquireApi: host.acquireApi,
			code: 'globalThis.postMessage({type:"output",text:"x".repeat(100000),truncated:false}); globalThis.postMessage({type:"result",status:"completed",value:"x".repeat(100000),truncated:false}); return null;',
		})
		assert(
			large.status === 'completed' && large.truncated,
			'Receiving side did not expose truncation',
		)
		assert(
			large.outputs.join('').length <= EXECUTION_LIMITS.outputCharacters,
			'Global output packet bypassed bounds',
		)
		assert(
			JSON.stringify(large.value).length <= EXECUTION_LIMITS.valueCharacters,
			'Global result packet bypassed bounds',
		)
		assert(
			host.state.disposed === 0 && host.releases() === 2,
			'Invalid packet cleanup closed host references',
		)
		host.shared[Symbol.dispose]()
	})

	await test('packet floods retire the Worker without closing the shared host capability', async () => {
		const host = owner()
		const record = await runJavaScript({
			acquireApi: host.acquireApi,
			code: 'print("before-packet-flood"); for(let i=0;i<100000;i++) globalThis.postMessage({type:"output",text:"flood",truncated:false}); return 42;',
		})
		assert(
			record.status === 'execution_error' && record.error?.includes('feedback packet limit'),
			'A packet flood was allowed to saturate the UI message queue',
		)
		assert(
			record.outputs[0] === 'before-packet-flood' && record.truncated && record.value === undefined,
			'Flood retirement lost earlier feedback or accepted a late success',
		)
		assert(host.releases() === 1 && host.state.disposed === 0, 'Flood retirement leaked its lease')
		const next = await runJavaScript({
			acquireApi: host.acquireApi,
			code: 'return await api.readDto();',
		})
		assert(
			next.status === 'completed',
			'Packet flood closed the shared API or blocked a fresh Worker',
		)
		host.shared[Symbol.dispose]()
	})

	await test('all bounded print entries remain ordered before stopping a noncooperative Worker', async () => {
		const host = owner()
		const controller = new AbortController()
		const observed: string[] = []
		const record = await runJavaScript({
			acquireApi: host.acquireApi,
			signal: controller.signal,
			code: `for(let i=0;i<${EXECUTION_LIMITS.outputEntries};i++) print("entry-"+i); while(true) {}`,
			onOutput(text) {
				observed.push(text)
				if (observed.length === EXECUTION_LIMITS.outputEntries) controller.abort()
			},
		})
		assert(record.status === 'stopped', `Bounded output failed before stop: ${record.error}`)
		assert(
			observed.every((text, index) => text === `entry-${index}`) &&
				record.outputs.join('\n') === observed.join('\n') &&
				observed.length === EXECUTION_LIMITS.outputEntries,
			'Worker delivery lost, reordered or coalesced explicit print entries',
		)
		assert(host.releases() === 1 && host.state.disposed === 0, 'Busy Worker stop leaked its lease')
		host.shared[Symbol.dispose]()
	})

	await test('actual IndexedDB restores display records by scope without replaying capabilities', async () => {
		const name = `browser-agent-history-${crypto.randomUUID()}`
		const history = new WorkspaceHistory(name)
		const record = {
			id: 'display-only',
			scopeKey: 'user/community-a',
			title: 'History',
			createdAt: 1,
			updatedAt: 2,
			messages: [{ role: 'user', content: 'draft' }],
			executions: [],
		}
		await history.save(record)
		assert((await history.list(record.scopeKey)).length === 1, 'History save/list failed')
		assert(
			(await history.load('another-user/community-a', record.id)) === undefined,
			'History crossed identity scope',
		)
		history.close()
		const reopened = new WorkspaceHistory(name)
		assert(
			(await reopened.load(record.scopeKey, record.id))?.title === 'History',
			'History did not survive reopening',
		)
		await reopened.delete(record.scopeKey, record.id)
		assert(
			(await reopened.load(record.scopeKey, record.id)) === undefined,
			'History deletion failed',
		)
		reopened.close()
		indexedDB.deleteDatabase(name)
	})

	return [
		...results,
		...(await runAgentLifecycleReview()),
		await runReactSessionReplacementReview(),
		await runReactGeneratedTitleReview(),
		await runReactGroupedPartsReview(),
		await runReactNativeCodeReview(),
	]
}
