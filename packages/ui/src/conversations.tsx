// Adapted from assistant-ui's official thread-list registry; persistence stays host scoped.
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
	ThreadListPrimitive,
	ThreadListItemPrimitive,
	ThreadListItemMorePrimitive,
	useAuiState,
} from '@assistant-ui/react'
import {
	ArchiveIcon,
	ArchiveRestoreIcon,
	MoreHorizontalIcon,
	DownloadIcon,
	Loader2Icon,
	PencilIcon,
	PlusIcon,
	RefreshCwIcon,
	SearchIcon,
	Trash2Icon,
	XIcon,
} from 'lucide-react'
import type { AgentSession } from '@pluxel/browser-worker-agent'
import type { WorkspaceHistorySummary } from '@pluxel/browser-worker-agent'
import { useAgentWorkspace } from '@pluxel/browser-worker-agent-react'
import type { ConversationHistoryController as RuntimeHistoryController } from '@pluxel/browser-worker-agent-react'
import { Button } from './components/ui/button.tsx'
import { Input } from './components/ui/input.tsx'
import { useWorkspacePortalContainer } from './lib/portal-scope.tsx'
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from './components/ui/alert-dialog.tsx'
import { Tabs, TabsList, TabsTrigger } from './components/ui/tabs.tsx'

export type ConversationHistoryController = RuntimeHistoryController & {
	download: (id: string) => Promise<void>
}

export const ConversationList = memo(function ConversationList({
	history,
	currentId,
	disabled,
	onSelectCurrent,
}: {
	history: ConversationHistoryController
	currentId: string
	disabled: boolean
	onSelectCurrent?: () => void
}) {
	const { session, snapshot } = useAgentWorkspace()
	const [query, setQuery] = useState('')
	const [archived, setArchived] = useState(false)
	const [visibleCount, setVisibleCount] = useState(50)
	const matches = useMemo(() => {
		const search = query.trim().toLocaleLowerCase()
		return history.items.filter(
			(item) =>
				!!item.archivedAt === archived &&
				`${item.title} ${item.preview}`.toLocaleLowerCase().includes(search),
		)
	}, [history.items, archived, query])
	const byId = useMemo(
		() => new Map(matches.slice(0, visibleCount).map((item) => [item.id, item])),
		[matches, visibleCount],
	)
	return (
		<ThreadListPrimitive.Root
			data-slot="aui_thread-list-root"
			className="flex min-h-0 flex-1 flex-col gap-0.5"
			aria-label="会话历史"
		>
			<ThreadListPrimitive.New asChild disabled={history.busy || snapshot.isHistoryLoading}>
				<Button
					variant="ghost"
					data-slot="aui_thread-list-new"
					className="hover:bg-muted data-active:bg-muted h-8 justify-start gap-2 rounded-md px-2.5 text-sm font-normal"
					aria-label="新会话"
				>
					<PlusIcon data-slot="aui_thread-list-new-icon" className="size-4 shrink-0" aria-hidden />
					<span data-slot="aui_thread-list-new-label" className="whitespace-nowrap">
						新会话
					</span>
				</Button>
			</ThreadListPrimitive.New>
			<div data-slot="aui_thread-list-search" className="relative px-0.5 py-1">
				<SearchIcon
					data-slot="aui_thread-list-search-icon"
					className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
					aria-hidden
				/>
				<Input
					type="search"
					aria-label="搜索会话"
					value={query}
					onChange={(event) => {
						setQuery(event.target.value)
						setVisibleCount(50)
					}}
					placeholder="搜索名称或最近消息"
					className="h-8 ps-8 pe-8 text-sm [&::-webkit-search-cancel-button]:hidden"
				/>
				{query && (
					<Button
						variant="ghost"
						size="icon"
						className="absolute end-1.5 top-1/2 size-6 -translate-y-1/2"
						aria-label="清除会话搜索"
						onClick={() => {
							setQuery('')
							setVisibleCount(50)
						}}
					>
						<XIcon className="size-3.5" aria-hidden />
					</Button>
				)}
			</div>
			<Tabs
				value={archived ? 'archived' : 'regular'}
				onValueChange={(value) => {
					setArchived(value === 'archived')
					setVisibleCount(50)
				}}
			>
				<TabsList className="h-8 w-full" aria-label="会话分类">
					<TabsTrigger value="regular" className="flex-1">
						会话
					</TabsTrigger>
					<TabsTrigger value="archived" className="flex-1">
						已归档
					</TabsTrigger>
				</TabsList>
			</Tabs>
			<div className="flex items-center justify-between gap-2 px-2.5 py-1">
				<span className="text-muted-foreground text-xs">
					{matches.length} 个{archived ? '归档' : ''}会话
				</span>
				<Button
					variant="ghost"
					size="icon"
					className="size-6"
					aria-label="刷新会话列表"
					disabled={history.busy}
					onClick={() => void history.refresh()}
				>
					<RefreshCwIcon className="size-3.5" aria-hidden />
				</Button>
			</div>
			<div
				data-slot="aui_thread-list-items"
				className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto"
				aria-label="会话列表"
			>
				{history.loading ? (
					<p
						className="text-muted-foreground flex items-center gap-2 px-2.5 py-4 text-sm"
						role="status"
					>
						<Loader2Icon className="size-3.5 animate-spin" aria-hidden /> 正在加载会话…
					</p>
				) : (
					<ThreadListPrimitive.Items archived={archived}>
						{({ threadListItem }) => {
							const item = byId.get(threadListItem.id)
							return item ? (
								<ConversationRow
									item={item}
									current={item.id === currentId}
									disabled={disabled || history.busy}
									history={history}
									session={session}
									onSelectCurrent={onSelectCurrent}
								/>
							) : null
						}}
					</ThreadListPrimitive.Items>
				)}
				{!history.loading && matches.length === 0 && (
					<p
						data-slot="aui_thread-list-empty"
						className="text-muted-foreground px-2.5 py-4 text-sm"
					>
						{query.trim()
							? '没有匹配的会话。'
							: archived
								? '暂无归档会话。'
								: '完成一轮对话后，会话会自动保存。'}
					</p>
				)}
			</div>
			{matches.length > visibleCount && (
				<Button variant="ghost" size="sm" onClick={() => setVisibleCount(visibleCount + 50)}>
					显示更多（剩余 {matches.length - visibleCount} 个）
				</Button>
			)}
			{history.error && (
				<p className="text-destructive px-2.5 py-1 text-xs" role="alert">
					{history.error}
				</p>
			)}
		</ThreadListPrimitive.Root>
	)
})

