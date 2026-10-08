import { useEffect, useInsertionEffect, useMemo, useRef, type RefObject } from 'react'
import {
	useAui,
	unstable_useMentionAdapter,
	unstable_useTriggerPopoverRootContext,
	unstable_useTriggerPopoverScopeContext,
	type Unstable_DirectiveFormatter,
} from '@assistant-ui/react'
import { FileTextIcon, RefreshCwIcon, XIcon } from 'lucide-react'
import { Alert, AlertDescription } from './components/ui/alert.tsx'
import { Button } from './components/ui/button.tsx'
import { ComposerTriggerPopover } from './elements/composer-trigger-popover.aui.tsx'

/** The host supplies both display data and the exact text to send to its model. */
export type WorkspaceReferenceItem = {
	id: string
	label: string
	description?: string
	insertText: string
}
export type WorkspaceReferenceSource = {
	trigger: string
	label: string
	items: readonly WorkspaceReferenceItem[]
	isLoading?: boolean
	error?: string
	onRefresh?: () => void
}

// Native assistant-ui owns trigger detection, IME, keyboard selection and text
// replacement. References insert host text; they never register or execute tools.
const referenceFormatter: Unstable_DirectiveFormatter = {
	serialize: (item) =>
		typeof item.metadata?.insertText === 'string' ? item.metadata.insertText : item.label,
	parse: (text) => (text ? [{ kind: 'text', text }] : []),
}

export function ReferencePopover({
	source,
	inputRef,
}: {
	source: WorkspaceReferenceSource
	inputRef: RefObject<HTMLTextAreaElement | null>
}) {
	const trigger = source.trigger
	const queryRef = useRef('')
	const insertion = useRef<{ input: HTMLTextAreaElement; cursor: number; text: string } | null>(
		null,
	)
	const formatter = useMemo<Unstable_DirectiveFormatter>(
		() => ({
			parse: (text) => referenceFormatter.parse(text),
			serialize: (item) => {
				const text = referenceFormatter.serialize(item)
				const input = inputRef.current
				// Serialize precedes native text replacement. The scope's query describes
				// its replace span; React may move the DOM caret before committing it.
				if (input) {
					const start = input.selectionStart - trigger.length - queryRef.current.length
					const after = input.value.slice(input.selectionStart)
					insertion.current = {
						input,
						cursor: start + text.length + 1,
						text:
							input.value.slice(0, start) + text + (after.startsWith(' ') ? after : ` ${after}`),
					}
				} else insertion.current = null
				return text
			},
		}),
		[inputRef, trigger],
	)
	const onInserted = () => {
		const selected = insertion.current
		insertion.current = null
		if (!selected) return
		requestAnimationFrame(() => {
			// ExternalStoreRuntime may still expose its old text inside onInserted.
			if (inputRef.current !== selected.input || selected.input.value !== selected.text) return
			selected.input.focus({ preventScroll: true })
			selected.input.setSelectionRange(selected.cursor, selected.cursor)
		})
	}
	const items = useMemo(
		() =>
			(source.error ? [] : source.items).map((item) => ({
				id: item.id,
				type: 'reference',
				label: item.label,
				description: item.description,
				metadata: { insertText: item.insertText },
			})),
		[source.items, source.error],
	)
	const { adapter } = unstable_useMentionAdapter({
		items,
		includeModelContextTools: false,
	})
	return (
		<ComposerTriggerPopover
			char={source.trigger}
			adapter={adapter}
			directive={{ formatter, onInserted }}
			isLoading={source.isLoading}
			aria-label={`${source.label}引用`}
			className="agent-workspace-reference-popover max-w-[calc(100vw-2rem)]"
			fallbackIcon={FileTextIcon}
			backLabel="返回"
			emptyCategoriesLabel="没有可用的引用"
			emptyItemsLabel="没有匹配的引用"
			loadingLabel="正在加载引用…"
			header={<ReferenceHeader source={source} />}
			error={
				source.error ? (
					<Alert variant="destructive">
						<AlertDescription>{source.error}</AlertDescription>
					</Alert>
				) : undefined
			}
			footer={
				<p className="border-t px-3 py-2 text-xs text-muted-foreground">
					↑ ↓ 选择 · Enter/Tab 引用 · Esc 关闭
				</p>
			}
			onMouseDown={(event) => event.preventDefault()}
		>
			<ReferenceBehavior queryRef={queryRef} />
		</ComposerTriggerPopover>
	)
}

