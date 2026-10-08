import { createRoot } from 'react-dom/client'
import { RpcStub, RpcTarget } from 'capnweb'
import {
	createModels,
	fauxProvider,
	fauxAssistantMessage,
	fauxToolCall,
} from '@earendil-works/pi-ai'
import { createAgentSession } from '../../src/session.ts'
import { AgentWorkspace } from '../../packages/ui/src/index.tsx'
import './fixture-styles.css'

let calls = 0
let releases = 0
class BrowserApi extends RpcTarget {
	async currentDto() {
		calls++
		return { revision: 7, name: 'Browser config' }
	}
}
const hostApi = new RpcStub(new BrowserApi())
const documents = [
	{
		id: 'api',
		title: 'Browser configuration API',
		version: '1',
		text: 'api.currentDto() returns {revision:number,name:string}. Use await. Read only.',
	},
]
function lease() {
	const api = hostApi.dup()
	return {
		api,
		release() {
			releases++
			api[Symbol.dispose]()
		},
	}
}
const session = createAgentSession({
	titleGeneration: false,
	scopeKey: 'browser-ui-current-user',
	documents,
	acquireApi: lease,
})
createRoot(document.getElementById('root')!).render(<AgentWorkspace session={session} />)
Object.assign(window, { workspaceSession: session, apiCounters: () => ({ calls, releases }) })

async function runSessionBrowserTests() {
	const faux = fauxProvider({ tokensPerSecond: 5000, tokenSize: { min: 1, max: 3 } })
	const models = createModels()
	models.setProvider(faux.provider)
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall('searchDocs', { query: 'configuration' })], {
			stopReason: 'toolUse',
		}),
		fauxAssistantMessage([fauxToolCall('readDoc', { id: 'api' })], { stopReason: 'toolUse' }),
		fauxAssistantMessage(
			[
				fauxToolCall('runJavaScript', {
					code: 'const dto = await api.currentDto(); print(dto); return dto.revision;',
				}),
			],
			{ stopReason: 'toolUse' },
		),
		fauxAssistantMessage('查询完成，当前版本为 7。'),
	])
	const testSession = createAgentSession({
		titleGeneration: false,
		scopeKey: 'browser-pi-loop',
		documents,
		acquireApi: lease,
		models,
		model: faux.getModel(),
	})
	let streamed = false
	const off = testSession.subscribe(() => {
		if (
			testSession.getSnapshot().isRunning &&
			testSession
				.getSnapshot()
				.messages.some(
					(m) =>
						m.role === 'assistant' && m.content.some((p) => p.type === 'text' && p.text.length > 0),
				)
		)
			streamed = true
	})
	await testSession.send('读取配置')
	const state = testSession.getSnapshot()
	assert(faux.state.callCount === 4, 'pi alone performs search/read/run/result/continuation')
	assert(
		state.executions.length === 1 && state.executions[0]?.value === 7,
		'real worker result feeds pi',
	)
	assert(
		state.messages.filter((m) => m.role === 'toolResult').length === 3,
		'all three tool results retained',
	)
	assert(!state.isRunning && !state.error && streamed, 'streaming and final idle state')
	const history = await testSession.listHistory()
	assert(history.length === 1, 'browser IndexedDB stored transcript')
	const runCount = faux.state.callCount
	await testSession.newConversation()
	await testSession.restore(history[0]!.id)
	assert(
		faux.state.callCount === runCount && testSession.getSnapshot().executions.length === 1,
		'restore only displays history',
	)
	await testSession.deleteHistory(history[0]!.id)
	assert((await testSession.listHistory()).length === 0, 'delete history')
	off()
	testSession.dispose()
	const stopped = createAgentSession({
		titleGeneration: false,
		scopeKey: 'browser-pi-stop',
		documents,
		acquireApi: lease,
		models,
		model: faux.getModel(),
	})
	faux.setResponses([
		fauxAssistantMessage(
			[fauxToolCall('runJavaScript', { code: 'print("alive"); while(true){}' })],
			{ stopReason: 'toolUse' },
		),
		fauxAssistantMessage('MUST NOT CONTINUE'),
	])
	const running = stopped.send('stop loop')
	await waitFor(() =>
		stopped
			.getSnapshot()
			.messages.some((m) => m.role === 'assistant' && m.content.some((p) => p.type === 'toolCall')),
	)
	await new Promise((resolve) => setTimeout(resolve, 300))
	stopped.stop()
	await running
	assert(
		stopped.getSnapshot().executions[0]?.status === 'stopped',
		'stop terminates CPU infinite loop',
	)
	assert(
		stopped.getSnapshot().stopped && !stopped.getSnapshot().isRunning,
		'stop distinct from completed',
	)
	assert(faux.getPendingResponseCount() === 1, 'failed or stopped script not automatically retried')
	stopped.dispose()
	return {
		passed: 8,
		streamed,
		calls,
		releases,
		model: 'controlled pi faux provider; no real provider credentials',
	}
}
function assert(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message)
}
async function waitFor(predicate: () => boolean, start = Date.now()): Promise<void> {
	if (predicate()) return
	if (Date.now() - start > 5000) throw new Error('Timed out waiting')
	await new Promise((resolve) => setTimeout(resolve, 10))
	return waitFor(predicate, start)
}
Object.assign(window, { runSessionBrowserTests })