const ConversationRow = memo(function ConversationRow({
	item,
	current,
	disabled,
	history,
	session,
	onSelectCurrent,
}: {
	item: WorkspaceHistorySummary
	current: boolean
	disabled: boolean
	history: ConversationHistoryController
	session: AgentSession
	onSelectCurrent?: () => void
}) {
	const isRunning = useAuiState((state) => state.threadListItem.isRunning)
	const [isRenaming, setIsRenaming] = useState(false)
	const triggerRef = useRef<HTMLButtonElement>(null)
	const restoreFocusRef = useRef(false)
	useEffect(() => {
		if (isRenaming || !restoreFocusRef.current) return
		restoreFocusRef.current = false
		triggerRef.current?.focus()
	}, [isRenaming])
	return (
		<ThreadListItemPrimitive.Root
			data-slot="aui_thread-list-item"
			data-current={current || undefined}
			className="group hover:bg-muted focus-visible:bg-muted data-active:bg-muted has-focus-visible:bg-muted has-data-[state=open]:bg-muted relative flex h-8 items-center rounded-md transition-colors focus-visible:outline-none"
		>
			{isRenaming ? (
				<ConversationRename
					item={item}
					history={history}
					session={session}
					disabled={disabled}
					onDone={(restoreFocus) => {
						restoreFocusRef.current = restoreFocus
						setIsRenaming(false)
					}}
				/>
			) : (
				<ThreadListItemPrimitive.Trigger asChild disabled={disabled}>
					<Button
						ref={triggerRef}
						variant="ghost"
						data-slot="aui_thread-list-item-trigger"
						aria-label={`打开会话 ${item.title}`}
						aria-current={current ? 'true' : undefined}
						onClick={current && !disabled ? onSelectCurrent : undefined}
						className="focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 items-center justify-start rounded-md px-2.5 text-start text-sm font-normal outline-none group-hover:pe-9 group-has-focus-visible:pe-9 group-has-data-[state=open]:pe-9 group-data-active:pe-9 focus-visible:ring-1"
					>
						{isRunning && (
							<Loader2Icon
								data-slot="aui_thread-list-item-running"
								className="text-muted-foreground me-1.5 size-3.5 shrink-0 animate-spin"
								aria-hidden
							/>
						)}
						<span data-slot="aui_thread-list-item-title" className="min-w-0 flex-1 truncate">
							<ThreadListItemPrimitive.Title fallback="新会话" />
						</span>
						{isRunning && <span className="sr-only">正在执行</span>}
					</Button>
				</ThreadListItemPrimitive.Trigger>
			)}
			<ConversationMore
				item={item}
				history={history}
				disabled={disabled || isRenaming}
				onRename={() => setIsRenaming(true)}
			/>
		</ThreadListItemPrimitive.Root>
	)
})

