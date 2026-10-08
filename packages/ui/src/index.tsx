import {
	useState,
	useContext,
	useSyncExternalStore,
	useEffect,
	useMemo,
	useRef,
	useCallback,
	type ReactNode,
} from 'react'
import {
	ThreadPrimitive,
	ComposerPrimitive,
	MessagePrimitive,
	ActionBarPrimitive,
	useAuiState,
	type ToolCallMessagePartProps,
	type TextMessagePartProps,
} from '@assistant-ui/react'
import {
	ArrowDownIcon,
	ArrowUpIcon,
	BookOpenIcon,
	CodeIcon,
	PanelLeftIcon,
	InfoIcon,
	Loader2Icon,
	SearchIcon,
	Settings2Icon,
	SquareIcon,
} from 'lucide-react'
import type { AgentSession, AgentSessionSnapshot } from '@pluxel/browser-worker-agent'
import { AgentWorkspaceProvider, useAgentWorkspace } from '@pluxel/browser-worker-agent-react'
import { CodeBlockCopyButton } from 'streamdown'
import { MarkdownText, CodeBlock } from './markdown.tsx'
import {
	Thread,
	Composer,
	UserMessage as UserMessageRow,
	composerInputClass,
} from './elements/thread.tsx'
import { ToolGroupRoot, ToolGroupTrigger, ToolGroupContent } from './elements/tool-group.tsx'
import {
	ReasoningRoot,
	ReasoningTrigger,
	ReasoningContent,
	ReasoningText,
} from './elements/reasoning.aui.tsx'
import { ModelSettingsForm } from './model-settings.tsx'
import { ModelPicker } from './model-picker.tsx'
import { ConversationList, ConversationDialogs } from './conversations.tsx'
import { ReferenceActions, ReferencePopover, type WorkspaceReferenceSource } from './references.tsx'
import { Button } from './components/ui/button.tsx'
import { Alert, AlertDescription } from './components/ui/alert.tsx'
import { Progress } from './components/ui/progress.tsx'
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from './components/ui/dialog.tsx'
import {
	Sheet,
	SheetTrigger,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetDescription,
} from './components/ui/sheet.tsx'
import { Popover, PopoverTrigger, PopoverContent } from './components/ui/popover.tsx'
import { WorkspaceUIScope } from './lib/portal-scope.tsx'
import { cn } from './lib/utils.ts'
import {
	WorkspaceComponentsContext,
	type AgentWorkspaceComponents,
	type AgentWorkspaceTheme,
	type AgentWorkspaceWelcomeProps,
} from './customization.tsx'
export type {
	AgentWorkspaceComponents,
	AgentWorkspaceTheme,
	AgentWorkspaceWelcomeProps,
} from './customization.tsx'
import './styles.css'
export type { WorkspaceReferenceItem, WorkspaceReferenceSource } from './references.tsx'

const defaultComponents: AgentWorkspaceComponents = {}
const noReferenceSources: readonly WorkspaceReferenceSource[] = []
export type AgentWorkspaceProps = {
	session: AgentSession
	referenceSources?: readonly WorkspaceReferenceSource[]
	components?: AgentWorkspaceComponents
	theme?: AgentWorkspaceTheme
	/** Layout classes on the workspace surface; use theme for portal-safe colors. */
	className?: string
}

export function AgentWorkspace({
	session,
	referenceSources = noReferenceSources,
	components = defaultComponents,
	theme,
	className,
}: AgentWorkspaceProps) {
	return (
		<AgentWorkspaceProvider session={session}>
			<WorkspaceComponentsContext.Provider value={components}>
				<WorkspaceUIScope theme={theme}>
					<SessionWorkspace referenceSources={referenceSources} className={className} />
				</WorkspaceUIScope>
			</WorkspaceComponentsContext.Provider>
		</AgentWorkspaceProvider>
	)
}

function useHistoryDownload(
	session: AgentSession,
	perform: (action: () => Promise<void>) => Promise<boolean>,
) {
	const live = useRef(false)
	useEffect(() => {
		live.current = true
		return () => {
			live.current = false
		}
	}, [])
	return useCallback(
		async (id: string) => {
			await perform(async () => {
				const json = await session.exportHistory(id)
				if (!live.current) return
				const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
				const link = document.createElement('a')
				link.href = url
				link.download = `agent-conversation-${id}.json`
				link.click()
				setTimeout(() => URL.revokeObjectURL(url), 1000)
			})
		},
		[perform, session],
	)
}

