import { expect, it } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import type { AgentSessionSnapshot } from '../src/session.ts'
import { createThreadMessagesProjector, toThreadMessages } from '../packages/react/src/messages.ts'

function snapshot(
	messages: AgentMessage[],
	state: Partial<AgentSessionSnapshot> = {},
): AgentSessionSnapshot {
	return {
		id: 'conversation',
		title: 'Conversation',
		archivedAt: null,
		messages,
		executions: [],
		isRunning: false,
		isConfigured: true,
		hasModelKey: true,
		remembersModelConnection: false,
		modelStorageError: null,
		modelSettings: {
			provider: 'custom',
			api: 'openai-completions',
			baseUrl: 'https://example.test/v1',
			model: 'controlled',
			contextWindow: 32000,
			env: {},
		},
		error: null,
		historyError: null,
		historySaveState: 'empty',
		historySavedAt: null,
		historyVersion: 0,
		isHistoryLoading: false,
		contextUsage: { estimatedTokens: 0, contextWindow: 32000 },
		contextWarning: false,
		stopped: false,
		...state,
	}
}
function user(text: string, timestamp = 1): AgentMessage {
	return { role: 'user', content: text, timestamp }
}
function assistant(
	content: Parameters<typeof fauxAssistantMessage>[0],
	stopReason: 'toolUse' | 'stop' = 'stop',
) {
	return { ...fauxAssistantMessage(content, { stopReason }), timestamp: 2 }
}
function call(name: string, id: string, args: Parameters<typeof fauxToolCall>[1]) {
	return { ...fauxToolCall(name, args), id }
}
function result(id: string, toolName: string, value: unknown, isError = false): AgentMessage {
	return {
		role: 'toolResult',
		toolCallId: id,
		toolName,
		content: [{ type: 'text', text: JSON.stringify(value) }],
		isError,
		timestamp: 3,
	}
}

it('reuses settled turns and parsed tool results while projecting fresh active stream content', () => {
	const project = createThreadMessagesProjector()
	const first = [user('first'), assistant('first answer')]
	const second = [
		...first,
		user('second', 4),
		assistant([call('readDoc', 'read', { id: 'contract' })], 'toolUse'),
		result('read', 'readDoc', { text: 'large contract' }),
	]
	const before = project(snapshot([...second, assistant('partial')], { isRunning: true }))
	const afterState = snapshot([...second, assistant('complete')])
	const after = project(afterState)
	expect(after).toEqual(toThreadMessages(afterState))
	expect(after[0]).toBe(before[0])
	expect(after[1]).toBe(before[1])
	const priorCall = (before[3]!.content as ReadonlyArray<{ result?: unknown }>)[0]!
	const currentCall = (after[3]!.content as ReadonlyArray<{ result?: unknown }>)[0]!
	expect(currentCall.result).toBe(priorCall.result)
	expect(after[3]).not.toBe(before[3])
	const restoredState = snapshot([user('restored'), assistant('restored answer')], { id: 'other' })
	expect(project(restoredState)).toEqual(toThreadMessages(restoredState))
	const replacedPrefix = snapshot([user('replacement'), assistant('new first'), ...second.slice(2)])
	expect(project(replacedPrefix)).toEqual(toThreadMessages(replacedPrefix))
})

it('keeps final-answer indices aligned after native normalization removes empty process parts', () => {
	const state = snapshot([
		user('read'),
		assistant(
			[
				{ type: 'text', text: ' ' },
				{ type: 'thinking', thinking: '\n\t' },
				call('readDoc', 'read', { id: 'api' }),
			],
			'toolUse',
		),
		result('read', 'readDoc', { text: 'contract' }),
		assistant([
			{ type: 'text', text: '' },
			{ type: 'text', text: 'visible answer' },
		]),
	])
	const projected = toThreadMessages(state)
	expect(projected[1]?.metadata?.custom?.answerPartIndices).toEqual([1])
	expect(projected[1]?.content).toMatchObject([
		{ type: 'tool-call', result: { text: 'contract' } },
		{ type: 'text', text: 'visible answer' },
	])
	expect(createThreadMessagesProjector()(state)).toEqual(projected)
})

