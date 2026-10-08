import { exposeApi, type ApiLease } from './rpc.ts'
import {
	EXECUTION_LIMITS,
	boundedJson,
	errorText,
	type JsonValue,
	type WorkerStart,
} from './execution-protocol.ts'

export { EXECUTION_LIMITS, type JsonValue } from './execution-protocol.ts'

export interface ExecutionRecord {
	id: string
	code: string
	startedAt: string
	finishedAt: string
	status: 'completed' | 'stopped' | 'timeout' | 'syntax_error' | 'rpc_error' | 'execution_error'
	outputs: string[]
	value?: JsonValue
	error?: string
	truncated: boolean
}

export interface RunJavaScriptOptions {
	/** Async JavaScript function body. `api` and `print(value)` are in scope. */
	code: string
	acquireApi: () => Promise<ApiLease> | ApiLease
	signal?: AbortSignal
	timeoutMs?: number
	/** Return a fresh Worker running this package's /worker entry; this run owns its termination. */
	createWorker?: () => Worker
	onOutput?: (output: string) => void
}

const EXECUTION_STATUSES = new Set<string>([
	'completed',
	'stopped',
	'timeout',
	'syntax_error',
	'rpc_error',
	'execution_error',
])

function isExecutionStatus(status: unknown): status is ExecutionRecord['status'] {
	return typeof status === 'string' && EXECUTION_STATUSES.has(status)
}

/** Each run owns one native Worker, MessagePort session, and host API lease. */
export function runJavaScript(options: RunJavaScriptOptions): Promise<ExecutionRecord> {
	const record: ExecutionRecord = {
		id: crypto.randomUUID(),
		code: options.code.slice(0, EXECUTION_LIMITS.codeCharacters),
		startedAt: new Date().toISOString(),
		finishedAt: '',
		status: 'execution_error',
		outputs: [],
		truncated: options.code.length > EXECUTION_LIMITS.codeCharacters,
	}
	return new Promise((resolve) => {
		let finished = false
		let worker: Worker | undefined
		let bridge: Disposable | undefined
		let lease: ApiLease | undefined
		let timer: ReturnType<typeof setTimeout> | undefined
		let outputCharacters = 0
		let outputTruncationShown = false
		let receivedPackets = 0
		const stopped = () =>
			finish('stopped', 'Execution was stopped. Dispatched writes may still complete.')

		function cleanup(): void {
			if (timer) clearTimeout(timer)
			options.signal?.removeEventListener('abort', stopped)
			worker?.terminate()
			try {
				bridge?.[Symbol.dispose]()
			} catch {}
			try {
				lease?.release()
			} catch {}
			bridge = undefined
			lease = undefined
		}
		function finish(status: ExecutionRecord['status'], error?: string, value?: JsonValue): void {
			if (finished) return
			finished = true
			record.status = status
			record.finishedAt = new Date().toISOString()
			if (error) record.error = error.slice(0, EXECUTION_LIMITS.errorCharacters)
			if (value !== undefined) record.value = value
			cleanup()
			resolve(record)
		}
		function output(text: string, truncated: boolean): void {
			record.truncated ||= truncated
			if (
				record.outputs.length >= EXECUTION_LIMITS.outputEntries ||
				outputCharacters >= EXECUTION_LIMITS.outputCharacters
			) {
				record.truncated = true
				if (!outputTruncationShown) {
					outputTruncationShown = true
					const marker = '[output truncated]'
					if (record.outputs.length === EXECUTION_LIMITS.outputEntries)
						record.outputs[record.outputs.length - 1] = marker
					else record.outputs.push(marker)
				}
				return
			}
			const available = Math.max(0, EXECUTION_LIMITS.outputCharacters - outputCharacters)
			const boundedText = text.slice(0, available)
			record.truncated ||= boundedText.length < text.length
			outputCharacters += boundedText.length
			record.outputs.push(boundedText)
			try {
				options.onOutput?.(boundedText)
			} catch {}
		}

		if (options.signal?.aborted) {
			stopped()
			return
		}
		if (record.truncated) {
			finish(
				'execution_error',
				`JavaScript is limited to ${EXECUTION_LIMITS.codeCharacters} characters.`,
			)
			return
		}
		const timeoutMs = options.timeoutMs ?? EXECUTION_LIMITS.defaultTimeoutMs
		if (
			!Number.isFinite(timeoutMs) ||
			timeoutMs <= 0 ||
			timeoutMs > EXECUTION_LIMITS.maximumTimeoutMs
		) {
			finish(
				'execution_error',
				`Timeout must be between 1 and ${EXECUTION_LIMITS.maximumTimeoutMs} milliseconds.`,
			)
			return
		}
		options.signal?.addEventListener('abort', stopped, { once: true })
		timer = setTimeout(
			() =>
				finish(
					'timeout',
					'Execution exceeded its time limit. Dispatched writes may still complete.',
				),
			timeoutMs,
		)

		void (async () => {
			let acquired: ApiLease
			try {
				acquired = await options.acquireApi()
			} catch (error) {
				finish('rpc_error', errorText(error))
				return
			}
			if (finished) {
				try {
					acquired.release()
				} catch {}
				return
			}
			lease = acquired
			try {
				worker = options.createWorker
					? options.createWorker()
					: new Worker(new URL('./execution.worker.js', import.meta.url), {
							type: 'module',
							name: 'agent-javascript',
						})
				// A host factory can synchronously cancel the run before returning its Worker.
				if (finished) {
					worker.terminate()
					return
				}
				worker.addEventListener('message', (event: MessageEvent<unknown>) => {
					if (finished) return
					// The normal Worker sends at most the bounded print entries, one
					// truncation marker and a final result. Generated code can use the
					// global postMessage directly, so bounding retained output alone
					// does not prevent a flood of UI-thread message callbacks.
					receivedPackets += 1
					if (receivedPackets > EXECUTION_LIMITS.outputEntries + 2) {
						record.truncated = true
						finish(
							'execution_error',
							'Worker exceeded its feedback packet limit. Execution was stopped; dispatched writes may still complete.',
						)
						return
					}
					// Generated JavaScript can also call the global postMessage function.
					// Treat every received packet as untrusted protocol input and reapply
					// feedback bounds on the receiving side.
					if (!event.data || typeof event.data !== 'object') return
					const message = event.data as {
						type?: unknown
						text?: unknown
						status?: unknown
						error?: unknown
						value?: unknown
						truncated?: unknown
					}
					if (message.type === 'output' && typeof message.text === 'string') {
						output(message.text, message.truncated === true)
					} else if (message.type === 'result') {
						if (
							!isExecutionStatus(message.status) ||
							typeof message.truncated !== 'boolean' ||
							(message.error !== undefined && typeof message.error !== 'string')
						)
							return
						const result =
							message.status === 'completed' && message.value !== undefined
								? boundedJson(message.value, EXECUTION_LIMITS.valueCharacters)
								: undefined
						record.truncated ||= message.truncated || (result?.truncated ?? false)
						finish(message.status, message.error, result?.value)
					}
				})
				worker.addEventListener('error', (event) => {
					event.preventDefault()
					finish('execution_error', event.message || 'JavaScript Worker failed to start.')
				})
				worker.addEventListener('messageerror', () =>
					finish('execution_error', 'JavaScript Worker returned an unreadable message.'),
				)
				const channel = new MessageChannel()
				bridge = exposeApi(channel.port1, acquired.api)
				const start: WorkerStart = { type: 'execute', code: options.code, port: channel.port2 }
				worker.postMessage(start, [channel.port2])
			} catch (error) {
				finish('execution_error', errorText(error))
			}
		})()
	})
}
