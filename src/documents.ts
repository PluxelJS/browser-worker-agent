export interface WorkspaceDocument {
	id: string
	title: string
	version: string
	text: string
}

export interface DocumentMatch {
	id: string
	title: string
	version: string
	startLine: number
	endLine: number
	excerpt: string
	/** The excerpt ends partway through a line; readDoc retrieves the complete contract. */
	truncated?: true
}

export interface DocumentPosition {
	/** One-based line number. */
	startLine: number
	/** Zero-based JavaScript string offset within that line. */
	startCharacter: number
}

export interface DocumentRead extends WorkspaceDocument {
	startLine: number
	/** Omitted when zero. */
	startCharacter?: number
	endLine: number
	totalLines: number
	truncated: boolean
	/** Pass this position to readDoc without endLine to continue without dropping characters. */
	next?: DocumentPosition
}

export class DocumentError extends Error {
	readonly code: 'invalid_query' | 'unknown_document' | 'invalid_range'
	readonly details: { id?: string; totalLines?: number; lineCharacters?: number }

	constructor(
		code: DocumentError['code'],
		message: string,
		details: DocumentError['details'] = {},
	) {
		super(message)
		this.name = 'DocumentError'
		this.code = code
		this.details = details
	}
}

export const DOCUMENT_LIMITS = {
	queryCharacters: 200,
	searchResults: 5,
	excerptCharacters: 500,
	readLines: 60,
	readCharacters: 6_000,
} as const

export function searchDocs(
	documents: readonly WorkspaceDocument[],
	query: string,
): DocumentMatch[] {
	if (query.length > DOCUMENT_LIMITS.queryCharacters) {
		throw new DocumentError(
			'invalid_query',
			`Document search is limited to ${DOCUMENT_LIMITS.queryCharacters} characters. Search a method, type or short task phrase.`,
		)
	}
	const phrase = query.trim().toLowerCase()
	const terms = [...new Set(phrase.split(/\s+/).filter(Boolean))].slice(0, 12)
	if (terms.length === 0) return []
	const candidates = documents
		.map((document) => {
			const id = document.id.toLowerCase()
			const title = document.title.toLowerCase()
			const lines = document.text.split('\n')
			const normalizedLines = lines.map((line) => line.toLowerCase())
			const matched = terms.filter(
				(term) =>
					id.includes(term) ||
					title.includes(term) ||
					normalizedLines.some((line) => line.includes(term)),
			)
			const metadataScore = matched.reduce(
				(total, term) => total + (id.includes(term) ? 4 : 0) + (title.includes(term) ? 4 : 0),
				id.includes(phrase) || title.includes(phrase) ? 8 : 0,
			)
			// Show the line that covers the most query terms, not the first generic hit.
			let bestLine = 0
			let bestScore = 0
			for (let index = 0; index < normalizedLines.length; index++) {
				const line = normalizedLines[index]!
				const score = terms.reduce((total, term) => total + (line.includes(term) ? 1 : 0), 0)
				if (score > bestScore) {
					bestLine = index
					bestScore = score
				}
			}
			const context = lines.slice(bestLine, bestLine + 4).join('\n')
			const excerpt = boundedText(context, DOCUMENT_LIMITS.excerptCharacters)
			const startLine = bestLine + 1
			return {
				matchedTerms: matched.length,
				metadataScore,
				match: {
					id: document.id,
					title: document.title,
					version: document.version,
					startLine,
					endLine: startLine + excerpt.split('\n').length - 1,
					excerpt,
					...(excerpt.length < context.length ? { truncated: true as const } : {}),
				},
			}
		})
		.filter((entry) => entry.matchedTerms > 0)
	const exact = candidates.find((entry) => entry.match.id.toLowerCase() === phrase)
	const coverage = candidates.reduce((maximum, entry) => Math.max(maximum, entry.matchedTerms), 0)
	return (exact ? [exact] : candidates.filter((entry) => entry.matchedTerms === coverage))
		.toSorted(
			(a, b) =>
				b.matchedTerms - a.matchedTerms ||
				b.metadataScore - a.metadataScore ||
				a.match.id.localeCompare(b.match.id),
		)
		.slice(0, DOCUMENT_LIMITS.searchResults)
		.map((entry) => entry.match)
}

/** Inclusive one-based lines; next preserves partial lines and newline separators. */
export function readDoc(
	documents: readonly WorkspaceDocument[],
	id: string,
	startLine = 1,
	endLine?: number,
	startCharacter = 0,
): DocumentRead {
	const document = documents.find((entry) => entry.id === id)
	if (!document)
		throw new DocumentError(
			'unknown_document',
			`Unknown document: ${id}. Use searchDocs to find a current document ID.`,
			{ id },
		)
	const lines = document.text.split('\n')
	const requestedEnd = endLine ?? lines.length
	if (
		!Number.isSafeInteger(startLine) ||
		!Number.isSafeInteger(requestedEnd) ||
		!Number.isSafeInteger(startCharacter) ||
		startLine < 1 ||
		(endLine !== undefined && endLine < startLine) ||
		startCharacter < 0
	) {
		throw new DocumentError(
			'invalid_range',
			'Document line range must use positive, increasing integer line numbers; startCharacter must be a nonnegative integer.',
			{ id, totalLines: lines.length },
		)
	}
	if (startLine > lines.length)
		throw new DocumentError(
			'invalid_range',
			`Document has ${lines.length} lines. Choose startLine from 1 to ${lines.length}.`,
			{ id, totalLines: lines.length },
		)
	const lineCharacters = lines[startLine - 1]!.length
	if (startCharacter > lineCharacters)
		throw new DocumentError(
			'invalid_range',
			`Line ${startLine} has ${lineCharacters} characters. Use startCharacter from 0 to ${lineCharacters}, or the returned next position.`,
			{ id, totalLines: lines.length, lineCharacters },
		)
	const limitedEnd = Math.min(requestedEnd, startLine + DOCUMENT_LIMITS.readLines - 1, lines.length)
	const requestedText = lines
		.slice(startLine - 1, limitedEnd)
		.join('\n')
		.slice(startCharacter)
	const text = boundedText(requestedText, DOCUMENT_LIMITS.readCharacters)
	const actualEnd = startLine + text.split('\n').length - 1
	const lastNewline = text.lastIndexOf('\n')
	const endCharacter =
		lastNewline < 0 ? startCharacter + text.length : text.length - lastNewline - 1
	const next =
		actualEnd < lines.length || endCharacter < lines[actualEnd - 1]!.length
			? { startLine: actualEnd, startCharacter: endCharacter }
			: undefined
	return {
		id: document.id,
		title: document.title,
		version: document.version,
		startLine,
		...(startCharacter ? { startCharacter } : {}),
		endLine: actualEnd,
		totalLines: lines.length,
		text,
		truncated:
			limitedEnd < Math.min(requestedEnd, lines.length) || requestedText.length > text.length,
		...(next ? { next } : {}),
	}
}

function boundedText(text: string, limit: number): string {
	let end = Math.min(text.length, limit)
	// Keep one Unicode character intact when the budget intersects a surrogate pair.
	if (
		end < text.length &&
		/[\uD800-\uDBFF]/.test(text[end - 1] ?? '') &&
		/[\uDC00-\uDFFF]/.test(text[end] ?? '')
	)
		end--
	return text.slice(0, end)
}