function ConversationRename({
	item,
	history,
	session,
	disabled,
	onDone,
}: {
	item: WorkspaceHistorySummary
	history: ConversationHistoryController
	session: AgentSession
	disabled: boolean
	onDone: (restoreFocus: boolean) => void
}) {
	const [value, setValue] = useState(item.title)
	const inputRef = useRef<HTMLInputElement>(null)
	const settledRef = useRef(false)
	const alive = useRef(false)
	useEffect(() => {
		alive.current = true
		inputRef.current?.select()
		return () => {
			alive.current = false
		}
	}, [])
	const commit = (restoreFocus: boolean) => {
		if (settledRef.current || disabled) return
		const next = value.trim()
		if (!next || next === item.title) {
			settledRef.current = true
			onDone(restoreFocus)
			return
		}
		settledRef.current = true
		void history
			.perform(() => session.renameHistory(item.id, next))
			.then((ok) => {
				if (!alive.current) return undefined
				if (ok) onDone(restoreFocus)
				else {
					settledRef.current = false
					requestAnimationFrame(() => {
						if (alive.current) inputRef.current?.focus()
					})
				}
				return undefined
			})
	}
	return (
		<Input
			ref={inputRef}
			autoFocus
			data-slot="aui_thread-list-item-rename"
			aria-label="会话名称"
			title="重命名会话"
			aria-invalid={!!history.error || undefined}
			value={value}
			maxLength={80}
			disabled={disabled}
			className="h-7 min-w-0 flex-1 ps-2.5 pe-9 text-sm"
			onChange={(event) => setValue(event.target.value)}
			onBlur={() => commit(false)}
			onKeyDown={(event) => {
				if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
				if (event.key === 'Enter') {
					event.preventDefault()
					commit(true)
				} else if (event.key === 'Escape' && !settledRef.current) {
					event.preventDefault()
					settledRef.current = true
					onDone(true)
				}
			}}
		/>
	)
}

const menuItemClass =
	'hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none'

