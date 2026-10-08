import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ExternalStoreThreadListAdapter } from '@assistant-ui/react'
import type { AgentSession, AgentSessionSnapshot } from '@pluxel/browser-worker-agent'
import type { WorkspaceHistorySummary } from '@pluxel/browser-worker-agent'

type Intent = { kind: 'rename' | 'delete'; item: WorkspaceHistorySummary } | { kind: 'new' }

/** IndexedDB remains the owner; the native adapter shares its selected ID with the transcript. */
export function useConversationHistory(session: AgentSession, snapshot: AgentSessionSnapshot) {
	const [items, setItems] = useState<WorkspaceHistorySummary[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [navigationVersion, setNavigationVersion] = useState(0)
	const [intent, setIntent] = useState<Intent | null>(null)
	const live = useRef(false)
	const actionActive = useRef(false)
	const listGeneration = useRef(0)
	const drafts = useRef(new Map<string, string>())
	const version = snapshot.historyVersion
	const refresh = useCallback(async () => {
		const generation = ++listGeneration.current
		try {
			const saved = await session.listHistory()
			if (
				live.current &&
				generation === listGeneration.current &&
				session.getSnapshot().historyVersion === version
			) {
				setItems(saved)
				setError(null)
			}
		} catch (cause) {
			if (live.current && generation === listGeneration.current) setError(errorText(cause))
		} finally {
			if (live.current && generation === listGeneration.current) setLoading(false)
		}
	}, [session, version])
	const retire = useCallback(() => {
		live.current = false
		listGeneration.current++
	}, [])
	useEffect(() => {
		live.current = true
		return retire
	}, [retire])
	useEffect(() => {
		void (async () => {
			await Promise.resolve()
			if (live.current) await refresh()
		})()
		// A settled save changes the index; individual stream chunks do not.
	}, [refresh])
	useEffect(() => {
		const onFocus = () => void refresh()
		window.addEventListener('focus', onFocus)
		return () => window.removeEventListener('focus', onFocus)
	}, [refresh])
	const perform = useCallback(async (action: () => Promise<void>) => {
		if (!live.current || actionActive.current) return false
		actionActive.current = true
		setBusy(true)
		setError(null)
		try {
			await action()
			return live.current
		} catch (cause) {
			if (live.current) setError(errorText(cause))
			return false
		} finally {
			actionActive.current = false
			if (live.current) setBusy(false)
		}
	}, [])
	const switchToNew = useCallback(async () => {
		if (session.getSnapshot().isRunning || session.getSnapshot().historySaveState === 'error') {
			setIntent({ kind: 'new' })
			return
		}
		if (await perform(() => session.newConversation())) setNavigationVersion((value) => value + 1)
	}, [session, perform])
	const switchTo = useCallback(
		async (id: string) => {
			if (session.getSnapshot().isRunning) return
			if (await perform(() => session.restore(id))) setNavigationVersion((value) => value + 1)
		},
		[session, perform],
	)
	const rename = useCallback(
		async (id: string, title: string) => {
			await perform(() => session.renameHistory(id, title))
		},
		[session, perform],
	)
	const archive = useCallback(
		async (id: string, archived: boolean) => {
			await perform(() => session.archiveHistory(id, archived))
		},
		[session, perform],
	)
	const remove = useCallback(
		async (id: string) => {
			if (await perform(() => session.deleteHistory(id))) drafts.current.delete(id)
		},
		[session, perform],
	)
	const threadItems = useMemo(() => {
		const entries = items.map((item) =>
			item.id === snapshot.id
				? { ...item, title: snapshot.title, archivedAt: snapshot.archivedAt }
				: item,
		)
		return {
			threads: entries
				.filter((item) => !item.archivedAt)
				.map((item) => ({ ...item, status: 'regular' as const })),
			archivedThreads: entries
				.filter((item) => !!item.archivedAt)
				.map((item) => ({ ...item, status: 'archived' as const })),
		}
	}, [items, snapshot.id, snapshot.title, snapshot.archivedAt])
	const adapter = useMemo<ExternalStoreThreadListAdapter>(
		() => ({
			threadId: snapshot.id,
			isLoading: loading,
			...threadItems,
			onSwitchToNewThread: switchToNew,
			onSwitchToThread: switchTo,
			onRename: rename,
			onArchive: (id) => archive(id, true),
			onUnarchive: (id) => archive(id, false),
			onDelete: remove,
		}),
		[snapshot.id, loading, threadItems, switchToNew, switchTo, rename, archive, remove],
	)
	const getDraft = useCallback((id: string) => drafts.current.get(id) ?? '', [])
	const setDraft = useCallback((id: string, text: string) => {
		if (text) drafts.current.set(id, text)
		else drafts.current.delete(id)
	}, [])
	const deleteDraft = useCallback((id: string) => drafts.current.delete(id), [])
	return useMemo(
		() => ({
			items,
			loading,
			error,
			busy,
			navigationVersion,
			intent,
			setIntent,
			refresh,
			perform,
			archive,
			remove,
			adapter,
			getDraft,
			setDraft,
			deleteDraft,
		}),
		[
			items,
			loading,
			error,
			busy,
			navigationVersion,
			intent,
			refresh,
			perform,
			archive,
			remove,
			adapter,
			getDraft,
			setDraft,
			deleteDraft,
		],
	)
}

export type ConversationHistoryController = ReturnType<typeof useConversationHistory>

function errorText(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause)
}
