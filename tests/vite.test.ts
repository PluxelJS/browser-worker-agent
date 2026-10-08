import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { browserWorkerAgent } from '../src/vite.ts'

const piEntry = import.meta.resolve('@earendil-works/pi-ai')
const modules = [
	'api/bedrock-converse-stream.lazy.js',
	'auth/context.js',
	'auth/oauth/load.js',
	'env-api-keys.js',
	'utils/provider-env.js',
]

async function transform(code: string, id: string) {
	const hook = browserWorkerAgent().transform
	if (!hook || typeof hook === 'function') throw new Error('Expected the filtered transform hook')
	return (await Reflect.apply(hook.handler, {}, [code, id])) as { code: string } | undefined
}

describe('pi browser adapter compatibility', () => {
	it.each(modules.slice(0, -1))(
		'adapts the installed %s and tolerates a second pass',
		async (module) => {
			const url = new URL(module, piEntry)
			const id = fileURLToPath(url)
			const source = await readFile(url, 'utf8')
			const adapted = await transform(source, id)
			expect(adapted).toBeDefined()
			expect(adapted!.code).toContain('/* @vite-ignore */')
			expect(await transform(adapted!.code, id)).toBeUndefined()
		},
	)

	it('replaces the installed environment probe and tolerates a second pass', async () => {
		const url = new URL('utils/provider-env.js', piEntry)
		const id = fileURLToPath(url)
		const adapted = await transform(await readFile(url, 'utf8'), id)
		expect(adapted).toBeDefined()
		expect(adapted!.code).not.toContain('process')
		expect(adapted!.code).not.toContain('node:fs')
		expect(await transform(adapted!.code, id)).toBeUndefined()
	})

	it.each(modules)(
		'reports upstream changes in %s instead of silently skipping them',
		async (module) => {
			const id = fileURLToPath(new URL(module, piEntry))
			await expect(transform('export const upstreamChanged = true', id)).rejects.toThrow(
				'Unsupported pi module shape',
			)
		},
	)
})
