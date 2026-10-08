import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ThreadMessageLike } from '@assistant-ui/react'
import type { AgentSessionSnapshot } from '@pluxel/browser-worker-agent'

type AssistantMessage = Extract<AgentMessage, { role: 'assistant' }>
type ToolResultMessage = Extract<AgentMessage, { role: 'toolResult' }>
type DisplayPart = Exclude<ThreadMessageLike['content'], string>[number]
interface AssistantTurn {
	id: string
	first: AssistantMessage
	latest: AssistantMessage
	content: DisplayPart[]
	toolCalls: Map<string, number>
	latestStepStart: number
	terminalToolError?: ToolResultMessage
}

/** A display projection only: pi's steps share one assistant message per user turn. */
export function toThreadMessages(snapshot: AgentSessionSnapshot): ThreadMessageLike[] {
	return projectMessages(snapshot, snapshot.messages)
}

/** Keep settled turns and parsed results stable while only the active turn streams. */
export function createThreadMessagesProjector() {
	let conversationId = ''
	let completedSources: readonly AgentMessage[] = []
	let completed: ThreadMessageLike[] = []
	let completedTurns = 0
	const results = new WeakMap<ToolResultMessage, unknown>()
	return (snapshot: AgentSessionSnapshot): ThreadMessageLike[] => {
		const start = snapshot.messages.findLastIndex((message) => message.role === 'user')
		if (start < 0) {
			conversationId = snapshot.id
			completedSources = []
			completed = []
			completedTurns = 0
			return []
		}
		if (
			conversationId !== snapshot.id ||
			completedSources.length !== start ||
			completedSources.some((message, index) => message !== snapshot.messages[index])
		) {
			conversationId = snapshot.id
			completedSources = snapshot.messages.slice(0, start)
			completed = projectMessages(
				{ ...snapshot, isRunning: false, stopped: false },
				completedSources,
				0,
				results,
			)
			completedTurns = completedSources.filter((message) => message.role === 'user').length
		}
		return [
			...completed,
			...projectMessages(snapshot, snapshot.messages.slice(start), completedTurns, results),
		]
	}
}

function projectMessages(
	snapshot: AgentSessionSnapshot,
	sources: readonly AgentMessage[],
	startTurn = 0,
	results?: WeakMap<ToolResultMessage, unknown>,
): ThreadMessageLike[] {
	const messages: ThreadMessageLike[] = []
	let turn = startTurn
	let assistant: AssistantTurn | undefined
	const finishAssistant = (active: boolean) => {
		if (!assistant) return
		messages.push({
			id: assistant.id,
			role: 'assistant',
			content: assistant.content,
			createdAt: new Date(assistant.first.timestamp),
			status: assistantStatus(assistant, snapshot, active, results),
			metadata: { custom: { answerPartIndices: answerPartIndices(assistant) } },
		})
		assistant = undefined
	}
	for (const message of sources) {
		if (message.role === 'user') {
			finishAssistant(false)
			turn++
			messages.push({
				id: `${snapshot.id}-user-${turn}`,
				role: 'user',
				content:
					typeof message.content === 'string'
						? message.content
						: message.content.flatMap((part): DisplayPart[] =>
								part.type === 'text' ? [{ type: 'text', text: part.text }] : [],
							),
				createdAt: new Date(message.timestamp),
			})
		} else if (message.role === 'assistant') {
			assistant ??= {
				id: `${snapshot.id}-assistant-${turn}`,
				first: message,
				latest: message,
				content: [],
				toolCalls: new Map(),
				latestStepStart: 0,
			}
			assistant.latest = message
			assistant.latestStepStart = assistant.content.length
			assistant.terminalToolError = undefined
			for (const part of message.content) {
				// Match assistant-ui's normalization so final-answer indices refer to
				// registered parts even when providers emit empty text/thinking blocks.
				if (part.type === 'text' && part.text.trim())
					assistant.content.push({ type: 'text', text: part.text })
				else if (part.type === 'thinking' && part.thinking.trim()) {
					assistant.content.push({ type: 'reasoning', text: part.thinking })
				} else if (part.type === 'toolCall') {
					assistant.toolCalls.set(part.id, assistant.content.length)
					assistant.content.push({
						type: 'tool-call',
						toolCallId: part.id,
						toolName: part.name,
						args: part.arguments,
						argsText: JSON.stringify(part.arguments),
					})
				}
			}
		} else if (message.role === 'toolResult' && assistant) {
			const index = assistant.toolCalls.get(message.toolCallId)
			if (index === undefined) continue
			const call = assistant.content[index]
			if (call?.type !== 'tool-call') continue
			assistant.content[index] = {
				...call,
				result: toolResultContent(message, results),
				isError: message.isError,
			}
			if (message.isError && index >= assistant.latestStepStart) {
				assistant.terminalToolError = message
			}
		}
	}
	finishAssistant(true)
	return messages
}

// Only text from the last model step without tool calls is an answer. Thinking
// and all preceding steps stay available in the process, without changing pi.
function answerPartIndices(assistant: AssistantTurn): number[] {
	if (assistant.latest.content.some((part) => part.type === 'toolCall')) return []
	return assistant.content.flatMap((part, index) =>
		index >= assistant.latestStepStart && part.type === 'text' ? [index] : [],
	)
}

function assistantStatus(
	assistant: AssistantTurn,
	snapshot: AgentSessionSnapshot,
	active: boolean,
	results?: WeakMap<ToolResultMessage, unknown>,
): ThreadMessageLike['status'] {
	if (active && snapshot.stopped) return { type: 'incomplete', reason: 'cancelled' }
	if (active && snapshot.isRunning) return { type: 'running' }
	const message = assistant.latest
	if (message.stopReason === 'aborted') return { type: 'incomplete', reason: 'cancelled' }
	if (message.stopReason === 'error') {
		return {
			type: 'incomplete',
			reason: 'error',
			error: message.errorMessage ?? '模型请求失败',
		}
	}
	if (message.stopReason === 'length') return { type: 'incomplete', reason: 'length' }
	if (message.stopReason === 'toolUse' && assistant.terminalToolError) {
		const result = assistant.terminalToolError
		const value = toolResultContent(result, results)
		// Only a failed workspace execution record supplies cancellation/error details.
		// Successful tool results and business receipts never determine thread status.
		if (result.toolName === 'runJavaScript' && value && typeof value === 'object') {
			const record = value as { status?: unknown; error?: unknown }
			if (record.status === 'stopped') return { type: 'incomplete', reason: 'cancelled' }
			if (typeof record.error === 'string') {
				return { type: 'incomplete', reason: 'error', error: record.error }
			}
		}
		return {
			type: 'incomplete',
			reason: 'error',
			error: typeof value === 'string' ? value : '工具执行失败',
		}
	}
	if (message.stopReason === 'toolUse') return { type: 'incomplete', reason: 'tool-calls' }
	return { type: 'complete', reason: 'stop' }
}

function toolResultContent(
	message: ToolResultMessage,
	cache?: WeakMap<ToolResultMessage, unknown>,
): unknown {
	if (cache?.has(message)) return cache.get(message)
	const text = message.content
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('\n')
	try {
		const value: unknown = JSON.parse(text)
		cache?.set(message, value)
		return value
	} catch {
		cache?.set(message, text)
		return text
	}
}