function ConversationMore({
	item,
	history,
	disabled,
	onRename,
}: {
	item: WorkspaceHistorySummary
	history: ConversationHistoryController
	disabled: boolean
	onRename: () => void
}) {
	const portalContainer = useWorkspacePortalContainer()
	const Archive = item.archivedAt
		? ThreadListItemPrimitive.Unarchive
		: ThreadListItemPrimitive.Archive
	return (
		<ThreadListItemMorePrimitive.Root sharedFocusGroup>
			<ThreadListItemMorePrimitive.Trigger asChild disabled={disabled}>
				<Button
					variant="ghost"
					size="icon"
					data-slot="aui_thread-list-item-more"
					aria-label={`${item.title}的更多操作`}
					className="data-[state=open]:bg-accent absolute end-1.5 top-1/2 size-6 -translate-y-1/2 p-0 opacity-0 group-hover:opacity-100 group-has-focus-visible:opacity-100 group-data-active:opacity-100 data-[state=open]:opacity-100"
				>
					<MoreHorizontalIcon className="size-3.5" aria-hidden />
				</Button>
			</ThreadListItemMorePrimitive.Trigger>
			<ThreadListItemMorePrimitive.Content
				portalProps={{ container: portalContainer }}
				side="right"
				align="start"
				sideOffset={6}
				aria-label="会话操作"
				data-slot="aui_thread-list-item-more-content"
				className="aui-root bg-popover text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-32 overflow-hidden rounded-xl border p-1.5"
			>
				<ThreadListItemMorePrimitive.Item
					data-slot="aui_thread-list-item-more-item"
					className={menuItemClass}
					disabled={disabled}
					onSelect={() => {
						if (!disabled) onRename()
					}}
				>
					<PencilIcon className="size-4" aria-hidden /> 重命名
				</ThreadListItemMorePrimitive.Item>
				<Archive asChild disabled={disabled}>
					<ThreadListItemMorePrimitive.Item
						data-slot="aui_thread-list-item-more-item"
						className={menuItemClass}
						disabled={disabled}
					>
						{item.archivedAt ? (
							<ArchiveRestoreIcon className="size-4" aria-hidden />
						) : (
							<ArchiveIcon className="size-4" aria-hidden />
						)}
						{item.archivedAt ? '取消归档' : '归档'}
					</ThreadListItemMorePrimitive.Item>
				</Archive>
				<ThreadListItemMorePrimitive.Item
					data-slot="aui_thread-list-item-more-item"
					className={menuItemClass}
					disabled={disabled}
					onSelect={() => {
						if (!disabled) void history.download(item.id)
					}}
				>
					<DownloadIcon className="size-4" aria-hidden /> 导出 JSON
				</ThreadListItemMorePrimitive.Item>
				<ThreadListItemMorePrimitive.Item
					data-slot="aui_thread-list-item-more-item"
					className="text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive data-[disabled]:pointer-events-none data-[disabled]:opacity-50 flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
					disabled={disabled}
					onSelect={() => {
						if (!disabled) history.setIntent({ kind: 'delete', item })
					}}
				>
					<Trash2Icon className="size-4" aria-hidden /> 删除
				</ThreadListItemMorePrimitive.Item>
			</ThreadListItemMorePrimitive.Content>
		</ThreadListItemMorePrimitive.Root>
	)
}

export function ConversationDialogs({
	history,
	session,
	onCompleted,
}: {
	history: ConversationHistoryController
	session: AgentSession
	onCompleted: () => void
}) {
	const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot)
	const intent = history.intent
	const discardUnsaved = snapshot.historySaveState === 'error'
	return (
		<AlertDialog
			open={intent?.kind === 'delete' || intent?.kind === 'new'}
			onOpenChange={(open) => {
				if (!open && !history.busy) history.setIntent(null)
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						{intent?.kind === 'new'
							? discardUnsaved
								? '放弃本地保存并新建？'
								: '停止并新建会话？'
							: '删除会话？'}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{intent?.kind === 'new'
							? discardUnsaved
								? '此会话有未能保存到浏览器的记录。新建后会丢弃这份内存记录；请先重试保存或从会话信息导出备份。已存历史和业务回执不受影响。'
								: '将停止当前执行并打开新会话。已经派发的业务写入仍可能完成，请核对业务回执。'
							: intent?.kind === 'delete'
								? `将从此浏览器删除“${intent.item.title}”的消息和执行记录。业务数据与回执不会被删除。`
								: ''}
					</AlertDialogDescription>
				</AlertDialogHeader>
				{history.error && (
					<p className="text-destructive text-sm" role="alert">
						{history.error}
					</p>
				)}
				<AlertDialogFooter>
					<AlertDialogCancel disabled={history.busy}>取消</AlertDialogCancel>
					<Button
						variant={intent?.kind === 'delete' ? 'destructive' : 'default'}
						disabled={history.busy}
						onClick={() =>
							void (async () => {
								if (!intent || history.busy) return
								const ok = await history.perform(async () => {
									if (intent.kind === 'delete') {
										await session.deleteHistory(intent.item.id)
										history.deleteDraft(intent.item.id)
									} else if (intent.kind === 'new')
										await session.newConversation({ discardUnsaved })
								})
								if (ok) {
									history.setIntent(null)
									onCompleted()
								}
							})()
						}
					>
						{history.busy && <Loader2Icon className="size-4 animate-spin" aria-hidden />}
						{intent?.kind === 'new'
							? discardUnsaved
								? '放弃并新建'
								: '停止并新建'
							: '删除本地会话'}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
