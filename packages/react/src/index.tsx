import {
	createContext,
	useContext,
	useEffect,
	useMemo,
	useSyncExternalStore,
	type ReactNode,
} from 'react'
import {
	AssistantRuntimeProvider,
	useExternalStoreRuntime,
	type ThreadMessageLike,
} from '@assistant-ui/react'
import type { AgentSession } from '@pluxel/browser-worker-agent'
import { useConversationHistory } from './conversations.ts'
import { createThreadMessagesProjector } from './messages.ts'

export { toThreadMessages } from './messages.ts'
export type { ConversationHistoryController } from './conversations.ts'

// A new converter identity resets assistant-ui's cache for the entire history.
const convertMessage = (message: ThreadMessageLike) => message
const sessionViewKeys = new WeakMap<AgentSession, number>()
let nextViewKey = 0

export type AgentWorkspaceProviderProps = {
	session: AgentSession
	children: ReactNode
}

/** The host owns the session; this provider owns the native display runtime and drafts. */
export function AgentWorkspaceProvider({ session, children }: AgentWorkspaceProviderProps) {
	let viewKey = sessionViewKeys.get(session)
	if (viewKey === undefined) {
		viewKey = ++nextViewKey
		sessionViewKeys.set(session, viewKey)
	}
	// Retire the runtime, drafts and consumer portals together on an owner change.
	return (
		<SessionProvider key={viewKey} session={session}>
			{children}
		</SessionProvider>
	)
}

function useWorkspaceRuntime(session: AgentSession) {
	const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
	const projectMessages = useMemo(() => createThreadMessagesProjector(), [])
	const messages = useMemo(() => projectMessages(snapshot), [projectMessages, snapshot])
	const history = useConversationHistory(session, snapshot)
	const runtime = useExternalStoreRuntime({
		adapters: { threadList: history.adapter },
		messages,
		convertMessage,
		isRunning: snapshot.isRunning,
		isSendDisabled:
			!snapshot.isConfigured ||
			snapshot.contextWarning ||
			snapshot.isHistoryLoading ||
			history.busy,
		onNew: async (message) => {
			await session.send(
				message.content
					.filter((part) => part.type === 'text')
					.map((part) => part.text)
					.join('\n'),
			)
		},
		onCancel: async () => session.stop(),
		unstable_enableToolInvocations: false,
	})
	const composer = runtime.thread.composer
	const { getDraft, setDraft } = history
	// Restore after assistant-ui's passive effect installs the new thread composer.
	useEffect(() => {
		composer.setText(getDraft(snapshot.id))
		return composer.subscribe(() => {
			if (session.getSnapshot().id !== snapshot.id) return
			setDraft(snapshot.id, composer.getState().text)
		})
	}, [composer, snapshot.id, getDraft, setDraft, session])
	return useMemo(
		() => ({ session, snapshot, messages, history, runtime }),
		[session, snapshot, messages, history, runtime],
	)
}

export type AgentWorkspaceContext = ReturnType<typeof useWorkspaceRuntime>
const WorkspaceContext = createContext<AgentWorkspaceContext | null>(null)

function SessionProvider({ session, children }: AgentWorkspaceProviderProps) {
	const workspace = useWorkspaceRuntime(session)
	return (
		<WorkspaceContext.Provider value={workspace}>
			<AssistantRuntimeProvider runtime={workspace.runtime}>{children}</AssistantRuntimeProvider>
		</WorkspaceContext.Provider>
	)
}

/** Compose any UI with the same session, native assistant-ui runtime and scoped history. */
export function useAgentWorkspace(): AgentWorkspaceContext {
	const workspace = useContext(WorkspaceContext)
	if (!workspace) throw new Error('useAgentWorkspace requires AgentWorkspaceProvider.')
	return workspace
}