function SessionWorkspace({
	referenceSources = noReferenceSources,
	className,
}: Pick<AgentWorkspaceProps, 'referenceSources' | 'className'>) {
	const { Welcome = EmptyWorkspace } = useContext(WorkspaceComponentsContext)
	const { session, snapshot, messages, history: runtimeHistory } = useAgentWorkspace()
	const latestMessage = messages.at(-1)
	const errorShownInMessage =
		latestMessage?.role === 'assistant' &&
		latestMessage.status?.type === 'incomplete' &&
		latestMessage.status.reason === 'error' &&
		String(latestMessage.status.error ?? '本轮处理失败。') === snapshot.error
	const download = useHistoryDownload(session, runtimeHistory.perform)
	const history = useMemo(() => ({ ...runtimeHistory, download }), [runtimeHistory, download])
	const [drawerSelection, setDrawerSelection] = useState<{
		id: string
		navigationVersion: number
	} | null>(null)
	const drawerOpen =
		drawerSelection?.id === snapshot.id &&
		drawerSelection.navigationVersion === history.navigationVersion
	const setDrawerOpen = (open: boolean) =>
		setDrawerSelection(
			open ? { id: snapshot.id, navigationVersion: history.navigationVersion } : null,
		)
	const [settingsOpen, setSettingsOpen] = useState(false)
	const [sidebarOpen, setSidebarOpen] = useState(true)
	const wide = useWideWorkspace()
	const inputRef = useRef<HTMLTextAreaElement>(null)
	const focusComposer = () =>
		requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
	return (
		<section
			className={cn(
				'agent-workspace aui-root flex h-full min-h-0 w-full min-w-0 flex-1',
				className,
			)}
			aria-label="Agent 工作区"
		>
			{wide && sidebarOpen && (
				<aside className="agent-workspace-sidebar border-border flex min-h-0 w-56 shrink-0 flex-col border-r p-3">
					<ConversationList
						history={history}
						currentId={snapshot.id}
						disabled={snapshot.isRunning || snapshot.isHistoryLoading}
					/>
				</aside>
			)}
			<div className="agent-workspace-conversation flex min-h-0 min-w-0 flex-1 flex-col">
				<header
					className="agent-workspace-toolbar @container/agent-toolbar shrink-0 px-2 py-1"
					aria-label="会话操作"
				>
					<div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 @min-[30rem]/agent-toolbar:grid-cols-[auto_minmax(0,1fr)_minmax(12rem,18rem)_auto]">
						{wide ? (
							<Button
								aria-label="历史"
								aria-expanded={sidebarOpen}
								variant="ghost"
								size="icon"
								className="size-8"
								onClick={() => setSidebarOpen(!sidebarOpen)}
							>
								<PanelLeftIcon size={17} aria-hidden />
							</Button>
						) : (
							<Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
								<SheetTrigger asChild>
									<Button aria-label="历史" variant="ghost" size="icon" className="size-8">
										<PanelLeftIcon size={17} aria-hidden />
									</Button>
								</SheetTrigger>
								<SheetContent
									side="left"
									className="agent-workspace-history-drawer flex min-h-0 w-[min(20rem,calc(100vw-1.5rem))] flex-col gap-3 p-3"
									closeLabel="关闭会话历史"
								>
									<SheetHeader className="pr-8 text-left">
										<SheetTitle className="text-sm">会话历史</SheetTitle>
										<SheetDescription className="sr-only">
											搜索、切换和管理保存在此浏览器的会话。
										</SheetDescription>
									</SheetHeader>
									<ConversationList
										history={history}
										currentId={snapshot.id}
										disabled={snapshot.isRunning || snapshot.isHistoryLoading}
										onSelectCurrent={() => setDrawerOpen(false)}
									/>
								</SheetContent>
							</Sheet>
						)}
						<div className="agent-workspace-current-title flex min-w-0 items-center gap-2">
							<h2 className="min-w-0 truncate text-sm font-medium" title={snapshot.title}>
								{snapshot.title}
							</h2>
							{(snapshot.isRunning ||
								snapshot.isHistoryLoading ||
								snapshot.stopped ||
								snapshot.archivedAt ||
								shortSaveStateLabels[snapshot.historySaveState]) && (
								<span
									className="text-muted-foreground shrink-0 text-[11px]"
									title={saveStateLabels[snapshot.historySaveState]}
								>
									{snapshot.isRunning
										? '处理中'
										: snapshot.isHistoryLoading
											? '加载中'
											: snapshot.stopped
												? '已停止'
												: snapshot.archivedAt
													? '已归档'
													: shortSaveStateLabels[snapshot.historySaveState]}
								</span>
							)}
						</div>
						<div className="col-span-full row-start-2 @min-[30rem]/agent-toolbar:col-span-1 @min-[30rem]/agent-toolbar:col-start-3 @min-[30rem]/agent-toolbar:row-start-1">
							<ContextUsage snapshot={snapshot} />
						</div>
						<div className="col-start-3 row-start-1 @min-[30rem]/agent-toolbar:col-start-4">
							<ConversationInfo
								session={session}
								onExport={() => void history.download(snapshot.id)}
							/>
						</div>
					</div>
				</header>
				<ConversationDialogs
					history={history}
					session={session}
					onCompleted={() => setDrawerOpen(false)}
				/>
				<WorkspaceDialog
					open={settingsOpen}
					onOpenChange={setSettingsOpen}
					title="模型设置"
					description="选择已有供应商，或连接自己的模型服务。"
				>
					<ModelSettingsForm
						session={session}
						disabled={snapshot.isRunning || snapshot.isHistoryLoading}
						onSaved={() => {
							setSettingsOpen(false)
							focusComposer()
						}}
						onCancel={() => setSettingsOpen(false)}
					/>
				</WorkspaceDialog>
				<div className="agent-workspace-notices grid max-h-[30dvh] shrink-0 gap-2 overflow-y-auto empty:hidden">
					{snapshot.modelStorageError && (
						<WorkspaceNotice status="warning">{snapshot.modelStorageError}</WorkspaceNotice>
					)}
					{snapshot.historyError && (
						<WorkspaceNotice status="danger">历史存储失败：{snapshot.historyError}</WorkspaceNotice>
					)}
					{history.error && !drawerOpen && (!wide || !sidebarOpen) && (
						<WorkspaceNotice status="danger">{history.error}</WorkspaceNotice>
					)}
					{snapshot.error && !errorShownInMessage && (
						<WorkspaceNotice status="danger">{snapshot.error}</WorkspaceNotice>
					)}
					{snapshot.contextWarning && (
						<WorkspaceNotice status="warning">会话接近模型上下文上限，请新建会话。</WorkspaceNotice>
					)}
					{snapshot.stopped && (
						<WorkspaceNotice status="warning">
							已停止当前执行。已发送的业务写入仍可能完成，请查看待确认操作。
						</WorkspaceNotice>
					)}
				</div>
				<Thread
					empty={messages.length === 0}
					welcome={
						<Welcome configured={snapshot.isConfigured} onConfigure={() => setSettingsOpen(true)} />
					}
					components={threadMessages}
					composer={
						<>
							<ThreadPrimitive.ScrollToBottom asChild>
								<Button
									variant="outline"
									aria-label="回到底部"
									size="icon"
									className="agent-workspace-scroll-bottom absolute -top-10 left-1/2 size-8 -translate-x-1/2 rounded-full disabled:hidden"
								>
									<ArrowDownIcon size={17} aria-hidden />
								</Button>
							</ThreadPrimitive.ScrollToBottom>
							<ComposerPrimitive.Unstable_TriggerPopoverRoot>
								<Composer>
									{referenceSources.map((source) => (
										<ReferencePopover key={source.trigger} source={source} inputRef={inputRef} />
									))}
									<ComposerPrimitive.Input
										ref={inputRef}
										aria-label="消息"
										placeholder={
											snapshot.isConfigured
												? '描述任务，或继续提问…'
												: '在下方连接模型，开始你的任务…'
										}
										className={composerInputClass}
										unstable_insertNewlineOnTouchEnter
									/>
									<div className="agent-workspace-composer-footer flex items-end justify-between gap-2">
										<div className="agent-workspace-composer-controls flex min-w-0 flex-1 flex-wrap items-center gap-1">
											<ModelPicker
												session={session}
												onOpenSettings={() => setSettingsOpen(true)}
												onModelChanged={focusComposer}
											/>
											<Button
												type="button"
												aria-label="模型设置"
												title="模型连接设置"
												variant="ghost"
												size="icon"
												className="size-8 shrink-0"
												disabled={snapshot.isRunning || snapshot.isHistoryLoading}
												onClick={() => setSettingsOpen(true)}
											>
												<Settings2Icon size={17} aria-hidden />
											</Button>
											{referenceSources.length > 0 && (
												<ReferenceActions
													sources={referenceSources}
													inputRef={inputRef}
													disabled={snapshot.isRunning || snapshot.isHistoryLoading || history.busy}
												/>
											)}
										</div>
										{snapshot.isRunning ? (
											<ComposerPrimitive.Cancel asChild>
												<Button
													aria-label="停止"
													title="停止"
													variant="destructive"
													size="icon"
													className="size-11 shrink-0"
												>
													<SquareIcon size={16} aria-hidden />
												</Button>
											</ComposerPrimitive.Cancel>
										) : (
											<ComposerPrimitive.Send asChild>
												<Button
													aria-label="发送"
													title="发送"
													size="icon"
													className="size-11 shrink-0"
												>
													<ArrowUpIcon size={19} aria-hidden />
												</Button>
											</ComposerPrimitive.Send>
										)}
									</div>
								</Composer>
							</ComposerPrimitive.Unstable_TriggerPopoverRoot>
						</>
					}
				/>
				{snapshot.executions.length > 0 && (
					<ToolGroupRoot
						variant="ghost"
						className="agent-workspace-executions max-h-[25dvh] shrink-0 overflow-y-auto px-4"
					>
						<ToolGroupTrigger
							count={snapshot.executions.length}
							label={`执行记录（${snapshot.executions.length}）`}
						/>
						<ToolGroupContent>
							{snapshot.executions.map((record) => (
								<ToolGroupRoot key={record.id} variant="ghost">
									<ToolGroupTrigger count={1} label={executionStatus(record.status)} />
									<ToolGroupContent>
										<CodeBlock code={record.code} />
										{record.outputs.length > 0 && (
											<CodeBlock code={record.outputs.join('\n')} language="text" />
										)}
										{record.value !== undefined && (
											<CodeBlock code={JSON.stringify(record.value, null, 2)} language="json" />
										)}
										{record.error && (
											<WorkspaceNotice status="danger">{record.error}</WorkspaceNotice>
										)}
										{record.truncated && (
											<p className="text-muted-foreground text-xs">
												输出已达到大小限制，部分内容已截断。
											</p>
										)}
									</ToolGroupContent>
								</ToolGroupRoot>
							))}
						</ToolGroupContent>
					</ToolGroupRoot>
				)}
			</div>
		</section>
	)
}

