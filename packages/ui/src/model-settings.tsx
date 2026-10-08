import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { Collapsible as CollapsiblePrimitive } from 'radix-ui'
import { ChevronDownIcon } from 'lucide-react'
import type { AgentSession } from '@pluxel/browser-worker-agent'
import {
	CUSTOM_MODEL_APIS,
	getModelConfigFields,
	type BrowserModelApi,
} from '@pluxel/browser-worker-agent'
import { supportsModelDiscovery, type DiscoveredModel } from '@pluxel/browser-worker-agent'
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert.tsx'
import { Button } from './components/ui/button.tsx'
import { Input } from './components/ui/input.tsx'
import { Label } from './components/ui/label.tsx'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from './components/ui/select.tsx'
import { Separator } from './components/ui/separator.tsx'
import {
	ModelSelectorRoot,
	ModelSelectorTrigger,
	ModelSelectorValue,
	ModelSelectorContent,
	ModelSelectorSearch,
	ModelSelectorList,
	ModelSelectorEmpty,
	ModelSelectorGroup,
	ModelSelectorItem,
} from './elements/model-selector.tsx'

type CatalogItem = { id: string; name: string; description: string }

/** The host owns the session and the surrounding dialog. Draft keys live only in this form. */
export function ModelSettingsForm({
	session,
	disabled,
	onSaved,
	onCancel,
}: {
	session: AgentSession
	disabled: boolean
	onSaved(): void
	onCancel(): void
}) {
	const snapshot = session.getSnapshot()
	const protocolId = useId()
	const settings = snapshot.modelSettings
	const providers = useMemo(() => session.getModelProviders(), [session])
	const initialModel = providers
		.find((entry) => entry.id === settings.provider)
		?.models.find((entry) => entry.id === settings.model)
	const [provider, setProvider] = useState(settings.provider)
	const [api, setApi] = useState(settings.api)
	const [baseUrl, setBaseUrl] = useState(settings.baseUrl)
	const [model, setModel] = useState(settings.model)
	const [apiKey, setApiKey] = useState('')
	const [contextWindow, setContextWindow] = useState(
		settings.provider === 'custom' || settings.contextWindow !== initialModel?.contextWindow
			? String(settings.contextWindow)
			: '',
	)
	const [env, setEnv] = useState({ ...settings.env })
	const [advancedOpen, setAdvancedOpen] = useState(
		!!settings.baseUrl || (!!initialModel && settings.contextWindow !== initialModel.contextWindow),
	)
	const [discoveryResult, setDiscoveryResult] = useState<{
		scope: string
		models: readonly DiscoveredModel[]
	} | null>(null)
	const [loadingScope, setLoadingScope] = useState<string | null>(null)
	const [discoveryFailure, setDiscoveryFailure] = useState<{
		scope: string
		message: string
	} | null>(null)
	const [manualModel, setManualModel] = useState(
		!!settings.model && settings.provider !== 'custom' && !initialModel,
	)
	const discoveryRequest = useRef<{ scope: string; controller: AbortController } | null>(null)
	const [error, setError] = useState<string | null>(null)
	const option = providers.find((entry) => entry.id === provider)
	const selectedModel = option?.models.find((entry) => entry.id === model)
	const effectiveApi =
		provider === 'custom' ? api : (selectedModel?.api ?? option?.models[0]?.api ?? api)
	const defaultBaseUrl = selectedModel?.baseUrl ?? option?.models[0]?.baseUrl ?? ''
	const discoveryScope = JSON.stringify([
		provider,
		effectiveApi,
		baseUrl || defaultBaseUrl,
		apiKey,
		env,
	])
	const onlineModels = discoveryResult?.scope === discoveryScope ? discoveryResult.models : null
	const discoveryError =
		discoveryFailure?.scope === discoveryScope ? discoveryFailure.message : null
	const loadingModels = loadingScope === discoveryScope
	useEffect(() => {
		if (discoveryRequest.current?.scope !== discoveryScope)
			discoveryRequest.current?.controller.abort()
		return () => discoveryRequest.current?.controller.abort()
	}, [discoveryScope])
	const fields = getModelConfigFields(provider, effectiveApi)
	const reuseKey =
		snapshot.isConfigured &&
		snapshot.hasModelKey &&
		provider === settings.provider &&
		(provider !== 'custom' || effectiveApi === settings.api) &&
		endpoint(baseUrl) === endpoint(settings.baseUrl) &&
		fields.every(
			(field) =>
				(field.type === 'url'
					? endpoint(env[field.name] ?? '')
					: (env[field.name]?.trim() ?? '')) ===
				(field.type === 'url'
					? endpoint(settings.env[field.name] ?? '')
					: (settings.env[field.name]?.trim() ?? '')),
		)
	const providerItems = useMemo(
		() => [
			...providers.map((entry) => ({
				id: entry.id,
				name: entry.name,
				description: entry.unavailableReason ?? `${entry.models.length} 个参考模型 · ${entry.id}`,
			})),
			{ id: 'custom', name: '自定义供应商', description: '连接自定义端点并选择模型协议' },
		],
		[providers],
	)
	const modelItems =
		onlineModels?.map((entry) => ({
			id: entry.id,
			name: entry.name,
			description: `${entry.id} · 在线返回`,
		})) ??
		option?.models.map((entry) => ({
			id: entry.id,
			name: entry.name,
			description: `${entry.id} · ${entry.contextWindow.toLocaleString()} token`,
		})) ??
		[]
	const changeProvider = (next: string) => {
		if (next === provider) return
		setProvider(next)
		setApi('openai-responses')
		setModel('')
		setBaseUrl('')
		setContextWindow(next === 'custom' ? '32000' : '')
		setEnv({})
		setApiKey('')
		setAdvancedOpen(false)
		setManualModel(false)
		setError(null)
	}
	const fetchModels = async () => {
		discoveryRequest.current?.controller.abort()
		const request = new AbortController()
		discoveryRequest.current = { scope: discoveryScope, controller: request }
		setLoadingScope(discoveryScope)
		setDiscoveryFailure(null)
		try {
			const models = await session.discoverModels(
				{ provider, api: effectiveApi as BrowserModelApi, baseUrl, model, apiKey, env },
				request.signal,
			)
			if (!request.signal.aborted) setDiscoveryResult({ scope: discoveryScope, models })
		} catch (cause) {
			if (!request.signal.aborted)
				setDiscoveryFailure({
					scope: discoveryScope,
					message:
						cause instanceof DOMException && cause.name === 'TimeoutError'
							? '获取模型超时，请重试或手动填写模型 ID。'
							: cause instanceof TypeError
								? '无法连接模型服务，请检查地址、网络与浏览器 CORS；仍可手动填写模型 ID。'
								: cause instanceof Error
									? cause.message
									: String(cause),
				})
		} finally {
			if (!request.signal.aborted) setLoadingScope(null)
		}
	}
	const submit = (event: FormEvent) => {
		event.preventDefault()
		try {
			if (option?.unavailableReason) throw new Error(option.unavailableReason)
			session.setModel({
				provider,
				api: effectiveApi as BrowserModelApi,
				baseUrl: baseUrl || (!selectedModel && provider !== 'custom' ? defaultBaseUrl : ''),
				model,
				apiKey,
				contextWindow: contextWindow.trim()
					? Number(contextWindow)
					: selectedModel
						? undefined
						: (onlineModels?.find((entry) => entry.id === model)?.contextWindow ?? 32_000),
				env: Object.fromEntries(fields.map((field) => [field.name, env[field.name] ?? ''])),
			})
			setApiKey('')
			setError(null)
			onSaved()
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause))
		}
	}
	return (
		<form onSubmit={submit} className="agent-workspace-settings space-y-6" aria-label="模型设置">
			<div className="space-y-2 text-sm text-muted-foreground">
				<p>
					先选择供应商并填写连接信息，再在线获取并搜索模型。参考目录只提供模型参数，不代表账户访问权限。
				</p>
				<p>
					{snapshot.remembersModelConnection
						? '连接与密钥保存在当前标签页，刷新后可继续使用；关闭标签页或清除连接后移除。'
						: 'API Key 只保留在当前会话内存中。'}
				</p>
			</div>
			<fieldset className="min-w-0 space-y-4">
				<legend className="mb-4 text-sm font-medium">供应商与模型</legend>
				<div className="grid gap-4 sm:grid-cols-2">
					<SettingsAutocomplete
						label="供应商"
						searchLabel="搜索供应商"
						items={providerItems}
						value={provider}
						disabled={disabled}
						onChange={changeProvider}
					/>
					{provider === 'custom' ? (
						<div className="min-w-0 space-y-2">
							<Label htmlFor={protocolId}>协议</Label>
							<Select
								value={api}
								disabled={disabled}
								onValueChange={(key) => {
									if (!CUSTOM_MODEL_APIS.some((entry) => entry.id === key)) return
									setApi(key as BrowserModelApi)
									setEnv({})
									setApiKey('')
									setError(null)
								}}
							>
								<SelectTrigger id={protocolId} aria-label="协议" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{CUSTOM_MODEL_APIS.map((entry) => (
										<SelectItem key={entry.id} value={entry.id}>
											{entry.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					) : manualModel ? (
						<SettingsTextField
							label="模型 ID"
							value={model}
							onChange={setModel}
							required
							disabled={disabled}
							placeholder="模型服务提供的 ID"
						/>
					) : (
						<SettingsAutocomplete
							key={provider}
							label="模型"
							searchLabel="搜索模型"
							items={modelItems}
							value={model}
							required
							disabled={disabled || !provider || !!option?.unavailableReason}
							onChange={(next) => {
								if (next === model) return
								setModel(next)
								setContextWindow('')
								setError(null)
							}}
						/>
					)}
				</div>
				{provider && provider !== 'custom' && (
					<Button
						type="button"
						size="sm"
						variant="ghost"
						disabled={disabled}
						onClick={() => setManualModel(!manualModel)}
					>
						{manualModel ? '从列表选择模型' : '手动填写模型 ID'}
					</Button>
				)}
				{selectedModel && (
					<Alert role="status">
						<AlertTitle>{selectedModel.name}</AlertTitle>
						<AlertDescription>
							{selectedModel.contextWindow.toLocaleString()} token 上下文 · {selectedModel.api}
						</AlertDescription>
					</Alert>
				)}
				{option?.note && <p className="text-sm text-muted-foreground">{option.note}</p>}
				{option?.unavailableReason && (
					<Alert role="status">
						<AlertDescription>{option.unavailableReason}</AlertDescription>
					</Alert>
				)}
			</fieldset>
			<Separator />
			<fieldset className="min-w-0 space-y-4">
				<legend className="mb-4 text-sm font-medium">连接与模型列表</legend>
				<div className="grid gap-4 sm:grid-cols-2">
					{provider === 'custom' && (
						<>
							<SettingsTextField
								label="Base URL"
								value={baseUrl}
								onChange={setBaseUrl}
								type="url"
								required
								disabled={disabled}
								placeholder="https://api.example.com/v1"
							/>
							<SettingsTextField
								label="模型 ID"
								value={model}
								onChange={setModel}
								required
								disabled={disabled}
								placeholder="模型服务提供的 ID"
							/>
							<SettingsTextField
								label="上下文窗口"
								value={contextWindow}
								onChange={setContextWindow}
								type="number"
								required
								disabled={disabled}
								min={1024}
								max={2_000_000}
							/>
						</>
					)}
					{fields.map((field) => (
						<SettingsTextField
							key={field.name}
							label={field.label}
							value={env[field.name] ?? ''}
							onChange={(value) => setEnv((previous) => ({ ...previous, [field.name]: value }))}
							type={field.type ?? 'text'}
							required={field.required}
							disabled={disabled}
							placeholder={field.placeholder}
							description={field.help}
						/>
					))}
					<SettingsTextField
						label="API Key"
						value={apiKey}
						onChange={setApiKey}
						type="password"
						required={!reuseKey}
						disabled={disabled}
						placeholder={reuseKey ? '留空沿用当前密钥' : '输入 API Key 或 token'}
						description={
							reuseKey
								? '相同供应商和端点已配置，可留空沿用当前连接的密钥。'
								: '更换供应商或端点时需要填写新密钥。'
						}
					/>
				</div>
				{provider && !option?.unavailableReason && supportsModelDiscovery(effectiveApi) && (
					<>
						<Button
							type="button"
							variant="secondary"
							disabled={disabled || loadingModels || (!apiKey.trim() && !reuseKey)}
							onClick={() => void fetchModels()}
						>
							{loadingModels ? '正在获取模型…' : onlineModels ? '刷新在线模型' : '在线获取模型'}
						</Button>
						{onlineModels && (
							<p className="text-sm text-muted-foreground" role="status">
								在线返回 {onlineModels.length}{' '}
								个模型；列表不保证所选协议和工具调用可用，请按供应商说明选择。
							</p>
						)}
						{provider === 'custom' && onlineModels && (
							<SettingsAutocomplete
								label="在线模型"
								searchLabel="搜索在线模型"
								items={modelItems}
								value={model}
								disabled={disabled}
								onChange={(next) => {
									setModel(next)
									setContextWindow(
										String(onlineModels.find((item) => item.id === next)?.contextWindow ?? 32000),
									)
								}}
							/>
						)}
					</>
				)}
				{discoveryError && <SettingsError>{discoveryError}</SettingsError>}
				<p className="text-sm text-muted-foreground">
					{onlineModels === null && provider && provider !== 'custom'
						? '当前列表为内置参考目录。'
						: ''}
					模型服务需允许此页面的浏览器 CORS；无法获取列表时仍可手动填写。
				</p>
			</fieldset>
			<Separator />
			{provider && provider !== 'custom' && !option?.unavailableReason && (
				<CollapsiblePrimitive.Root
					open={advancedOpen}
					onOpenChange={setAdvancedOpen}
					className="space-y-4"
				>
					<CollapsiblePrimitive.Trigger asChild>
						<Button type="button" variant="ghost" className="group w-full justify-between">
							高级设置{' '}
							<ChevronDownIcon
								aria-hidden="true"
								className="transition-transform group-data-[state=open]:rotate-180"
							/>
						</Button>
					</CollapsiblePrimitive.Trigger>
					<CollapsiblePrimitive.Content className="grid gap-4 sm:grid-cols-2">
						{provider !== 'azure' && (
							<SettingsTextField
								label="Base URL"
								value={baseUrl}
								onChange={setBaseUrl}
								type="url"
								disabled={disabled}
								placeholder={defaultBaseUrl || '使用供应商默认地址'}
							/>
						)}
						<SettingsTextField
							label="上下文窗口"
							value={contextWindow}
							onChange={setContextWindow}
							type="number"
							disabled={disabled}
							min={1024}
							max={2_000_000}
							placeholder={
								selectedModel ? String(selectedModel.contextWindow) : '32000（请按模型文档调整）'
							}
						/>
						<p className="text-sm text-muted-foreground sm:col-span-2">
							{provider === 'azure'
								? '上下文窗口留空使用模型目录默认值。'
								: '留空使用供应商地址和模型目录中的上下文窗口。'}
						</p>
					</CollapsiblePrimitive.Content>
				</CollapsiblePrimitive.Root>
			)}
			{snapshot.modelStorageError && <SettingsError>{snapshot.modelStorageError}</SettingsError>}
			{error && <SettingsError>{error}</SettingsError>}
			<div className="flex flex-wrap gap-2">
				<Button type="submit" disabled={disabled || !provider || !!option?.unavailableReason}>
					应用模型设置
				</Button>
				{snapshot.isConfigured && (
					<Button
						type="button"
						variant="ghost"
						disabled={disabled}
						onClick={() => {
							session.clearModel()
							onCancel()
						}}
					>
						清除连接
					</Button>
				)}
				<Button
					type="button"
					variant="secondary"
					onClick={() => {
						setApiKey('')
						onCancel()
					}}
				>
					取消
				</Button>
			</div>
		</form>
	)
}

function SettingsAutocomplete({
	label,
	searchLabel,
	items,
	value,
	onChange,
	disabled,
	required,
}: {
	label: string
	searchLabel: string
	items: readonly CatalogItem[]
	value: string
	onChange(value: string): void
	disabled: boolean
	required?: boolean
}) {
	const id = useId()
	const choices = useMemo(() => items.map((item) => ({ ...item, keywords: [item.id] })), [items])
	return (
		<div className="min-w-0 space-y-2">
			<Label htmlFor={id}>{label}</Label>
			<ModelSelectorRoot models={choices} value={value} onValueChange={onChange}>
				<ModelSelectorTrigger
					id={id}
					aria-label={label}
					aria-required={required}
					disabled={disabled}
					className="w-full"
				>
					<ModelSelectorValue placeholder={value || `选择${label}`} />
				</ModelSelectorTrigger>
				<ModelSelectorContent searchable className="max-w-[calc(100vw-2rem)]">
					<ModelSelectorSearch
						aria-label={searchLabel}
						placeholder={`按名称或 ID ${searchLabel}`}
					/>
					<ModelSelectorList aria-label={`${label}列表`}>
						<ModelSelectorEmpty>没有匹配的{label}。</ModelSelectorEmpty>
						<ModelSelectorGroup>
							{choices.map((choice) => (
								<ModelSelectorItem key={choice.id} model={choice} />
							))}
						</ModelSelectorGroup>
					</ModelSelectorList>
				</ModelSelectorContent>
			</ModelSelectorRoot>
		</div>
	)
}

function SettingsTextField({
	label,
	value,
	onChange,
	type = 'text',
	disabled,
	required,
	placeholder,
	description,
	min,
	max,
}: {
	label: string
	value: string
	onChange(value: string): void
	type?: 'text' | 'url' | 'password' | 'number'
	disabled: boolean
	required?: boolean
	placeholder?: string
	description?: string
	min?: number
	max?: number
}) {
	const id = useId()
	return (
		<div className="min-w-0 space-y-2">
			<Label htmlFor={id}>{label}</Label>
			<Input
				id={id}
				aria-label={label}
				aria-describedby={description ? `${id}-description` : undefined}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				type={type}
				disabled={disabled}
				required={required}
				autoComplete="off"
				placeholder={placeholder}
				min={min}
				max={max}
				step={type === 'number' ? 1 : undefined}
			/>
			{description && (
				<p id={`${id}-description`} className="text-sm text-muted-foreground">
					{description}
				</p>
			)}
		</div>
	)
}

function SettingsError({ children }: { children: string }) {
	return (
		<Alert variant="destructive">
			<AlertDescription>{children}</AlertDescription>
		</Alert>
	)
}

function endpoint(value: string): string {
	try {
		return new URL(value.trim()).href.replace(/\/+$/, '')
	} catch {
		return value.trim().replace(/\/+$/, '')
	}
}
