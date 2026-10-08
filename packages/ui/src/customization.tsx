import { createContext, type ComponentType } from 'react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

export type AgentWorkspaceWelcomeProps = {
	configured: boolean
	onConfigure(): void
}

/** Slots replace presentation while the workspace retains message lifecycle and actions. */
export type AgentWorkspaceComponents = {
	Welcome?: ComponentType<AgentWorkspaceWelcomeProps>
	/** Assistant text and reasoning; read the native assistant-ui message-part context. */
	Text?: ComponentType
	/** Fallback for tool calls without a registered assistant-ui tool UI. */
	Tool?: ComponentType<ToolCallMessagePartProps>
}

/** CSS color values shared by the workspace and its portalled dialogs/popovers. */
export type AgentWorkspaceTheme = Partial<{
	background: string
	foreground: string
	primary: string
	'primary-foreground': string
	muted: string
	'muted-foreground': string
	border: string
	destructive: string
}>

export const WorkspaceComponentsContext = createContext<AgentWorkspaceComponents>({})
