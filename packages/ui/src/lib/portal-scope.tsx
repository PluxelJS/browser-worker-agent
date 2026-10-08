import { createContext, useContext, useState, type ReactNode, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { AgentWorkspaceTheme } from '../customization.tsx'

const PortalContainerContext = createContext<HTMLElement | undefined>(undefined)

/** A CSS scope styles descendants, including portalled content, rather than
 * its own boundary node. React owns this container for the current UI owner. */
export function WorkspaceUIScope({
	children,
	theme,
}: {
	children: ReactNode
	theme?: AgentWorkspaceTheme
}) {
	const style: CSSProperties = {
		display: 'contents',
		...Object.fromEntries(
			Object.entries(theme ?? {}).map(([name, value]) => [`--agent-workspace-${name}`, value]),
		),
	}
	const [container, setContainer] = useState<HTMLDivElement | null>(null)
	return (
		<PortalContainerContext.Provider value={container ?? undefined}>
			<div className="aui-root" style={style}>
				{children}
			</div>
			{typeof document !== 'undefined' &&
				createPortal(<div className="aui-root" style={style} ref={setContainer} />, document.body)}
		</PortalContainerContext.Provider>
	)
}

export function useWorkspacePortalContainer() {
	return useContext(PortalContainerContext)
}