const saveStateLabels = {
	empty: '尚未保存',
	saving: '正在保存到此浏览器…',
	saved: '已保存到此浏览器',
	error: '未能保存到此浏览器',
}
const shortSaveStateLabels = { empty: '', saving: '保存中', saved: '已保存', error: '保存失败' }
const wideQuery = '(min-width: 1100px)'
const subscribeWide = (listener: () => void) => {
	const query = window.matchMedia(wideQuery)
	query.addEventListener('change', listener)
	return () => query.removeEventListener('change', listener)
}
function useWideWorkspace() {
	return useSyncExternalStore(
		subscribeWide,
		() => window.matchMedia(wideQuery).matches,
		() => false,
	)
}

function ContextUsage({ snapshot }: { snapshot: AgentSessionSnapshot }) {
	const { estimatedTokens, contextWindow } = snapshot.contextUsage
	const percent =
		contextWindow > 0 ? Math.min(100, Math.round((estimatedTokens / contextWindow) * 100)) : 0
	return (
		<div className="agent-workspace-context-usage min-w-0 space-y-1">
			<div className="text-muted-foreground flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-xs">
				<span>
					上下文估算{' '}
					<span className={snapshot.contextWarning ? 'text-destructive' : ''}>{percent}%</span>
				</span>
				<span className="tabular-nums">
					约 {estimatedTokens.toLocaleString()} / {contextWindow.toLocaleString()} token
				</span>
			</div>
			<Progress
				value={percent}
				aria-label="上下文估算"
				aria-valuetext={`约 ${estimatedTokens.toLocaleString()} / ${contextWindow.toLocaleString()} token，${percent}%`}
				className="h-1"
			/>
		</div>
	)
}

