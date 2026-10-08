const usage = {
	input: 2,
	output: 3,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 5,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}
const steps = [
	{ name: 'searchDocs', arguments: { query: 'configuration' } },
	{ name: 'readDoc', arguments: { id: 'api' } },
	{
		name: 'runJavaScript',
		arguments: { code: 'const dto = await api.currentDto(); print(dto); return dto.revision;' },
	},
]
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sse = (data, event) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`
const nativeEvent = (type, fields = {}) => sse({ type, ...fields }, type)
async function writeFragments(res, chunks, delayIndex, delayMs, index = 0) {
	if (res.destroyed || index >= chunks.length) return
	res.write(chunks[index])
	if (index === delayIndex) await delay(delayMs)
	return writeFragments(res, chunks, delayIndex, delayMs, index + 1)
}

export function toolResultCount(api, body) {
	switch (api) {
		case 'openai-completions':
		case 'mistral-conversations':
			return body.messages.filter((message) => message.role === 'tool').length
		case 'openai-responses':
		case 'azure-openai-responses':
			return body.input.filter((item) => item.type === 'function_call_output').length
		case 'anthropic-messages':
			return body.messages
				.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
				.filter((part) => part.type === 'tool_result').length
		case 'google-generative-ai':
		case 'google-vertex':
			return body.contents
				.flatMap((content) => content.parts)
				.filter((part) => part.functionResponse).length
		case 'pi-messages':
			return body.context.messages.filter((message) => message.role === 'toolResult').length
		default:
			throw new Error(`Unknown native protocol ${api}`)
	}
}

/** Native wire fixtures, decoded by pi's pinned adapters and the real upstream SDKs. */
function completionEvents(step, index, text, model) {
	const chunk = (delta, finishReason = null) =>
		sse({
			id: 'controlled-completion',
			object: 'chat.completion.chunk',
			created: 1,
			model,
			choices: [{ index: 0, delta, finish_reason: finishReason }],
		})
	if (step) {
		const args = JSON.stringify(step.arguments)
		return [
			chunk({ role: 'assistant' }),
			chunk({
				tool_calls: [
					{
						index: 0,
						id: `call0000${index}`,
						type: 'function',
						function: { name: step.name, arguments: args.slice(0, 5) },
					},
				],
			}),
			chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] }),
			chunk({}, 'tool_calls'),
			'data: [DONE]\n\n',
		]
	}
	return [
		chunk({ role: 'assistant' }),
		chunk({ content: text[0] }),
		chunk({ content: text[1] }),
		chunk({}, 'stop'),
		'data: [DONE]\n\n',
	]
}
function responseEvents(step, index, text, model) {
	const event = nativeEvent
	const response = { id: 'resp_controlled', model, status: 'in_progress', output: [] }
	const start = [event('response.created', { response })]
	// DeepSeek emits plain reasoning; Kimi returns it in summary_text with a null
	// encrypted_content. Both must survive the next tool turn through native pi replay.
	const reasoningText = 'Inspect the requested workspace data.'
	const reasoning = model.startsWith('deepseek-')
		? {
				type: 'reasoning',
				id: `rs_controlled_${index}`,
				content: [{ type: 'reasoning_text', text: reasoningText }],
				summary: [],
			}
		: model === 'kimi-k3'
			? {
					type: 'reasoning',
					id: `rs_controlled_${index}`,
					summary: [{ type: 'summary_text', text: reasoningText }],
					encrypted_content: null,
					status: 'completed',
				}
			: undefined
	if (reasoning) {
		start.push(
			event('response.output_item.added', {
				output_index: 0,
				item: {
					...reasoning,
					...(reasoning.content ? { content: [] } : {}),
					summary: [],
					status: 'in_progress',
				},
			}),
		)
		const eventName = reasoning.content ? 'reasoning_text' : 'reasoning_summary_text'
		start.push(
			event(`response.${eventName}.delta`, {
				output_index: 0,
				content_index: 0,
				delta: reasoningText,
			}),
		)
		start.push(
			event(`response.${eventName}.done`, {
				output_index: 0,
				content_index: 0,
				text: reasoningText,
			}),
		)
		start.push(event('response.output_item.done', { output_index: 0, item: reasoning }))
	}
	const outputIndex = reasoning ? 1 : 0
	let item
	if (step) {
		const args = JSON.stringify(step.arguments)
		item = {
			type: 'function_call',
			id: `fc_controlled_${index}`,
			call_id: `call0000${index}`,
			name: step.name,
			arguments: '',
		}
		start.push(
			event('response.output_item.added', { output_index: outputIndex, item: { ...item } }),
		)
		start.push(
			event('response.function_call_arguments.delta', {
				output_index: outputIndex,
				delta: args.slice(0, 5),
			}),
		)
		start.push(
			event('response.function_call_arguments.delta', {
				output_index: outputIndex,
				delta: args.slice(5),
			}),
		)
		item.arguments = args
		start.push(
			event('response.function_call_arguments.done', {
				output_index: outputIndex,
				arguments: args,
			}),
		)
	} else {
		item = { type: 'message', id: 'msg_controlled', role: 'assistant', content: [] }
		start.push(
			event('response.output_item.added', { output_index: outputIndex, item: { ...item } }),
		)
		start.push(event('response.output_text.delta', { output_index: outputIndex, delta: text[0] }))
		start.push(event('response.output_text.delta', { output_index: outputIndex, delta: text[1] }))
		item.content = [{ type: 'output_text', text: text.join(''), annotations: [] }]
	}
	return [
		...start,
		event('response.output_item.done', { output_index: outputIndex, item }),
		event('response.completed', {
			response: {
				...response,
				status: 'completed',
				output: [...(reasoning ? [reasoning] : []), item],
				usage: {
					input_tokens: 2,
					output_tokens: 3,
					total_tokens: 5,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens_details: { reasoning_tokens: 0 },
				},
			},
		}),
	]
}
function anthropicEvents(step, index, text, model) {
	const event = nativeEvent
	const events = [
		event('message_start', {
			message: {
				id: 'msg_controlled',
				type: 'message',
				role: 'assistant',
				model,
				content: [],
				stop_reason: null,
				usage: { input_tokens: 2, output_tokens: 0 },
			},
		}),
	]
	if (step) {
		const args = JSON.stringify(step.arguments)
		events.push(
			event('content_block_start', {
				index: 0,
				content_block: { type: 'tool_use', id: `call0000${index}`, name: step.name, input: {} },
			}),
		)
		events.push(
			event('content_block_delta', {
				index: 0,
				delta: { type: 'input_json_delta', partial_json: args.slice(0, 5) },
			}),
		)
		events.push(
			event('content_block_delta', {
				index: 0,
				delta: { type: 'input_json_delta', partial_json: args.slice(5) },
			}),
		)
	} else {
		events.push(
			event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
		)
		events.push(
			event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text[0] } }),
		)
		events.push(
			event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text[1] } }),
		)
	}
	return [
		...events,
		event('content_block_stop', { index: 0 }),
		event('message_delta', {
			delta: { stop_reason: step ? 'tool_use' : 'end_turn', stop_sequence: null },
			usage: { output_tokens: 3 },
		}),
		event('message_stop'),
	]
}
function googleEvents(step, index, text, model) {
	const chunk = (parts, done = false) =>
		sse({
			responseId: 'google_controlled',
			modelVersion: model,
			candidates: [
				{ index: 0, content: { role: 'model', parts }, ...(done ? { finishReason: 'STOP' } : {}) },
			],
			...(done
				? { usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } }
				: {}),
		})
	return step
		? [
				chunk(
					[{ functionCall: { id: `call0000${index}`, name: step.name, args: step.arguments } }],
					true,
				),
			]
		: [chunk([{ text: text[0] }]), chunk([{ text: text[1] }], true)]
}
function piEvents(step, index, text) {
	const events = [sse({ type: 'start' })]
	if (step) {
		const args = JSON.stringify(step.arguments)
		const toolCall = {
			type: 'toolCall',
			id: `call0000${index}`,
			name: step.name,
			arguments: step.arguments,
		}
		events.push(
			sse({ type: 'toolcall_start', contentIndex: 0, id: toolCall.id, toolName: toolCall.name }),
		)
		events.push(sse({ type: 'toolcall_delta', contentIndex: 0, delta: args.slice(0, 5) }))
		events.push(sse({ type: 'toolcall_delta', contentIndex: 0, delta: args.slice(5) }))
		events.push(sse({ type: 'toolcall_end', contentIndex: 0, toolCall }))
	} else {
		events.push(sse({ type: 'text_start', contentIndex: 0 }))
		events.push(sse({ type: 'text_delta', contentIndex: 0, delta: text[0] }))
		events.push(sse({ type: 'text_delta', contentIndex: 0, delta: text[1] }))
		events.push(sse({ type: 'text_end', contentIndex: 0, content: text.join('') }))
	}
	return [...events, sse({ type: 'done', reason: step ? 'toolUse' : 'stop', usage })]
}
function nativeEvents(api, step, index, text, model) {
	switch (api) {
		case 'openai-completions':
		case 'mistral-conversations':
			return completionEvents(step, index, text, model)
		case 'openai-responses':
		case 'azure-openai-responses':
			return responseEvents(step, index, text, model)
		case 'anthropic-messages':
			return anthropicEvents(step, index, text, model)
		case 'google-generative-ai':
		case 'google-vertex':
			return googleEvents(step, index, text, model)
		case 'pi-messages':
			return piEvents(step, index, text)
		default:
			throw new Error(`Unknown protocol ${api}`)
	}
}
function initialTextEventCount(api) {
	if (api === 'google-generative-ai' || api === 'google-vertex') return 1
	if (api === 'openai-completions' || api === 'mistral-conversations') return 2
	return 3
}

export function controlledProviderFixturePlugin(state) {
	return {
		name: 'agent-workspace:controlled-native-provider-tests',
		configureServer(server) {
			server.middlewares.use(async (req, res, next) => {
				const url = new URL(req.url, 'http://fixture.test')
				if (!url.pathname.startsWith('/__providers/')) return next()
				res.setHeader('Access-Control-Allow-Origin', '*')
				res.setHeader('Access-Control-Allow-Headers', '*')
				if (req.method === 'OPTIONS') {
					res.end()
					return
				}
				if (url.pathname === '/__providers/control' && req.method === 'POST') {
					let raw = ''
					for await (const part of req) raw += part
					const config = JSON.parse(raw)
					state.active = { ...config, requests: [], closed: 0 }
					state.cases.set(config.id, state.active)
					res.setHeader('Content-Type', 'application/json')
					res.end('{}')
					return
				}
				if (url.pathname === '/__providers/stats') {
					res.setHeader('Content-Type', 'application/json')
					res.end(JSON.stringify(state.cases.get(url.searchParams.get('id'))))
					return
				}
				const id = url.pathname.split('/')[2]
				const fixture = state.cases.get(id)
				if (!fixture) {
					res.statusCode = 404
					res.end('Unknown controlled fixture')
					return
				}
				let raw = ''
				for await (const part of req) raw += part
				const body = JSON.parse(raw)
				const toolResults = toolResultCount(fixture.api, body)
				fixture.requests.push({
					url: req.headers['x-controlled-original-url'] ?? req.url,
					headers: req.headers,
					body,
					toolResults,
				})
				res.on('close', () => fixture.closed++)
				if (fixture.mode === 'error') {
					res.statusCode = 503
					res.setHeader('Content-Type', 'application/json')
					res.end(
						JSON.stringify({
							type: 'error',
							error: {
								code: 503,
								status: 'UNAVAILABLE',
								type: 'overloaded_error',
								message: 'CONTROLLED_NATIVE_HTTP_503',
							},
						}),
					)
					return
				}
				const step = fixture.mode === 'loop' ? steps[toolResults] : undefined
				const chunks = nativeEvents(
					fixture.api,
					step,
					toolResults,
					[`native ${fixture.api}: `, 'verified revision 7'],
					body.model ?? fixture.model ?? 'controlled',
				)
				res.setHeader('Content-Type', 'text/event-stream')
				res.setHeader('Cache-Control', 'no-cache')
				res.flushHeaders()
				const partialCount = initialTextEventCount(fixture.api)
				await writeFragments(
					res,
					chunks,
					step ? -1 : partialCount - 1,
					fixture.mode === 'stop' ? 1500 : 40,
				)
				res.end()
			})
		},
	}
}
