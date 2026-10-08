// Adapted from assistant-ui's official runtime-aware Reasoning registry (MIT):
// https://r.assistant-ui.com/reasoning.json
// GroupedParts composes these exports directly; the deprecated ReasoningGroup
// and legacy message-parts component wrappers are deliberately omitted.
// Source fingerprint and license: ../../THIRD_PARTY_NOTICES.md.
import { useCallback, useRef } from 'react'
import { useScrollLock } from '@assistant-ui/react'
import {
	ANIMATION_DURATION,
	ReasoningRoot as ReasoningRootBase,
	type ReasoningRootProps,
} from './reasoning.tsx'

export type { ReasoningRootProps } from './reasoning.tsx'
export {
	ReasoningTrigger,
	ReasoningContent,
	ReasoningText,
	ReasoningFade,
	reasoningVariants,
} from './reasoning.tsx'

/** `ReasoningRoot` with the thread viewport scroll locked during disclosure animations. */
function ReasoningRoot({ ref, onAnimationStart, ...props }: ReasoningRootProps) {
	const collapsibleRef = useRef<HTMLDivElement | null>(null)
	const lockScroll = useScrollLock(collapsibleRef, ANIMATION_DURATION)

	const handleAnimationStart = useCallback(() => {
		lockScroll()
		onAnimationStart?.()
	}, [lockScroll, onAnimationStart])

	const composedRef = useCallback(
		(node: HTMLDivElement | null) => {
			collapsibleRef.current = node
			if (typeof ref === 'function') {
				ref(node)
			} else if (ref) {
				;(ref as { current: HTMLDivElement | null }).current = node
			}
		},
		[ref],
	)

	return <ReasoningRootBase ref={composedRef} onAnimationStart={handleAnimationStart} {...props} />
}

export { ReasoningRoot }