function ConversationInfo({ session, onExport }: { session: AgentSession; onExport(): void }) {
	const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot)
	const turns = snapshot.messages.filter((message) => message.role === 'user').length
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button aria-label="会话信息" variant="ghost" size="icon" className="size-8">
					<InfoIcon size={17} aria-hidden />
				</Button>
			</PopoverTrigger>
			<PopoverContent
				className="agent-workspace-info-popover w-[min(22rem,calc(100vw-1.5rem))] space-y-3 wrap-anywhere"
				align="end"
				aria-label="会话信息"
			>
				<h3 className="text-sm font-medium">会话信息</h3>
				<p className="text-muted-foreground text-sm">
					{turns} 轮对话 · {snapshot.executions.length} 次代码执行
				</p>
				<p className="text-muted-foreground text-sm">
					{saveStateLabels[snapshot.historySaveState]}
					{snapshot.historySavedAt && (
						<>
							{' '}
							· 已保存记录更新于{' '}
							<time dateTime={new Date(snapshot.historySavedAt).toISOString()}>
								{new Date(snapshot.historySavedAt).toLocaleString()}
							</time>
						</>
					)}
				</p>
				<p className="text-muted-foreground text-sm">
					{!snapshot.isConfigured
						? '尚未配置模型连接。'
						: snapshot.modelStorageError
							? '模型连接未能保存，仅在当前工作区内存中可用。'
							: snapshot.remembersModelConnection
								? '模型连接由宿主单独保存，不随会话历史导出。'
								: '模型连接仅在当前工作区内存中可用。'}
				</p>
				<p className="text-muted-foreground text-sm">
					历史按当前工作区范围隔离，暂不支持跨设备同步。清理站点数据会移除记录，可从会话菜单导出备份。未发送草稿仅在当前工作区内存中保留。
				</p>
				<div className="flex flex-wrap gap-2">
					{snapshot.historySaveState === 'error' && (
						<Button
							variant="secondary"
							size="sm"
							disabled={snapshot.isRunning || snapshot.isHistoryLoading}
							onClick={() => void session.retrySaveHistory().catch(() => {})}
						>
							重试保存
						</Button>
					)}
					<Button
						variant="secondary"
						size="sm"
						disabled={turns === 0 || snapshot.isRunning || snapshot.isHistoryLoading}
						onClick={onExport}
					>
						导出当前会话
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	)
}