function ReferenceBehavior({ queryRef }: { queryRef: RefObject<string> }) {
	const scope = unstable_useTriggerPopoverScopeContext()
	const { open, query } = scope
	useInsertionEffect(() => {
		queryRef.current = query
	}, [query, queryRef])
	useEffect(() => {
		if (!open) return undefined
		const dismiss = (event: PointerEvent) => {
			const target = event.target
			if (!(target instanceof Element)) return
			if (
				target.closest(
					'[data-slot="composer-trigger-popover"], .aui-composer-input, .agent-workspace-input, .agent-workspace-reference-actions',
				)
			)
				return
			scope.close()
		}
		document.addEventListener('pointerdown', dismiss, true)
		return () => document.removeEventListener('pointerdown', dismiss, true)
	}, [open, scope])
	return null
}

function ReferenceHeader({ source }: { source: WorkspaceReferenceSource }) {
	const scope = unstable_useTriggerPopoverScopeContext()
	return (
		<div className="flex items-center justify-between gap-2 border-b px-3 py-2">
			<span className="text-sm font-medium">
				{source.trigger} {source.label}
			</span>
			<div className="flex items-center gap-1">
				{source.onRefresh && (
					<Button
						type="button"
						aria-label={`刷新${source.label}引用`}
						variant="ghost"
						size="icon"
						disabled={source.isLoading}
						onClick={source.onRefresh}
					>
						<RefreshCwIcon aria-hidden="true" />
					</Button>
				)}
				<Button
					type="button"
					aria-label={`关闭${source.label}引用`}
					variant="ghost"
					size="icon"
					onClick={() => scope.close()}
				>
					<XIcon aria-hidden="true" />
				</Button>
			</div>
		</div>
	)
}

export function ReferenceActions({
	sources,
	inputRef,
	disabled,
}: {
	sources: readonly WorkspaceReferenceSource[]
	inputRef: RefObject<HTMLTextAreaElement | null>
	disabled: boolean
}) {
	const aui = useAui()
	const triggers = unstable_useTriggerPopoverRootContext()
	const insertTrigger = (trigger: string) => {
		const input = inputRef.current
		if (!input || disabled) return
		const text = aui.composer.getState().text
		const start = input.selectionStart
		const end = input.selectionEnd
		const before = text.slice(0, start)
		const separator = before && !/\s$/.test(before) ? ' ' : ''
		const inserted = separator + trigger
		aui.composer.setText(before + inserted + text.slice(end))
		const cursor = start + inserted.length
		// Programmatic edits do not fire Input's change/select broadcasts reliably.
		for (const { resource } of triggers.getTriggers().values()) {
			resource.setCursorPosition(cursor)
		}
		requestAnimationFrame(() => {
			if (inputRef.current !== input) return
			input.focus()
			input.setSelectionRange(cursor, cursor)
		})
	}
	return (
		<div className="agent-workspace-reference-actions flex min-w-0 flex-wrap gap-1">
			{sources.map((source) => (
				<Button
					key={source.trigger}
					aria-label={`引用${source.label}`}
					type="button"
					variant="ghost"
					size="sm"
					disabled={disabled}
					onClick={() => insertTrigger(source.trigger)}
				>
					<span aria-hidden>{source.trigger}</span>
					{source.label}
				</Button>
			))}
		</div>
	)
}
