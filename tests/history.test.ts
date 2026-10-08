import { indexedDB, IDBIndex, IDBObjectStore } from 'fake-indexeddb'
import { RpcStub, RpcTarget } from 'capnweb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceHistory, type StoredWorkspaceHistory } from '../src/history.ts'

const stores: WorkspaceHistory[] = []

function store(name = crypto.randomUUID()): WorkspaceHistory {
	vi.stubGlobal('indexedDB', indexedDB)
	const history = new WorkspaceHistory(name)
	stores.push(history)
	return history
}

function record(scopeKey: string, id = 'same-session'): StoredWorkspaceHistory {
	return {
		id,
		scopeKey,
		title: 'Draft change',
		createdAt: 1,
		updatedAt: 2,
		messages: [{ role: 'user', content: [{ type: 'text', text: 'Change my draft' }] }],
		executions: [
			{
				id: 'run',
				code: 'return await api.readDto()',
				startedAt: '2026-10-03T00:00:00Z',
				finishedAt: '2026-10-03T00:00:01Z',
				status: 'completed',
				outputs: [],
				value: { revision: 1 },
				truncated: false,
			},
		],
	}
}

afterEach(() => {
	for (const history of stores.splice(0)) history.close()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

describe('browser workspace history', () => {
	it('partitions by host scope, survives reopening and deletes only the selected scope', async () => {
		const name = crypto.randomUUID()
		const history = store(name)
		await history.save(record('user-1/community-a'))
		await history.save({ ...record('user-2/community-a'), title: 'Another account' })
		await history.save({ ...record('user-1/community-b'), title: 'Another community' })
		expect(await history.list('user-1/community-a')).toEqual([
			{
				id: 'same-session',
				scopeKey: 'user-1/community-a',
				title: 'Draft change',
				titleEdited: false,
				preview: 'Change my draft',
				createdAt: 1,
				updatedAt: 2,
				messageCount: 1,
				executionCount: 1,
				archivedAt: null,
			},
		])
		expect(await history.load('unrelated-user', 'same-session')).toBeUndefined()
		history.close()
		const reopened = store(name)
		expect(await reopened.load('user-1/community-a', 'same-session')).toMatchObject(
			record('user-1/community-a'),
		)
		await reopened.delete('user-1/community-a', 'same-session')
		expect(await reopened.load('user-1/community-a', 'same-session')).toBeUndefined()
		expect((await reopened.load('user-2/community-a', 'same-session'))?.title).toBe(
			'Another account',
		)
	})

	it('lists bounded excerpts and user turns through a cursor without materializing all transcripts', async () => {
		const history = store()
		const getAll = vi.spyOn(IDBIndex.prototype, 'getAll').mockImplementation(() => {
			throw new Error('Full-history aggregate reads are forbidden')
		})
		await history.save({
			...record('scope', 'older'),
			messages: [
				{ role: 'user', content: 'First request' },
				{ role: 'assistant', content: [{ type: 'toolCall', name: 'readDoc' }] },
				{ role: 'toolResult', content: 'Large tool payload '.repeat(10_000) },
				{ role: 'assistant', content: [{ type: 'text', text: 'Old answer' }] },
				{ role: 'user', content: 'Another request' },
				{ role: 'assistant', content: [{ type: 'text', text: 'Final answer '.repeat(100) }] },
			],
		})
		await history.save({ ...record('scope', 'newer'), updatedAt: 3 })
		const summaries = await history.list('scope')
		expect(summaries.map((entry) => entry.id)).toEqual(['newer', 'older'])
		expect(summaries[1]).toMatchObject({ messageCount: 2, executionCount: 1 })
		expect(summaries[1]!.preview).toHaveLength(160)
		expect(summaries[1]!.preview).toContain('Final answer')
		expect(JSON.stringify(summaries)).not.toContain('Large tool payload')
		expect(getAll).not.toHaveBeenCalled()
	})

	it('preserves explicit titles and archive metadata across stale transcript saves and scope boundaries', async () => {
		const history = store()
		const stale = record('scope')
		await history.save(stale)
		await Promise.all([
			history.rename('scope', stale.id, '  My   saved draft  '),
			history.archive('scope', stale.id, true),
		])
		await history.save({ ...stale, updatedAt: 3 })
		expect(await history.load('scope', stale.id)).toMatchObject({
			title: 'My saved draft',
			titleEdited: true,
			archivedAt: expect.any(Number),
			updatedAt: 3,
		})
		await expect(history.rename('other', stale.id, 'No access')).rejects.toThrow('当前范围')
		await expect(history.archive('other', stale.id, false)).rejects.toThrow('当前范围')
		await expect(history.rename('scope', stale.id, '   ')).rejects.toThrow('80')
		await expect(history.rename('scope', stale.id, 'x'.repeat(81))).rejects.toThrow('80')
		await history.archive('scope', stale.id, false)
		await history.save({ ...stale, archivedAt: 1 })
		expect((await history.list('scope'))[0]).toMatchObject({
			title: 'My saved draft',
			archivedAt: null,
		})
	})

	it('stores generated titles once and preserves them across later transcript and archive updates', async () => {
		const history = store()
		const stale = record('scope')
		await history.save(stale)
		await history.archive('scope', stale.id, true)
		const archived = await history.load('scope', stale.id)
		const generated = await history.generateTitle(
			'scope',
			stale.id,
			'标题：“投票配置整理”',
			new AbortController().signal,
		)
		expect(generated).toMatchObject({
			title: '投票配置整理',
			titleGenerated: true,
			titleEdited: false,
			updatedAt: stale.updatedAt,
			archivedAt: archived!.archivedAt,
		})
		await history.save({ ...stale, updatedAt: 3 })
		await history.generateTitle('scope', stale.id, 'Late replacement', new AbortController().signal)
		expect(await history.load('scope', stale.id)).toMatchObject({
			title: '投票配置整理',
			titleGenerated: true,
			updatedAt: 3,
			archivedAt: archived!.archivedAt,
		})
	})

	it.each(['generated-first', 'manual-first'])(
		'keeps manual renames atomic against %s concurrent title writes',
		async (order) => {
			const history = store()
			const stale = record('scope')
			await history.save(stale)
			const generate = () =>
				history.generateTitle('scope', stale.id, 'Model title', new AbortController().signal)
			const rename = () => history.rename('scope', stale.id, 'Personal title')
			await Promise.all(
				order === 'generated-first' ? [generate(), rename()] : [rename(), generate()],
			)
			await history.save({ ...stale, updatedAt: 4 })
			expect(await history.load('scope', stale.id)).toMatchObject({
				title: 'Personal title',
				titleEdited: true,
				updatedAt: 4,
			})
		},
	)

	it('never creates a missing or out-of-scope record while applying a generated title', async () => {
		const history = store()
		const retained = record('scope')
		await history.save(retained)
		await expect(
			history.generateTitle('other', retained.id, 'Wrong scope', new AbortController().signal),
		).rejects.toThrow('当前范围')
		await history.delete('scope', retained.id)
		await expect(
			history.generateTitle('scope', retained.id, 'Late title', new AbortController().signal),
		).rejects.toThrow('当前范围')
		expect(await history.load('scope', retained.id)).toBeUndefined()
		expect(await history.list('other')).toEqual([])
	})

	it('rolls back a generated title cancelled before its transaction commits', async () => {
		const history = store()
		const retained = record('scope')
		await history.save(retained)
		const controller = new AbortController()
		const put = IDBObjectStore.prototype.put
		const write = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
			this: IDBObjectStore,
			value,
			key,
		) {
			const request = put.call(this, value, key)
			controller.abort()
			return request
		})
		await expect(
			history.generateTitle('scope', retained.id, 'Cancelled title', controller.signal),
		).rejects.toThrow(/IndexedDB transaction (?:failed|was aborted)/)
		write.mockRestore()
		expect(await history.load('scope', retained.id)).toMatchObject(retained)
		expect((await history.load('scope', retained.id))?.titleGenerated).toBeUndefined()
		await expect(
			history.generateTitle('scope', retained.id, 'Already cancelled', controller.signal),
		).rejects.toThrow(/abort/i)
	})

	it('refuses live references, accessors, cycles and missing identity keys', async () => {
		const history = store()
		const capability = new RpcStub(new RpcTarget())
		await expect(history.save({ ...record('scope'), messages: [capability] })).rejects.toThrow(
			'JSON',
		)
		capability[Symbol.dispose]()
		let getterCalls = 0
		const accessor = Object.defineProperty({}, 'value', {
			enumerable: true,
			get() {
				getterCalls += 1
				return 'sensitive'
			},
		})
		await expect(history.save({ ...record('scope'), messages: [accessor] })).rejects.toThrow(
			'getters',
		)
		expect(getterCalls).toBe(0)
		const circular: Record<string, unknown> = {}
		circular.self = circular
		await expect(history.save({ ...record('scope'), messages: [circular] })).rejects.toThrow(
			'circular',
		)
		await expect(history.save(record(''))).rejects.toThrow('identity')
	})

	it('reports storage failures and closed-owner operations instead of pretending to save', async () => {
		const history = store()
		vi.stubGlobal('indexedDB', {
			open() {
				throw new Error('Storage denied')
			},
		})
		await expect(history.save(record('scope'))).rejects.toThrow('Storage denied')
		vi.stubGlobal('indexedDB', indexedDB)
		await history.save(record('scope'))
		history.close()
		await expect(history.load('scope', 'same-session')).rejects.toThrow('closed')
	})

	it('reopens with the same owner after another tab clears the database', async () => {
		const name = crypto.randomUUID()
		const history = store(name)
		const retained = record('scope')
		await history.save(retained)
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.deleteDatabase(name)
			request.addEventListener('success', () => resolve(), { once: true })
			request.addEventListener(
				'error',
				() => reject(request.error ?? new Error('Could not clear the test database.')),
				{ once: true },
			)
			request.addEventListener(
				'blocked',
				() => reject(new Error('The history owner did not release the old database.')),
				{ once: true },
			)
		})
		await history.save({ ...retained, title: 'Saved again', updatedAt: 3 })
		expect(await history.load('scope', retained.id)).toMatchObject({
			...retained,
			title: 'Saved again',
			updatedAt: 3,
		})
		expect((await history.list('scope'))[0]).toMatchObject({
			id: retained.id,
			title: 'Saved again',
			messageCount: 1,
		})
	})
})
