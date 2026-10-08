// Adapted from assistant-ui's official thread registry (MIT).
// Source and supported slot adaptations: ../../THIRD_PARTY_NOTICES.md.
import type { ReactNode, ComponentType } from 'react'
import { ThreadPrimitive, MessagePrimitive, ComposerPrimitive } from '@assistant-ui/react'
import { cn } from '../lib/utils.ts'

type ThreadProps = {
	empty: boolean
	welcome: ReactNode
	composer: ReactNode
	components: { UserMessage: ComponentType; AssistantMessage: ComponentType }
}

/** Official thread anatomy, with host-owned welcome and composer slots. */
export function Thread({ empty, welcome, composer, components }: ThreadProps) {
	return (
		<ThreadPrimitive.Root className="aui-root aui-thread-root agent-workspace-thread bg-background flex h-full flex-col">
			<ThreadPrimitive.Viewport
				turnAnchor="top"
				data-slot="aui_thread-viewport"
				className="agent-workspace-viewport relative flex flex-1 flex-col overflow-x-hidden overflow-y-scroll"
			>
				<div
					className={cn('mx-auto flex w-full flex-1 flex-col px-3 pt-3', empty && 'justify-center')}
				>
					{empty && welcome}
					<div className="agent-workspace-messages mb-6 flex flex-col gap-y-4 empty:hidden">
						<ThreadPrimitive.Messages components={components} />
					</div>
					<ThreadPrimitive.ViewportFooter
						className={cn(
							'agent-workspace-composer-area aui-thread-viewport-footer bg-background flex flex-col gap-2 overflow-visible pb-2 md:pb-3',
							!empty && 'sticky bottom-0 mt-auto rounded-t-(--composer-radius)',
						)}
					>
						{composer}
					</ThreadPrimitive.ViewportFooter>
				</div>
			</ThreadPrimitive.Viewport>
		</ThreadPrimitive.Root>
	)
}

/** Official text-only user row; no separate avatar, speaker or card design. */
export function UserMessage({ children }: { children: ReactNode }) {
	return (
		<MessagePrimitive.Root
			data-slot="aui_user-message-root"
			data-role="user"
			className="agent-workspace-message agent-workspace-user grid auto-rows-auto grid-cols-[minmax(32px,1fr)_auto] content-start gap-y-2 px-2 [&:where(>*)]:col-start-2"
		>
			<div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
				<div className="aui-user-message-content bg-muted text-foreground rounded-(--composer-radius) px-4 py-2 wrap-break-word empty:hidden">
					{children}
				</div>
			</div>
		</MessagePrimitive.Root>
	)
}

/** Official composer shell; assistant-ui retains the autosizing input and events. */
export function Composer({ children }: { children: ReactNode }) {
	return (
		<ComposerPrimitive.Root className="agent-workspace-composer aui-composer-root relative flex w-full flex-col">
			<div
				data-slot="aui_composer-shell"
				className="border-foreground/10 focus-within:border-foreground/25 flex w-full cursor-text flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) transition-[border-color] motion-reduce:transition-none"
			>
				{children}
			</div>
		</ComposerPrimitive.Root>
	)
}

export const composerInputClass =
	'aui-composer-input agent-workspace-input caret-primary placeholder:text-muted-foreground/60 max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base leading-6 outline-none'