it('projects the document, execution and continuation chain as one ordered assistant without rewriting history', () => {
	const script = 'return await api.settings().getDto()'
	const messages = [
		user('查询配置'),
		assistant(
			[
				{ type: 'thinking', thinking: '先查文档' },
				{ type: 'text', text: '正在查询公开契约。' },
				call('searchDocs', 'search', { query: 'settings' }),
			],
			'toolUse',
		),
		result('search', 'searchDocs', [{ id: 'settings' }]),
		assistant([call('readDoc', 'read', { id: 'settings' })], 'toolUse'),
		result('read', 'readDoc', { text: 'api.settings().getDto()' }),
		assistant(
			[{ type: 'text', text: '正在调用 API。' }, call('runJavaScript', 'run', { code: script })],
			'toolUse',
		),
		result('run', 'runJavaScript', { status: 'completed', value: { enabled: true } }),
		assistant('配置已读取。'),
	]
	const original = structuredClone(messages)
	const projected = toThreadMessages(snapshot(messages))
	expect(projected).toHaveLength(2)
	expect(projected[1]).toEqual({
		id: 'conversation-assistant-1',
		role: 'assistant',
		createdAt: new Date(2),
		status: { type: 'complete', reason: 'stop' },
		metadata: { custom: { answerPartIndices: [6] } },
		content: [
			{ type: 'reasoning', text: '先查文档' },
			{ type: 'text', text: '正在查询公开契约。' },
			{
				type: 'tool-call',
				toolCallId: 'search',
				toolName: 'searchDocs',
				args: { query: 'settings' },
				argsText: '{"query":"settings"}',
				result: [{ id: 'settings' }],
				isError: false,
			},
			{
				type: 'tool-call',
				toolCallId: 'read',
				toolName: 'readDoc',
				args: { id: 'settings' },
				argsText: '{"id":"settings"}',
				result: { text: 'api.settings().getDto()' },
				isError: false,
			},
			{ type: 'text', text: '正在调用 API。' },
			{
				type: 'tool-call',
				toolCallId: 'run',
				toolName: 'runJavaScript',
				args: { code: script },
				argsText: JSON.stringify({ code: script }),
				result: { status: 'completed', value: { enabled: true } },
				isError: false,
			},
			{ type: 'text', text: '配置已读取。' },
		],
	})
	expect(messages).toEqual(original)
	const restored: AgentMessage[] = [
		{ role: 'system', content: 'Current public contracts', timestamp: 0 },
		...structuredClone(messages),
	]
	expect(toThreadMessages(snapshot(restored))).toEqual(projected)
})

it('keeps a stable assistant ID and running status while tools finish and the next model step streams', () => {
	const messages = [
		user('读取文档'),
		assistant([call('readDoc', 'read', { id: 'api' })], 'toolUse'),
	]
	const before = toThreadMessages(snapshot(messages, { isRunning: true }))[1]!
	messages.push(result('read', 'readDoc', { text: 'contract' }))
	const afterTool = toThreadMessages(snapshot(messages, { isRunning: true }))[1]!
	messages.push(assistant('读取'))
	const streaming = toThreadMessages(snapshot(messages, { isRunning: true }))[1]!
	messages[messages.length - 1] = assistant('读取完成')
	const finished = toThreadMessages(snapshot(messages))[1]!
	expect([before.id, afterTool.id, streaming.id, finished.id]).toEqual(
		Array(4).fill('conversation-assistant-1'),
	)
	expect([before.status, afterTool.status, streaming.status]).toEqual(
		Array.from({ length: 3 }, () => ({ type: 'running' })),
	)
	expect(finished.status).toEqual({ type: 'complete', reason: 'stop' })
	messages.push(user('下一轮', 4))
	const next = toThreadMessages(snapshot(messages, { isRunning: true, stopped: true }))
	expect(next[1]!.status).toEqual({ type: 'complete', reason: 'stop' })
	expect(next[2]!.id).toBe('conversation-user-2')
})

it('isolates reused provider tool IDs between user turns and matches sequential calls within a turn', () => {
	const messages = [
		user('第一轮'),
		assistant([call('readDoc', 'reused', { id: 'one' })], 'toolUse'),
		result('reused', 'readDoc', 'first'),
		assistant([call('readDoc', 'reused', { id: 'two' })], 'toolUse'),
		result('reused', 'readDoc', 'second'),
		assistant('第一轮完成'),
		user('第二轮'),
		assistant([call('readDoc', 'reused', { id: 'three' })], 'toolUse'),
		result('reused', 'readDoc', 'third'),
		assistant('第二轮完成'),
	]
	const projected = toThreadMessages(snapshot(messages))
	const toolResults = projected
		.filter((m) => m.role === 'assistant')
		.map((m) =>
			typeof m.content === 'string'
				? []
				: m.content.filter((p) => p.type === 'tool-call').map((p) => p.result),
		)
	expect(toolResults).toEqual([['first', 'second'], ['third']])
	expect(projected.map((m) => m.id)).toEqual([
		'conversation-user-1',
		'conversation-assistant-1',
		'conversation-user-2',
		'conversation-assistant-2',
	])
})

