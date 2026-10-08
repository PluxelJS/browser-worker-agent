import { RpcStub, RpcTarget } from 'capnweb'
import { describe, expect, it } from 'vitest'
import { boundedJson } from '../src/execution-protocol.ts'

describe('bounded execution feedback', () => {
	it('omits capabilities and getters without executing them', () => {
		const capability = new RpcStub(new RpcTarget())
		let reads = 0
		const value = {
			nested: capability,
			get credential() {
				reads += 1
				return 'secret'
			},
		}
		const result = boundedJson(value, 1000)
		expect(result).toEqual({
			value: { nested: '[RPC capability omitted]', credential: '[accessor omitted]' },
			truncated: true,
		})
		expect(reads).toBe(0)
		capability[Symbol.dispose]()
	})

	it('bounds escaped strings, array fanout, recursion and circular values', () => {
		for (const value of [
			'"'.repeat(100_000),
			Array.from({ length: 100_000 }, () => 'x'),
			'\\'.repeat(100_000),
		]) {
			const result = boundedJson(value, 500)
			expect(result.truncated).toBe(true)
			expect(JSON.stringify(result.value).length).toBeLessThanOrEqual(500)
		}
		const circle: Record<string, unknown> = {}
		circle.self = circle
		expect(boundedJson(circle, 500)).toEqual({
			value: { self: '[circular value omitted]' },
			truncated: true,
		})
	})
})
