import { describe, expect, it } from 'vitest'
import {
	DOCUMENT_LIMITS,
	DocumentError,
	readDoc,
	searchDocs,
	type DocumentPosition,
	type WorkspaceDocument,
} from '../src/documents.ts'

const documents: WorkspaceDocument[] = [
	{
		id: 'write',
		title: 'Configuration revision and receipts',
		version: '3',
		text: 'Read the draft.\nSave with operationId and expectedRevision.\nConfirm unknown writes using the original operationId.',
	},
	{
		id: 'read',
		title: 'Navigation',
		version: '1',
		text: 'The current API is scoped by the host.\nUse readDto for configuration queries.',
	},
]

describe('host document tools', () => {
	it('finds documents using real public contract terms with deterministic bounded excerpts', () => {
		expect(searchDocs(documents, 'operationId')).toEqual([
			{
				id: 'write',
				title: 'Configuration revision and receipts',
				version: '3',
				startLine: 2,
				endLine: 3,
				excerpt:
					'Save with operationId and expectedRevision.\nConfirm unknown writes using the original operationId.',
			},
		])
		expect(searchDocs(documents, '   ')).toEqual([])
		expect(() => searchDocs(documents, 'a'.repeat(DOCUMENT_LIMITS.queryCharacters + 1))).toThrow(
			'limited',
		)
	})

	it('returns inclusive one-based line ranges and exposes truncation and continuation', () => {
		expect(readDoc(documents, 'write', 2, 2)).toMatchObject({
			id: 'write',
			version: '3',
			startLine: 2,
			endLine: 2,
			totalLines: 3,
			text: 'Save with operationId and expectedRevision.',
			truncated: false,
		})
		const large = [
			{
				id: 'large',
				title: 'API declarations',
				version: '1',
				text: Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n'),
			},
		]
		expect(readDoc(large, 'large', 1, 500)).toMatchObject({
			startLine: 1,
			endLine: 60,
			totalLines: 500,
			truncated: true,
			next: { startLine: 60, startCharacter: 'line 60'.length },
		})
		expect(readDoc(large, 'large', 61, 120)).toMatchObject({
			startLine: 61,
			endLine: 120,
			truncated: false,
		})
		expect(() => readDoc(documents, 'missing')).toThrow('Unknown document')
		expect(() => readDoc(documents, 'write', 0)).toThrow('positive')
		expect(() => readDoc(documents, 'write', 4)).toThrow('3 lines')
	})

	it('ranks exact document IDs and complete task terms above generic matches', () => {
		const catalog: WorkspaceDocument[] = [
			{ id: 'index', title: 'Poll methods', version: '1', text: 'poll getDto updateDto' },
			{
				id: 'rpc.poll.getDto',
				title: 'api.polls().getDto',
				version: '1',
				text: 'Get a poll snapshot.',
			},
			{
				id: 'rpc.poll.updateDto',
				title: 'api.polls().updateDto',
				version: '1',
				text: 'Update a poll snapshot.',
			},
		]
		expect(searchDocs(catalog, 'poll updateDto')[0]?.id).toBe('rpc.poll.updateDto')
		expect(searchDocs(catalog, 'poll updateDto').map((match) => match.id)).toEqual([
			'rpc.poll.updateDto',
			'index',
		])
		expect(searchDocs(catalog, 'rpc.poll.getDto').map((match) => match.id)).toEqual([
			'rpc.poll.getDto',
		])
		expect(searchDocs(catalog, 'poll poll updateDto')[0]?.id).toBe('rpc.poll.updateDto')
	})

	it('locates the relevant contract line instead of the first generic query word', () => {
		const catalog: WorkspaceDocument[] = [
			{
				id: 'poll',
				title: 'Poll API',
				version: '1',
				text: 'poll introduction\ngetDto reads a poll\nOther material\nupdateDto saves a poll with revision\nCheck receipt.',
			},
		]
		expect(searchDocs(catalog, 'poll updateDto')).toMatchObject([
			{
				startLine: 4,
				endLine: 5,
				excerpt: 'updateDto saves a poll with revision\nCheck receipt.',
			},
		])
	})

	it('bounds search payloads and marks a partial contract line explicitly', () => {
		const catalog: WorkspaceDocument[] = Array.from({ length: 20 }, (_, index) => ({
			id: `method.${index}`,
			title: 'API method',
			version: '1',
			text: `method ${'a'.repeat(DOCUMENT_LIMITS.excerptCharacters * 2)}`,
		}))
		const matches = searchDocs(catalog, 'method')
		expect(matches).toHaveLength(DOCUMENT_LIMITS.searchResults)
		expect(
			matches.every((match) => match.excerpt.length <= DOCUMENT_LIMITS.excerptCharacters),
		).toBe(true)
		expect(matches.every((match) => match.truncated === true)).toBe(true)
	})

	it('continues dense single-line declarations without skipping their unread tail', () => {
		const text = `type Dense = {${'property: string; '.repeat(1_500)}}`
		const catalog: WorkspaceDocument[] = [{ id: 'dense', title: 'Dense type', version: '1', text }]
		const first = readDoc(catalog, 'dense')
		expect(first).toMatchObject({
			startLine: 1,
			endLine: 1,
			truncated: true,
			next: { startLine: 1, startCharacter: DOCUMENT_LIMITS.readCharacters },
		})
		expect(readAllPages(catalog, 'dense')).toBe(text)
	})

	it('preserves newline separators, empty lines and Unicode across line and character budgets', () => {
		const text = Array.from({ length: 150 }, (_, index) => {
			if (index === 7) return 'a'.repeat(DOCUMENT_LIMITS.readCharacters - 1) + '😀'.repeat(7_000)
			return index % 8 === 0 ? '' : `line ${index + 1}\r`
		}).join('\n')
		const catalog: WorkspaceDocument[] = [{ id: 'mixed', title: 'Mixed', version: '1', text }]
		expect(readAllPages(catalog, 'mixed')).toBe(text)
		const dense: WorkspaceDocument[] = [
			{
				id: 'unicode',
				title: 'Unicode',
				version: '1',
				text: 'a'.repeat(DOCUMENT_LIMITS.readCharacters - 1) + '😀next',
			},
		]
		const first = readDoc(dense, 'unicode')
		expect(first.text).toHaveLength(DOCUMENT_LIMITS.readCharacters - 1)
		expect(first.next?.startCharacter).toBe(DOCUMENT_LIMITS.readCharacters - 1)
		expect(readAllPages(dense, 'unicode')).toBe(dense[0]!.text)
	})

	it('exposes actionable errors without dumping the catalog', () => {
		for (const [read, code, detail] of [
			[() => readDoc(documents, 'missing'), 'unknown_document', { id: 'missing' }],
			[() => readDoc(documents, 'write', 1.5), 'invalid_range', { totalLines: 3 }],
			[() => readDoc(documents, 'write', 2, 1), 'invalid_range', { totalLines: 3 }],
			[() => readDoc(documents, 'write', 1, undefined, -1), 'invalid_range', { totalLines: 3 }],
			[
				() => readDoc(documents, 'write', 1, undefined, 1_000),
				'invalid_range',
				{ totalLines: 3, lineCharacters: 'Read the draft.'.length },
			],
		] as const) {
			let caught: unknown
			try {
				read()
			} catch (error) {
				caught = error
			}
			expect(caught).toBeInstanceOf(DocumentError)
			expect(caught).toMatchObject({ code, details: detail })
		}
	})
})

function readAllPages(sourceDocuments: WorkspaceDocument[], id: string): string {
	const chunks: string[] = []
	let next: DocumentPosition | undefined = { startLine: 1, startCharacter: 0 }
	while (next) {
		const page = readDoc(sourceDocuments, id, next.startLine, undefined, next.startCharacter)
		expect(page.text.length).toBeLessThanOrEqual(DOCUMENT_LIMITS.readCharacters)
		expect(page.endLine - page.startLine + 1).toBeLessThanOrEqual(DOCUMENT_LIMITS.readLines)
		expect(page.next).not.toEqual(next)
		chunks.push(page.text)
		next = page.next
	}
	return chunks.join('')
}
