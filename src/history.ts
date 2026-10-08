import type { ExecutionRecord } from './execution.ts'
import { normalizeGeneratedTitle } from './titles.ts'

export interface StoredWorkspaceHistory {
	id: string
	scopeKey: string
	title: string
	/** Set only by an explicit rename, so later transcript saves retain this title. */
	titleEdited?: boolean
	/** A model supplied this title; a manual title still takes precedence. */
	titleGenerated?: boolean
	/** A bounded display excerpt; never a model prompt or an execution instruction. */
	preview?: string
	archivedAt?: number
	createdAt: number
	updatedAt: number
	/** Plain JSON messages only. Model credentials and capabilities belong in memory. */
	messages: unknown[]
	executions: ExecutionRecord[]
}

export type WorkspaceHistorySummary = {
	id: string
	scopeKey: string
	title: string
	titleEdited: boolean
	titleGenerated?: boolean
	preview: string
	createdAt: number
	updatedAt: number
	messageCount: number
	executionCount: number
	archivedAt: number | null
}

const STORE = 'conversations'
const MAX_RECORD_CHARACTERS = 2_000_000
const MAX_PREVIEW_CHARACTERS = 160

function messageText(message: unknown): string {
	if (!message || typeof message !== 'object') return ''
	const entry = message as { role?: string; content?: unknown }
	if (entry.role !== 'user' && entry.role !== 'assistant') return ''
	if (typeof entry.content === 'string') return entry.content
	if (!Array.isArray(entry.content)) return ''
	return entry.content
		.filter(
			(part): part is { type: 'text'; text: string } =>
				part?.type === 'text' && typeof part.text === 'string',
		)
		.map((part) => part.text)
		.join(' ')
}

function summary(record: StoredWorkspaceHistory): WorkspaceHistorySummary {
	let preview = record.preview
	if (preview === undefined) {
		for (let index = record.messages.length - 1; index >= 0; index--) {
			const text = messageText(record.messages[index])
			if (!text.trim()) continue
			preview = text.replace(/\s+/g, ' ').trim().slice(0, MAX_PREVIEW_CHARACTERS)
			break
		}
	}
	return {
		id: record.id,
		scopeKey: record.scopeKey,
		title: record.title,
		titleEdited: record.titleEdited ?? false,
		...(record.titleGenerated ? { titleGenerated: true } : {}),
		preview: preview?.slice(0, MAX_PREVIEW_CHARACTERS) ?? '',
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		messageCount: record.messages.filter(
			(message) =>
				!!message && typeof message === 'object' && 'role' in message && message.role === 'user',
		).length,
		executionCount: record.executions.length,
		archivedAt: record.archivedAt ?? null,
	}
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.addEventListener('success', () => resolve(request.result), { once: true })
		request.addEventListener(
			'error',
			() => reject(request.error ?? new Error('IndexedDB request failed.')),
			{ once: true },
		)
	})
}

function transactionResult(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.addEventListener('complete', () => resolve(), { once: true })
		transaction.addEventListener(
			'error',
			() => reject(transaction.error ?? new Error('IndexedDB transaction failed.')),
			{ once: true },
		)
		transaction.addEventListener(
			'abort',
			() => reject(transaction.error ?? new Error('IndexedDB transaction was aborted.')),
			{ once: true },
		)
	})
}

/** Reject capabilities, accessors and unsupported values before persistence. */
function validateJson(value: unknown, seen = new Set<object>(), depth = 0): void {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return
	if (typeof value === 'number' && Number.isFinite(value)) return
	if (typeof value !== 'object' || depth > 80)
		throw new Error('History must contain plain JSON values only.')
	if (seen.has(value)) throw new Error('History cannot contain circular values.')
	const prototype = Object.getPrototypeOf(value)
	if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
		throw new Error('History cannot contain class instances or RPC capabilities.')
	}
	seen.add(value)
	for (const key of Reflect.ownKeys(value)) {
		if (key === 'length' && Array.isArray(value)) continue
		if (typeof key !== 'string')
			throw new Error('History cannot contain symbols or live RPC results.')
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		if (!descriptor || !('value' in descriptor))
			throw new Error('History cannot contain getters or setters.')
		validateJson(descriptor.value, seen, depth + 1)
	}
	seen.delete(value)
}