function WorkspaceDialog({
	open,
	onOpenChange,
	title,
	description,
	children,
}: {
	open: boolean
	onOpenChange(open: boolean): void
	title: string
	description: string
	children: ReactNode
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				aria-label={title}
				closeLabel={`关闭${title}`}
				className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto"
			>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				{open && children}
			</DialogContent>
		</Dialog>
	)
}
function WorkspaceNotice({
	children,
	status,
}: {
	children: ReactNode
	status: 'danger' | 'warning'
}) {
	return (
		<Alert
			variant={status === 'danger' ? 'destructive' : 'default'}
			role={status === 'danger' ? 'alert' : 'status'}
			className="wrap-anywhere"
		>
			<AlertDescription>{children}</AlertDescription>
		</Alert>
	)
}
function EmptyWorkspace({ configured, onConfigure }: AgentWorkspaceWelcomeProps) {
	return (
		<div className="aui-thread-welcome-root mb-6 flex flex-col gap-3 p-2">
			<h3 className="text-xl font-semibold">从一个任务开始</h3>
			<p className="text-muted-foreground text-sm">
				{configured
					? '读取 API 文档，查询数据，让助手协助你完成配置。'
					: '选择模型后，描述你想查询或修改的内容。'}
			</p>
			{!configured && (
				<Button onClick={onConfigure} className="self-start">
					配置模型连接
				</Button>
			)}
			<div className="aui-thread-welcome-suggestions grid grid-cols-1 gap-3 sm:grid-cols-2">
				<ThreadPrimitive.Suggestion
					prompt="先阅读 API 文档，告诉我有哪些可用的查询与配置操作。"
					send={false}
					asChild
				>
					<Button
						variant="outline"
						className="h-auto justify-start whitespace-normal py-3 text-left"
					>
						<BookOpenIcon size={20} className="shrink-0" aria-hidden />
						<span className="grid">
							<span>了解可用操作</span>
							<span className="text-muted-foreground text-xs">先阅读文档，再制定步骤</span>
						</span>
					</Button>
				</ThreadPrimitive.Suggestion>
				<ThreadPrimitive.Suggestion
					prompt="阅读文档并查询可用数据，解释结果中的关键字段。"
					send={false}
					asChild
				>
					<Button
						variant="outline"
						className="h-auto justify-start whitespace-normal py-3 text-left"
					>
						<SearchIcon size={20} className="shrink-0" aria-hidden />
						<span className="grid">
							<span>查询与检查</span>
							<span className="text-muted-foreground text-xs">查看当前数据，解释查询结果</span>
						</span>
					</Button>
				</ThreadPrimitive.Suggestion>
			</div>
		</div>
	)
}

