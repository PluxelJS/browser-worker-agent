import { RpcPromise, RpcStub } from 'capnweb'
import { acquireWorkerApi } from './rpc.ts'
import {
	boundedJson,
	errorText,
	EXECUTION_LIMITS,
	type WorkerStart,
	type WorkerResponse,
} from './execution-protocol.ts'

interface WorkerScope {
	postMessage(message: WorkerResponse, options: StructuredSerializeOptions): void
	addEventListener(type: 'message', listener: (event: MessageEvent<WorkerStart>) => void): void
}

const scope = globalThis as unknown as WorkerScope

/** Observes public stub operations while retaining Cap'n Web's navigation and pipelining. */
function observeApi(api: RpcStub<any>, isActive: () => boolean) {
	interface PendingCall {
		observed: boolean
		settled: boolean
		pipelined: boolean
	}
	const outstanding = new Set<PendingCall>()
	const rpcErrors = new Set<unknown>()
	let recordingMap = 0
	function assertActive(): void {
		if (!isActive()) throw new Error('Execution has ended; further RPC dispatch is disabled.')
	}
	function addCall(): PendingCall {
		const call = { observed: false, settled: false, pipelined: false }
		outstanding.add(call)
		return call
	}
	function resolved(value: unknown): unknown {
		if (value instanceof RpcStub) return wrap(value, new Set())
		if (value && typeof value === 'object') {
			return new Proxy(value, {
				get(target, property, receiver) {
					if (typeof property === 'symbol') return Reflect.get(target, property, receiver)
					return resolved(Reflect.get(target, property, receiver))
				},
			})
		}
		return value
	}
	function wrap(source: RpcStub<any>, parents: Set<PendingCall>): RpcStub<any> {
		return new Proxy(source, {
			get(target, property) {
				if (property === Symbol.dispose) return () => target[Symbol.dispose]?.()
				// Cap'n Web uses private symbols while encoding stub arguments. Forward
				// symbols untouched rather than replacing its reference semantics.
				if (typeof property === 'symbol') return Reflect.get(target, property, target)
				if (
					(property === 'then' || property === 'catch' || property === 'finally') &&
					target instanceof RpcPromise
				) {
					return (...handlers: Array<((value: any) => unknown) | undefined>) => {
						assertActive()
						const observed = new Set([...parents, addCall()])
						for (const call of observed) call.observed = true
						const promise = target.then(
							(value: unknown) => {
								for (const call of observed) {
									call.settled = true
									outstanding.delete(call)
								}
								return resolved(value)
							},
							(error: unknown) => {
								for (const call of observed) {
									call.settled = true
									outstanding.delete(call)
								}
								if (rpcErrors.size < 100) rpcErrors.add(error)
								throw error
							},
						)
						if (property === 'catch') return promise.catch(handlers[0])
						if (property === 'finally')
							return promise.finally(handlers[0] as (() => void) | undefined)
						return promise.then(handlers[0], handlers[1])
					}
				}
				if (property === 'dup')
					return () => {
						assertActive()
						return wrap(target.dup(), parents)
					}
				if (property === 'onRpcBroken') return target.onRpcBroken.bind(target)
				if (property === 'toString') return target.toString.bind(target)
				if (property === 'map')
					return (...args: any[]) => {
						assertActive()
						for (const call of parents) call.pipelined = true
						const map = Reflect.get(target, 'map', target) as (...params: any[]) => RpcStub<any>
						let result: RpcStub<any>
						// The native map callback records RPC expressions synchronously; those
						// expressions are instructions within this one call, not pending calls.
						recordingMap += 1
						try {
							result = Reflect.apply(map, target, args)
						} finally {
							recordingMap -= 1
						}
						return wrap(result, new Set([...parents, addCall()]))
					}
				const result = Reflect.get(target, property, target)
				return result instanceof RpcStub ? wrap(result, parents) : result
			},
			apply(target, thisArg, argumentsList) {
				assertActive()
				for (const call of parents) call.pipelined = true
				const result = Reflect.apply(target as unknown as Function, thisArg, argumentsList)
				if (recordingMap > 0) return result
				return result instanceof RpcStub ? wrap(result, new Set([...parents, addCall()])) : result
			},
		})
	}
	return {
		api: wrap(api, new Set()),
		pending: () =>
			[...outstanding].filter((call) => !call.pipelined && (!call.observed || !call.settled))
				.length,
		isRpcError: (error: unknown) => rpcErrors.has(error),
	}
}

let started = false
scope.addEventListener('message', (event) => {
	if (started || event.data.type !== 'execute') return
	started = true
	void execute(event.data)
})

async function execute(start: WorkerStart): Promise<void> {
	const api = acquireWorkerApi(start.port)
	let active = true
	let truncated = false
	let outputEntries = 0
	let outputCharacters = 0
	const observed = observeApi(api, () => active)
	function complete(result: Extract<WorkerResponse, { type: 'result' }>): void {
		if (!active) return
		active = false
		api[Symbol.dispose]()
		scope.postMessage({ ...result, truncated: result.truncated || truncated }, { transfer: [] })
	}
	function print(value: unknown): void {
		if (!active) return
		if (
			outputEntries >= EXECUTION_LIMITS.outputEntries ||
			outputCharacters >= EXECUTION_LIMITS.outputCharacters
		) {
			if (!truncated)
				scope.postMessage(
					{ type: 'output', text: '[output truncated]', truncated: true },
					{ transfer: [] },
				)
			truncated = true
			return
		}
		const bounded = boundedJson(
			value,
			Math.min(4_000, EXECUTION_LIMITS.outputCharacters - outputCharacters),
		)
		const text = typeof bounded.value === 'string' ? bounded.value : JSON.stringify(bounded.value)
		outputEntries += 1
		outputCharacters += text.length
		truncated ||= bounded.truncated
		scope.postMessage({ type: 'output', text, truncated: bounded.truncated }, { transfer: [] })
	}
	let script: (api: RpcStub<any>, print: (value: unknown) => void) => Promise<unknown>
	try {
		const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
		script = new AsyncFunction('api', 'print', `"use strict";\n${start.code}\n`)
	} catch (error) {
		complete({
			type: 'result',
			status: error instanceof SyntaxError ? 'syntax_error' : 'execution_error',
			error: errorText(error),
			truncated,
		})
		return
	}
	try {
		const value = await script(observed.api, print)
		const pending = observed.pending()
		if (pending > 0) {
			complete({
				type: 'result',
				status: 'execution_error',
				error: `Script returned with ${pending} RPC call(s) unawaited. Dispatched writes may have an unknown outcome; do not rerun the script.`,
				truncated,
			})
			return
		}
		const result =
			value === undefined ? undefined : boundedJson(value, EXECUTION_LIMITS.valueCharacters)
		complete({
			type: 'result',
			status: 'completed',
			...(result ? { value: result.value } : {}),
			truncated: truncated || (result?.truncated ?? false),
		})
	} catch (error) {
		complete({
			type: 'result',
			status: observed.isRpcError(error) ? 'rpc_error' : 'execution_error',
			error: errorText(error),
			truncated,
		})
	}
}