/** Browser persistence scoped by the stable identity key supplied by the host. */
export class WorkspaceHistory {
	#database: Promise<IDBDatabase> | undefined
	#closed = false

	constructor(private readonly databaseName = 'agent-workspace-history') {}

	async #open(): Promise<IDBDatabase> {
		if (this.#closed) throw new Error('Workspace history is closed.')
		if (!this.#database) {
			this.#database = new Promise((resolve, reject) => {
				let request: IDBOpenDBRequest
				let failed = false
				try {
					request = indexedDB.open(this.databaseName, 1)
				} catch (error) {
					reject(error)
					return
				}
				request.addEventListener(
					'upgradeneeded',
					() => {
						const store = request.result.createObjectStore(STORE, { keyPath: ['scopeKey', 'id'] })
						store.createIndex('scope', 'scopeKey')
					},
					{ once: true },
				)
				request.addEventListener(
					'error',
					() => {
						failed = true
						reject(request.error ?? new Error('Cannot open workspace history.'))
					},
					{ once: true },
				)
				request.addEventListener(
					'blocked',
					() => {
						failed = true
						reject(new Error('Workspace history is blocked by another browser tab.'))
					},
					{ once: true },
				)
				request.addEventListener(
					'success',
					() => {
						const database = request.result
						if (this.#closed || failed) {
							database.close()
							reject(new Error('Workspace history was closed while opening.'))
						} else {
							database.addEventListener(
								'versionchange',
								() => {
									database.close()
									this.#database = undefined
								},
								{ once: true },
							)
							resolve(database)
						}
					},
					{ once: true },
				)
			})
			this.#database.catch(() => {
				this.#database = undefined
			})
		}
		return this.#database
	}

	async list(scopeKey: string): Promise<WorkspaceHistorySummary[]> {
		const database = await this.#open()
		const transaction = database.transaction(STORE, 'readonly')
		const records: WorkspaceHistorySummary[] = []
		// A cursor releases each full transcript before reading the next. Listing
		// conversations must not clone every message history into an aggregate array.
		const request = transaction.objectStore(STORE).index('scope').openCursor(scopeKey)
		await new Promise<void>((resolve, reject) => {
			request.addEventListener('success', () => {
				const cursor = request.result
				if (!cursor) {
					resolve()
					return
				}
				try {
					records.push(summary(cursor.value as StoredWorkspaceHistory))
					cursor.continue()
				} catch (error) {
					reject(error)
					transaction.abort()
				}
			})
			request.addEventListener(
				'error',
				() => reject(request.error ?? new Error('Cannot list workspace history.')),
				{ once: true },
			)
		})
		return records.toSorted((a, b) => b.updatedAt - a.updatedAt)
	}

	async load(scopeKey: string, id: string): Promise<StoredWorkspaceHistory | undefined> {
		const database = await this.#open()
		const transaction = database.transaction(STORE, 'readonly')
		return requestResult<StoredWorkspaceHistory | undefined>(
			transaction.objectStore(STORE).get([scopeKey, id]),
		)
	}

	async save(record: StoredWorkspaceHistory): Promise<WorkspaceHistorySummary> {
		validateJson(record)
		if (!record.id || !record.scopeKey)
			throw new Error('History requires a session ID and an identity scope.')
		const database = await this.#open()
		const transaction = database.transaction(STORE, 'readwrite')
		const completed = transactionResult(transaction)
		try {
			const store = transaction.objectStore(STORE)
			const existing = await requestResult<StoredWorkspaceHistory | undefined>(
				store.get([record.scopeKey, record.id]),
			)
			const saved = { ...record }
			// Transcript saves never undo an explicit rename or archive operation,
			// including when another session owner has queued an older snapshot.
			if (existing?.titleEdited || existing?.titleGenerated) {
				saved.title = existing.title
				if (existing.titleEdited) saved.titleEdited = true
				if (existing.titleGenerated) saved.titleGenerated = true
			}
			if (existing) {
				delete saved.archivedAt
				if (existing.archivedAt !== undefined) saved.archivedAt = existing.archivedAt
			}
			saved.preview = summary({ ...saved, preview: undefined }).preview
			if (JSON.stringify(saved).length > MAX_RECORD_CHARACTERS) {
				throw new Error(
					'This conversation exceeds the history storage limit. Export it or start a new conversation.',
				)
			}
			store.put(saved)
			await completed
			return summary(saved)
		} catch (error) {
			try {
				transaction.abort()
			} catch {
				// The transaction may already have failed or completed.
			}
			await completed.catch(() => {})
			throw error
		}
	}

	async rename(scopeKey: string, id: string, title: string): Promise<WorkspaceHistorySummary> {
		const normalized = title.trim().replace(/\s+/g, ' ')
		if (!normalized || normalized.length > 80) throw new Error('会话名称须为 1 至 80 个字符。')
		return this.#update(scopeKey, id, (record) => ({
			...record,
			title: normalized,
			titleEdited: true,
		}))
	}

	async archive(scopeKey: string, id: string, archived: boolean): Promise<WorkspaceHistorySummary> {
		return this.#update(scopeKey, id, (record) => {
			const updated = { ...record }
			if (archived) updated.archivedAt = Date.now()
			else delete updated.archivedAt
			return updated
		})
	}

	async generateTitle(
		scopeKey: string,
		id: string,
		title: string,
		signal: AbortSignal,
	): Promise<WorkspaceHistorySummary> {
		const normalized = normalizeGeneratedTitle(title)
		if (!normalized) throw new Error('Invalid generated conversation title.')
		return this.#update(
			scopeKey,
			id,
			(record) =>
				record.titleEdited || record.titleGenerated
					? undefined
					: { ...record, title: normalized, titleGenerated: true },
			signal,
		)
	}

	async #update(
		scopeKey: string,
		id: string,
		update: (record: StoredWorkspaceHistory) => StoredWorkspaceHistory | undefined,
		signal?: AbortSignal,
	): Promise<WorkspaceHistorySummary> {
		signal?.throwIfAborted()
		const database = await this.#open()
		signal?.throwIfAborted()
		const transaction = database.transaction(STORE, 'readwrite')
		const completed = transactionResult(transaction)
		const cancel = () => {
			try {
				transaction.abort()
			} catch {
				// A completed transaction has no remaining write to cancel.
			}
		}
		signal?.addEventListener('abort', cancel, { once: true })
		try {
			const store = transaction.objectStore(STORE)
			const record = await requestResult<StoredWorkspaceHistory | undefined>(
				store.get([scopeKey, id]),
			)
			if (!record || record.scopeKey !== scopeKey || record.id !== id)
				throw new Error('历史会话不存在或不属于当前范围。')
			signal?.throwIfAborted()
			const updated = update(record)
			if (updated) store.put(updated)
			await completed
			return summary(updated ?? record)
		} catch (error) {
			try {
				transaction.abort()
			} catch {
				// The transaction may already have failed or completed.
			}
			await completed.catch(() => {})
			throw error
		} finally {
			signal?.removeEventListener('abort', cancel)
		}
	}

	async delete(scopeKey: string, id: string): Promise<void> {
		const database = await this.#open()
		const transaction = database.transaction(STORE, 'readwrite')
		const completed = transactionResult(transaction)
		transaction.objectStore(STORE).delete([scopeKey, id])
		await completed
	}

	close(): void {
		this.#closed = true
		void this.#database?.then(
			(database) => database.close(),
			() => {},
		)
	}
}
