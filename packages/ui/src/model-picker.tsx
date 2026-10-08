import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Settings2Icon } from 'lucide-react'
import type { AgentSession } from '@pluxel/browser-worker-agent'
import { isBrowserModelApi } from '@pluxel/browser-worker-agent'
import { Alert, AlertDescription } from './components/ui/alert.tsx'
import { CommandItem } from './components/ui/command.tsx'
import { ModelSelector, ModelSelectorModelContext } from './elements/model-selector.aui.tsx'

const configureKey = 'configure-provider'

export function ModelPicker({
	session,
	onOpenSettings,
	onModelChanged,
}: {
	session: AgentSession
	onOpenSettings(): void
	onModelChanged(): void
}) {
	const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot)
	const disabled = snapshot.isRunning || snapshot.isHistoryLoading
	const settings = snapshot.modelSettings
	const providers = useMemo(() => session.getModelProviders(), [session])
	const provider = providers.find((entry) => entry.id === settings.provider)
	const models = session.getModelChoices()
	const providerName =
		settings.provider === 'custom' ? '自定义供应商' : (provider?.name ?? '模型连接')
	const description = snapshot.isConfigured
		? `${providerName} · ${settings.contextWindow.toLocaleString()} token 上下文`
		: '尚未配置模型连接'
	const [open, setOpen] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const afterClose = useRef<'model' | 'settings' | null>(null)
	const choices = useMemo(
		() =>
			models.map((entry) => ({
				id: entry.id,
				name: entry.name,
				description: `${entry.id} · ${entry.contextWindow.toLocaleString()} token · ${
					entry.source === 'online'
						? '在线返回'
						: entry.source === 'catalog'
							? '参考目录'
							: '当前模型'
				}`,
			})),
		[models],
	)
	const openSettings = () => {
		afterClose.current = 'settings'
		setOpen(false)
		onOpenSettings()
	}
	const changeModel = (id: string) => {
		if (disabled) return
		setError(null)
		const choice = models.find((entry) => entry.id === id)
		if (!choice || choice.id === settings.model) return
		if (!snapshot.hasModelKey || !isBrowserModelApi(choice.api)) {
			openSettings()
			return
		}
		try {
			session.setModel({
				provider: settings.provider,
				model: choice.id,
				api: choice.api,
				apiKey: '',
				baseUrl: choice.baseUrl,
				contextWindow: choice.contextWindow,
				env: { ...settings.env },
			})
			afterClose.current = 'model'
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause))
		}
	}
	return (
		<div className="agent-workspace-model-picker min-w-0">
			<ModelSelector.Root
				models={choices}
				value={settings.model}
				onValueChange={changeModel}
				open={open}
				onOpenChange={(next) => {
					if (disabled && next) return
					setOpen(next)
				}}
			>
				<ModelSelectorModelContext />
				<ModelSelector.Trigger
					aria-label="当前模型"
					aria-description={description}
					title={description}
					disabled={disabled}
					variant="ghost"
					size="sm"
					className="max-w-full"
				>
					<ModelSelector.Value placeholder={settings.model || '选择模型'} />
				</ModelSelector.Trigger>
				<ModelSelector.Content
					searchable
					side="top"
					className="max-w-[calc(100vw-2rem)]"
					onCloseAutoFocus={(event) => {
						const target = afterClose.current
						afterClose.current = null
						if (!target) return
						event.preventDefault()
						if (target === 'model') onModelChanged()
					}}
				>
					<p className="px-3 pt-3 text-xs text-muted-foreground">{description}</p>
					<ModelSelector.Search
						aria-label="搜索当前供应商模型"
						placeholder="按名称或 ID 搜索模型"
					/>
					<ModelSelector.List aria-label="当前供应商模型">
						<ModelSelector.Empty>没有匹配的模型。</ModelSelector.Empty>
						<ModelSelector.Group>
							{choices.map((choice) => (
								<ModelSelector.Item key={choice.id} model={choice} />
							))}
						</ModelSelector.Group>
						<ModelSelector.Separator />
						<ModelSelector.Group forceMount>
							<CommandItem value={configureKey} forceMount onSelect={openSettings}>
								<Settings2Icon aria-hidden="true" />
								配置供应商
							</CommandItem>
						</ModelSelector.Group>
					</ModelSelector.List>
				</ModelSelector.Content>
			</ModelSelector.Root>
			{error && (
				<Alert variant="destructive">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			)}
		</div>
	)
}