it.each([
	['aborted', undefined, { type: 'incomplete', reason: 'cancelled' }],
	['error', 'HTTP 503', { type: 'incomplete', reason: 'error', error: 'HTTP 503' }],
	['length', undefined, { type: 'incomplete', reason: 'length' }],
] as const)(
	'retains the final model status %s in an aggregated turn',
	(stopReason, errorMessage, status) => {
		const messages = [
			user('查询'),
			assistant([call('readDoc', 'read', { id: 'api' })], 'toolUse'),
			result('read', 'readDoc', 'contract'),
			fauxAssistantMessage('partial', { stopReason, errorMessage }),
		]
		expect(toThreadMessages(snapshot(messages))[1]!.status).toEqual(status)
		expect(
			toThreadMessages(snapshot(messages, { isRunning: true, stopped: true }))[1]!.status,
		).toEqual({ type: 'incomplete', reason: 'cancelled' })
	},
)

it.each(['stopped', 'timeout', 'syntax_error', 'rpc_error', 'execution_error'] as const)(
	'retains a terminal %s execution result in history without overriding a later successful answer',
	(status) => {
		const messages = [
			user('执行脚本'),
			assistant([call('runJavaScript', 'run', { code: 'throw new Error()' })], 'toolUse'),
			result('run', 'runJavaScript', { status, error: 'execution failed' }, true),
		]
		expect(toThreadMessages(snapshot(messages))[1]!.status).toEqual(
			status === 'stopped'
				? { type: 'incomplete', reason: 'cancelled' }
				: { type: 'incomplete', reason: 'error', error: 'execution failed' },
		)
		expect(toThreadMessages(snapshot(messages, { isRunning: true }))[1]!.status).toEqual({
			type: 'running',
		})
		messages.push(assistant('已说明失败原因。'))
		const projected = toThreadMessages(snapshot(messages))[1]!
		expect(projected.status).toEqual({ type: 'complete', reason: 'stop' })
		expect(projected.content).toContainEqual(
			expect.objectContaining({ type: 'tool-call', toolCallId: 'run', isError: true }),
		)
	},
)

it('uses the tool error flag, leaves business receipts intact and never marks an unfinished tool turn complete', () => {
	const messages = [
		user('查询'),
		assistant([call('readDoc', 'read', { id: 'missing' })], 'toolUse'),
		result('read', 'readDoc', '文档不存在', true),
	]
	expect(toThreadMessages(snapshot(messages))[1]!.status).toEqual({
		type: 'incomplete',
		reason: 'error',
		error: '文档不存在',
	})
	const receipt = { status: 'stopped', saved: false, pending: true }
	const success = [
		user('保存'),
		assistant([call('runJavaScript', 'run', { code: 'return receipt' })], 'toolUse'),
		result('run', 'runJavaScript', { status: 'completed', value: receipt }),
	]
	expect(toThreadMessages(snapshot(success))[1]!.status).toEqual({
		type: 'incomplete',
		reason: 'tool-calls',
	})
	success.push(assistant('结果待业务确认。'))
	expect(toThreadMessages(snapshot(success))[1]!.status).toEqual({
		type: 'complete',
		reason: 'stop',
	})
	expect(toThreadMessages(snapshot(success))[1]!.content).toContainEqual(
		expect.objectContaining({ result: { status: 'completed', value: receipt }, isError: false }),
	)
	expect(toThreadMessages(snapshot(messages.slice(0, 2)))[1]!.status).toEqual({
		type: 'incomplete',
		reason: 'tool-calls',
	})
})

it('separates only the latest answer text while retaining thinking and intermediate text as process', () => {
	const messages = [
		user('查询'),
		assistant(
			[{ type: 'text', text: '准备查询' }, call('readDoc', 'read', { id: 'api' })],
			'toolUse',
		),
	]
	expect(toThreadMessages(snapshot(messages))[1]!.metadata?.custom).toEqual({
		answerPartIndices: [],
	})
	messages.push(result('read', 'readDoc', 'contract'))
	messages.push(
		assistant([
			{ type: 'thinking', thinking: '核对数据' },
			{ type: 'text', text: '最终结论' },
			{ type: 'text', text: '补充说明' },
		]),
	)
	expect(toThreadMessages(snapshot(messages, { isRunning: true }))[1]!.metadata?.custom).toEqual({
		answerPartIndices: [3, 4],
	})
	expect(toThreadMessages(snapshot(messages))[1]!.metadata?.custom).toEqual({
		answerPartIndices: [3, 4],
	})
})