function UserMessage() {
	return (
		<UserMessageRow>
			<MessagePrimitive.Parts components={{ Text: UserText }} />
		</UserMessageRow>
	)
}
function UserText({ text }: TextMessagePartProps) {
	return <div className="agent-workspace-text">{text}</div>
}
const threadMessages = { UserMessage, AssistantMessage }
function AssistantMessage() {
	const { Text = MarkdownText, Tool = ToolResult } = useContext(WorkspaceComponentsContext)
	const message = useAuiState((state) => state.message)
	const parts = message.parts
	const answerIndices = ((message.metadata.custom.answerPartIndices ?? []) as number[]).filter(
		(index) => parts[index]?.type === 'text',
	)
	const groupBy = useMemo(() => {
		// Classify registered parts, preserving native ordering and pi's final-step boundary.
		const answers = new WeakSet<(typeof parts)[number]>(
			((message.metadata.custom.answerPartIndices ?? []) as number[]).flatMap((index) => {
				const part = parts[index]
				return part?.type === 'text' ? [part] : []
			}),
		)
		return (part: (typeof parts)[number]) =>
			answers.has(part)
				? []
				: part.type === 'reasoning'
					? (['group-process', 'group-reasoning'] as const)
					: (['group-process'] as const)
	}, [parts, message.metadata.custom.answerPartIndices])
	const running = message.status?.type === 'running'
	const incomplete = message.status?.type === 'incomplete' ? message.status : null
	const toolCount = parts.filter((part) => part.type === 'tool-call').length
	const failedTools = parts.filter((part) => part.type === 'tool-call' && part.isError).length
	const answerText = answerIndices
		.flatMap((index) => {
			const part = parts[index]
			return part?.type === 'text' ? [part.text] : []
		})
		.join('\n')
	return (
		<MessagePrimitive.Root className="agent-workspace-message agent-workspace-assistant">
			<MessagePrimitive.GroupedParts groupBy={groupBy} indicator="always">
				{({ part, children }) => {
					switch (part.type) {
						case 'group-process':
							return (
								<ToolGroupRoot
									key={running ? 'running' : 'settled'}
									defaultOpen={running}
									variant="ghost"
									className="agent-workspace-process"
								>
									<ToolGroupTrigger
										count={toolCount}
										active={running}
										label={
											<>
												{running ? '正在处理' : '查看处理过程'}
												{toolCount > 0 && ` · ${toolCount} 次工具调用`}
												{failedTools > 0 && ` · ${failedTools} 次工具失败`}
											</>
										}
									/>
									<ToolGroupContent>{children}</ToolGroupContent>
								</ToolGroupRoot>
							)
						case 'group-reasoning':
							return (
								<ReasoningRoot
									streaming={part.status.type === 'running'}
									variant="ghost"
									className="agent-workspace-reasoning"
								>
									<ReasoningTrigger active={part.status.type === 'running'} label="思考过程" />
									<ReasoningContent aria-busy={part.status.type === 'running'}>
										<ReasoningText>{children}</ReasoningText>
									</ReasoningContent>
								</ReasoningRoot>
							)
						case 'text':
						case 'reasoning':
							return <Text />
						case 'tool-call':
							return part.toolUI ?? <Tool {...part} />
						case 'indicator':
							return (
								<p
									className="text-muted-foreground mt-3 flex items-center gap-2 text-sm"
									role="status"
								>
									<Loader2Icon
										className="size-4 animate-spin motion-reduce:animate-none"
										aria-hidden
									/>
									正在生成…
								</p>
							)
						default:
							return null
					}
				}}
			</MessagePrimitive.GroupedParts>
			{incomplete && (
				<WorkspaceNotice status={incomplete.reason === 'error' ? 'danger' : 'warning'}>
					{incomplete.reason === 'cancelled'
						? '本轮已停止，尚未完成。'
						: incomplete.reason === 'length'
							? '回复已达到模型输出上限，内容可能不完整。'
							: incomplete.reason === 'error'
								? String(incomplete.error ?? '本轮处理失败。')
								: '工具步骤已结束，尚未生成最终回复。'}
				</WorkspaceNotice>
			)}
			{answerText.trim() && (
				<ActionBarPrimitive.Root hideWhenRunning className="agent-workspace-message-actions">
					<CopyAnswer text={answerText} />
				</ActionBarPrimitive.Root>
			)}
		</MessagePrimitive.Root>
	)
}

