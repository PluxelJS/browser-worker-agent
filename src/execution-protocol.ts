import { RpcStub } from 'capnweb'
import type { ExecutionRecord } from './execution.ts'

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue }

export const EXECUTION_LIMITS = {
	codeCharacters: 64_000,
	outputCharacters: 32_000,
	outputEntries: 64,
	valueCharacters: 16_000,
	errorCharacters: 2_000,
	defaultTimeoutMs: 60_000,
	maximumTimeoutMs: 300_000,
} as const

export interface WorkerStart {
	type: 'execute'
	code: string
	port: MessagePort
}

export type WorkerResponse =
	| { type: 'output'; text: string; truncated: boolean }
	| {
			type: 'result'
			status: ExecutionRecord['status']
			value?: JsonValue
			error?: string
			truncated: boolean
	  }

export function errorText(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error)
	return text.slice(0, EXECUTION_LIMITS.errorCharacters)
}

/** Bounded conversion that never calls user toJSON/getters or retains a capability. */
export function boundedJson(
	value: unknown,
	characters: number,
): { value: JsonValue; truncated: boolean } {
	let remaining = characters
	let truncated = false
	let nodes = 0
	const seen = new Set<object>()
	function text(input: string): string {
		const available = Math.max(0, remaining - 2)
		const result = input.slice(0, available)
		remaining -= result.length + 2
		if (result.length !== input.length) truncated = true
		return result
	}
	function convert(input: unknown, depth: number): JsonValue {
		nodes += 1
		if (nodes > 500 || depth > 8 || remaining < 20) {
			truncated = true
			return '[truncated]'
		}
		if (input === null) {
			remaining -= 4
			return null
		}
		if (typeof input === 'boolean') {
			remaining -= 5
			return input
		}
		if (typeof input === 'number' && Number.isFinite(input)) {
			remaining -= 24
			return input
		}
		if (typeof input === 'string') return text(input)
		if (input instanceof RpcStub) {
			truncated = true
			return text('[RPC capability omitted]')
		}
		if (typeof input !== 'object') {
			truncated = true
			return text(`[${typeof input} omitted]`)
		}
		if (seen.has(input)) {
			truncated = true
			return text('[circular value omitted]')
		}
		if (input instanceof Error)
			return convert({ name: input.name, message: input.message }, depth + 1)
		if (
			Object.getPrototypeOf(input) !== Object.prototype &&
			!Array.isArray(input) &&
			Object.getPrototypeOf(input) !== null
		) {
			truncated = true
			return text('[non-JSON value omitted]')
		}
		seen.add(input)
		remaining -= 2
		if (Array.isArray(input)) {
			const result: JsonValue[] = []
			for (let index = 0; index < input.length; index += 1) {
				if (remaining < 30 || nodes > 500) {
					truncated = true
					break
				}
				remaining -= 1
				const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
				if (!descriptor || !('value' in descriptor)) {
					result.push(text('[accessor omitted]'))
					truncated = true
				} else result.push(convert(descriptor.value, depth + 1))
			}
			seen.delete(input)
			return result
		}
		const result: Record<string, JsonValue> = {}
		for (const key of Object.keys(input)) {
			if (remaining < key.length + 32 || nodes > 500) {
				truncated = true
				break
			}
			remaining -= key.length + 4
			const descriptor = Object.getOwnPropertyDescriptor(input, key)
			if (!descriptor || !('value' in descriptor)) {
				result[key] = text('[accessor omitted]')
				truncated = true
			} else
				Object.defineProperty(result, key, {
					value: convert(descriptor.value, depth + 1),
					enumerable: true,
				})
		}
		seen.delete(input)
		return result
	}
	const converted = convert(value, 0)
	// JSON escaping can expand strings. Apply a final byte-independent character
	// bound so a large result cannot flood the model or the main thread.
	const encoded = JSON.stringify(converted)
	if (encoded.length > characters) {
		const marker = '… [result truncated]'
		const prefixLength = Math.max(0, Math.floor((characters - marker.length - 2) / 2))
		const preview = encoded.slice(0, prefixLength) + marker
		return { value: JSON.stringify(preview).length <= characters ? preview : null, truncated: true }
	}
	return { value: converted, truncated }
}