function CopyAnswer({ text }: { text: string }) {
	const [error, setError] = useState(false)
	return (
		<>
			<CodeBlockCopyButton
				code={text}
				aria-label="复制消息"
				title="复制消息"
				className="inline-flex size-8 items-center justify-center rounded-md"
				onCopy={() => setError(false)}
				onError={() => setError(true)}
			/>
			{error && (
				<p className="text-muted-foreground text-xs" role="status">
					复制失败，请手动选择回复。
				</p>
			)}
		</>
	)
}

function ToolResult({ toolName, args, result, isError, status }: ToolCallMessagePartProps) {
	const isCode = toolName === 'runJavaScript'
	const running = result === undefined && status.type === 'running'
	const code = isCode && typeof args?.code === 'string' ? args.code : null
	const title = isCode ? '执行 JavaScript' : toolName === 'searchDocs' ? '搜索文档' : '读取文档'
	const detail = isCode
		? code
			? `${code.split('\n').length} 行代码`
			: '准备代码'
		: typeof args?.query === 'string'
			? args.query
			: typeof args?.id === 'string'
				? args.id
				: ''
	const Icon = isCode ? CodeIcon : toolName === 'searchDocs' ? SearchIcon : BookOpenIcon
	return (
		<ToolGroupRoot
			variant="ghost"
			className="agent-workspace-tool"
			data-error={isError || undefined}
		>
			<ToolGroupTrigger
				count={1}
				active={running}
				label={
					<span className="agent-workspace-tool-copy">
						<Icon size={16} aria-hidden />
						<span>{title}</span>
						<span className="text-muted-foreground min-w-0 truncate">{detail}</span>
						{(isError || (!running && result === undefined)) && (
							<span className="text-destructive shrink-0 text-xs">
								{isError ? '失败' : '未完成'}
							</span>
						)}
					</span>
				}
			/>
			<ToolGroupContent>
				<CodeBlock
					code={code ?? JSON.stringify(args, null, 2)}
					language={code ? 'javascript' : 'json'}
				/>
				{result !== undefined && (
					<>
						<p className="text-muted-foreground text-sm">返回结果</p>
						<CodeBlock
							code={typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
							language={typeof result === 'string' ? 'text' : 'json'}
						/>
					</>
				)}
			</ToolGroupContent>
		</ToolGroupRoot>
	)
}
function executionStatus(status: string): string {
	return (
		(
			{
				completed: '执行完成',
				stopped: '已停止',
				timeout: '已超时',
				syntax_error: '语法错误',
				rpc_error: 'RPC 调用失败',
				execution_error: '执行失败',
			} as Record<string, string>
		)[status] ?? status
	)
}
