import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import {
	createModels,
	fauxProvider,
	fauxAssistantMessage,
	fauxThinking,
	fauxText,
	fauxToolCall,
	createAssistantMessageEventStream,
} from '@earendil-works/pi-ai'
import { AgentWorkspace } from '../../packages/ui/src/index.tsx'
import { CodeBlock } from '../../packages/ui/src/markdown.tsx'
import { code as nativeCode } from '@streamdown/code'
import { createAgentSession } from '../../src/session.ts'
import { WorkspaceHistory, type WorkspaceHistorySummary } from '../../src/history.ts'
import { CUSTOM_MODEL_APIS } from '../../src/models.ts'
import './fixture-styles.css'

const pause = (milliseconds: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
const settingsFormSelector = 'form[aria-label="模型设置"]'

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message)
}

async function waitFor(predicate: () => boolean, deadline = Date.now() + 5000): Promise<void> {
	if (predicate()) return
	if (Date.now() > deadline) throw new Error('Timed out waiting for React session replacement')
	await pause(10)
	return waitFor(predicate, deadline)
}

function findButton(
	container: HTMLElement | Document,
	text: string,
): HTMLButtonElement | undefined {
	return [...container.querySelectorAll('button')].find(
		(value) => value.getAttribute('aria-label') === text || value.textContent?.trim() === text,
	)
}

function button(container: HTMLElement | Document, text: string): HTMLButtonElement {
	const element = findButton(container, text)
	assert(element, `Missing button: ${text}`)
	return element
}

function findInput(label: string): HTMLInputElement | undefined {
	const direct = [...document.querySelectorAll('input')].find(
		(value) => value.getAttribute('aria-label') === label,
	)
	if (direct) return direct
	const associated = [...document.querySelectorAll('label')].find((value) =>
		value.textContent?.startsWith(label),
	)
	if (associated?.control instanceof HTMLInputElement) return associated.control
	const group = [...document.querySelectorAll('[aria-label]')].find(
		(value) => value.getAttribute('aria-label') === label,
	)
	return group?.querySelector<HTMLInputElement>('input') ?? undefined
}
function input(label: string): HTMLInputElement {
	const element = findInput(label)
	assert(element, `Missing input: ${label}`)
	return element
}

function fill(element: HTMLInputElement, value: string): void {
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value)
	element.dispatchEvent(new Event('input', { bubbles: true }))
}

function isVisible(element: HTMLElement | undefined): boolean {
	return !!element?.getClientRects().length && !element.closest('[inert], [aria-hidden="true"]')
}
function options(): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>('[role="option"]')].filter(isVisible)
}
function picker(label: string): HTMLElement {
	return (
		[...document.querySelectorAll<HTMLElement>('[role="combobox"]')].find(
			(element) => element.getAttribute('aria-label') === label,
		) ?? button(document, label)
	)
}
function pickerSearchLabel(label: string): string {
	return label === '供应商'
		? '搜索供应商'
		: label === '当前模型'
			? '搜索当前供应商模型'
			: '搜索模型'
}
async function openPicker(label: string): Promise<void> {
	const trigger = picker(label)
	const expanded =
		label === '协议'
			? trigger.getAttribute('aria-expanded') === 'true'
			: isVisible(findInput(pickerSearchLabel(label)))
	if (!expanded) trigger.click()
	await waitFor(() =>
		label === '协议' ? options().length > 0 : isVisible(findInput(pickerSearchLabel(label))),
	).catch((error) => {
		throw new Error(
			`${String(error)}; picker: ${JSON.stringify({
				label,
				trigger: trigger.outerHTML,
				search: findInput(pickerSearchLabel(label))?.outerHTML,
				menus: [
					...document.querySelectorAll<HTMLElement>(
						'[role="dialog"], [role="listbox"], [data-slot="model-selector-content"]',
					),
				].map((element) => ({
					label: element.getAttribute('aria-label'),
					state: element.getAttribute('data-state'),
					visible: isVisible(element),
					inert: element.closest('[inert], [aria-hidden="true"]')?.outerHTML.slice(0, 160),
					text: element.textContent?.slice(0, 200),
				})),
			})}`,
		)
	})
}
async function choose(label: string, value: string): Promise<void> {
	const display =
		label === '协议'
			? (CUSTOM_MODEL_APIS.find((api) => api.id === value)?.label ?? value)
			: value === 'custom'
				? '自定义供应商'
				: value
	await openPicker(label)
	if (label !== '协议') fill(input(pickerSearchLabel(label)), display)
	await waitFor(() => options().some((option) => option.textContent?.includes(display)))
	options()
		.find((option) => option.textContent?.includes(display))!
		.click()
	await waitFor(() => options().length === 0)
}

async function applySettings(): Promise<void> {
	await pause(10)
	document.querySelector<HTMLFormElement>(settingsFormSelector)!.requestSubmit()
	await waitFor(() => !document.querySelector(settingsFormSelector)).catch((error) => {
		throw new Error(
			`${String(error)}; settings submission: ${document.querySelector('[role="alert"]')?.textContent ?? 'no error'}`,
		)
	})
	// Saving schedules composer focus after the dialog closes. Wait for that handoff
	// before opening another popover, otherwise the pending focus dismisses it.
	await waitFor(() => document.activeElement?.getAttribute('aria-label') === '消息')
}

async function openSettings(container: HTMLElement): Promise<void> {
	button(container, '模型设置').click()
	await waitFor(() => !!document.querySelector(settingsFormSelector))
}
async function openHistory(container: HTMLElement): Promise<void> {
	if (!isVisible(findInput('搜索会话'))) button(container, '历史').click()
	await waitFor(() => isVisible(findInput('搜索会话')))
}
async function closeHistory(container: HTMLElement): Promise<void> {
	const drawerClose = findButton(document, '关闭会话历史')
	if (isVisible(drawerClose)) drawerClose!.click()
	else button(container, '历史').click()
	await waitFor(() => !isVisible(findInput('搜索会话')))
}

function noApi(): never {
	throw new Error('React settings/history tests do not execute RPC')
}
function missingListResolver(): never {
	throw new Error('Missing list resolver')
}

export async function runReactNativeCodeReview(): Promise<{
	name: string
	durationMs: number
}> {
	const started = performance.now()
	const prefix = `// ${crypto.randomUUID()} ${'a'.repeat(120)}\nconst middle = `
	const suffix = `;\n// ${'z'.repeat(120)}`
	const initialSource = `${prefix}111${suffix}`
	const revisedSource = `${prefix}222${suffix}`
	assert(
		initialSource.length === revisedSource.length &&
			initialSource.slice(0, 100) === revisedSource.slice(0, 100) &&
			initialSource.slice(-100) === revisedSource.slice(-100),
		'The cache regression must exercise a same-length change outside both head/tail samples',
	)
	const container = document.createElement('div')
	container.className = 'aui-root'
	document.body.append(container)
	const root = createRoot(container)
	const render = (source: string) =>
		root.render(
			createElement('div', { className: 'aui-root' }, createElement(CodeBlock, { code: source })),
		)
	const code = () =>
		container.querySelector<HTMLElement>('[data-streamdown="code-block-body"] pre code')
	const originalHighlight = nativeCode.highlight
	const originalWriteText = navigator.clipboard.writeText
	const oldCallbacks: (() => void)[] = []
	const copied: string[] = []
	try {
		render(initialSource)
		await waitFor(
			() =>
				code()?.innerText === initialSource &&
				[...code()!.querySelectorAll('span[style*="--sdm-c"]')].some(
					(token) => token.textContent?.trim() === '111',
				),
		)
		render(revisedSource)
		await waitFor(
			() =>
				code()?.innerText === revisedSource &&
				[...code()!.querySelectorAll('span[style*="--sdm-c"]')].some(
					(token) => token.textContent?.trim() === '222',
				),
		)
		assert(
			code()!.innerText.includes('222') && !code()!.innerText.includes('111'),
			'Native syntax-token cache retained stale middle content after a same-length source edit',
		)
		// Delay an actual Shiki result through its public callback, then retire
		// that render. The next large native plaintext render must own its state.
		nativeCode.highlight = (highlightOptions, callback) => {
			const result = originalHighlight.call(nativeCode, highlightOptions, (highlighted) => {
				oldCallbacks.push(() => callback?.(highlighted))
			})
			if (result) oldCallbacks.push(() => callback?.(result))
			return null
		}
		render('const before = 14;')
		await waitFor(() => oldCallbacks.length > 0)
		const largeSource = [
			'/* New complete tool source:',
			'```html',
			'<img src="x" onerror="window.agentCodeExecuted=true">',
			'```',
			'plain payload '.repeat(700),
			'*/',
			'return 42;',
			'',
		].join('\n')
		// Native CodeBlock omits terminal newlines from its visual body while
		// retaining the unmodified source in its public copy context.
		const largeDisplayedSource = largeSource.slice(0, -1)
		assert(
			largeSource.length > 8_000,
			'The stale-result regression did not cross the plaintext threshold',
		)
		render(largeSource)
		await waitFor(
			() =>
				code()?.textContent === largeDisplayedSource &&
				code()?.querySelectorAll('span[style*="--sdm-c"]').length === 1,
		)
		for (const callback of oldCallbacks) callback()
		await pause(100)
		assert(
			code()?.textContent === largeDisplayedSource &&
				code()?.querySelectorAll('span[style*="--sdm-c"]').length === 1,
			'A retired async syntax result replaced the complete large native plaintext source',
		)
		assert(
			container.querySelectorAll('img, script, iframe, [onerror], [onclick]').length === 0,
			'Raw tool source containing fences or HTML entered the Markdown/HTML pipeline',
		)
		navigator.clipboard.writeText = async (value) => {
			copied.push(value)
		}
		button(container, '复制代码').click()
		await waitFor(() => copied.length === 1)
		assert(
			copied[0] === largeSource,
			'Native tool-code copy lost raw fences, HTML or the terminal source newline',
		)
	} catch (error) {
		throw new Error(
			`${String(error)}; native code: ${JSON.stringify({
				innerText: code()?.innerText?.slice(0, 600),
				textContent: code()?.textContent?.slice(0, 600),
				tokens: [...container.querySelectorAll('span[style*="--sdm-c"]')]
					.map((token) => ({
						text: token.textContent?.slice(0, 100),
						style: token.getAttribute('style'),
					}))
					.slice(0, 12),
				html: container.innerHTML.slice(0, 1500),
			})}`,
			{ cause: error },
		)
	} finally {
		nativeCode.highlight = originalHighlight
		navigator.clipboard.writeText = originalWriteText
		root.unmount()
		container.remove()
	}
	return {
		name: 'native Shiki full-source cache and Streamdown retired-callback guard preserve edited/large tool code and exact clipboard text',
		durationMs: Math.round(performance.now() - started),
	}
}

export async function runReactGroupedPartsReview(): Promise<{
	name: string
	durationMs: number
}> {
	const started = performance.now()
	const finalText = ['第一段正式结论。', '第二段正式结论。']
	const faux = fauxProvider({ tokensPerSecond: 100, tokenSize: { min: 1, max: 1 } })
	const nativeStream = faux.provider.streamSimple
	let releasePreview!: () => void
	const previewReleased = new Promise<void>((resolve) => {
		releasePreview = resolve
	})
	let firstStream = true
	let previewHeld = false
	let forwarding: Promise<void> | undefined
	faux.provider.streamSimple = (model, context, streamOptions) => {
		const source = nativeStream(model, context, streamOptions)
		if (!firstStream) return source
		firstStream = false
		const stream = createAssistantMessageEventStream()
		forwarding = (async () => {
			for await (const event of source) {
				// Keep the actual pi events and order, but freeze the first live
				// snapshot until React has exposed it. Faux partials share mutable
				// content, so the gated preview must own a snapshot of each event.
				stream.push(structuredClone(event))
				if (!previewHeld && event.type === 'thinking_delta') {
					previewHeld = true
					await previewReleased
				}
			}
			stream.end()
		})()
		void forwarding.catch(() => stream.end())
		return stream
	}
	const models = createModels()
	models.setProvider(faux.provider)
	faux.setResponses([
		fauxAssistantMessage(
			[fauxThinking('先核对权限和数据范围。'), fauxToolCall('searchDocs', { query: '权限' })],
			{ stopReason: 'toolUse' },
		),
		fauxAssistantMessage([
			fauxText(finalText[0]!),
			fauxThinking('交错思考内容应留在处理过程中。'),
			fauxText(finalText[1]!),
		]),
		fauxAssistantMessage('下一轮正式回复。'),
	])
	const session = createAgentSession({
		titleGeneration: false,
		scopeKey: `react-grouped-parts-${crypto.randomUUID()}`,
		documents: [
			{ id: 'access', title: '权限范围', version: '1', text: '当前用户只能读取授权范围。' },
		],
		models,
		model: faux.getModel(),
		acquireApi: noApi,
	})
	const container = document.createElement('div')
	document.body.append(container)
	const root = createRoot(container)
	const originalWriteText = navigator.clipboard.writeText
	const copied: string[] = []
	try {
		root.render(createElement(AgentWorkspace, { session }))
		await waitFor(() => !!container.querySelector('[aria-label="新会话"]'))
		const sending = session.send('核对授权范围后给出分段结论。')
		await waitFor(
			() =>
				session.getSnapshot().isRunning &&
				!!container.querySelector('[data-slot="reasoning-root"][data-state="open"]') &&
				!!container.querySelector('[data-slot="reasoning-text"]')?.textContent?.includes('先'),
		)
		assert(
			container.querySelector('[data-slot="reasoning-content"] [data-slot="reasoning-text"]'),
			'Native reasoning did not expose its live preview while pi was streaming',
		)
		releasePreview()
		await sending
		await waitFor(() => {
			const finalBlocks = [
				...container.querySelectorAll<HTMLElement>(
					'.agent-workspace-assistant .agent-workspace-markdown',
				),
			].filter((element) => !element.closest('.agent-workspace-process'))
			return (
				container.querySelectorAll('.agent-workspace-process').length === 2 &&
				finalBlocks.length === 2 &&
				finalBlocks.every((element, index) => element.innerText === finalText[index])
			)
		})
		const assistant = container.querySelector<HTMLElement>('.agent-workspace-assistant')!
		const process = [...assistant.querySelectorAll<HTMLElement>('.agent-workspace-process')]
		const text = [...assistant.querySelectorAll<HTMLElement>('.agent-workspace-markdown')].filter(
			(element) => !element.closest('.agent-workspace-process'),
		)
		assert(
			text.length === 2 && text.every((element, index) => element.innerText === finalText[index]),
			'Native grouping hid a final text segment or leaked interleaved reasoning into the answer',
		)
		const ordered = [process[0]!, text[0]!, process[1]!, text[1]!]
		assert(
			ordered
				.slice(1)
				.every((element, index) =>
					Boolean(
						ordered[index]!.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING,
					),
				),
			'Native grouping moved interleaved process and final answer parts out of pi order',
		)
		const toggles = process.map((element) =>
			element.querySelector<HTMLButtonElement>('[data-slot="tool-group-trigger"]')!,
		)
		assert(
			toggles.every((toggle) => toggle.getAttribute('aria-expanded') === 'false'),
			'Terminal interleaved process segments did not collapse while preserving both final texts',
		)
		assert(faux.state.callCount === 2, 'Grouped native parts replayed the pi tool loop')
		navigator.clipboard.writeText = async (value) => {
			copied.push(value)
		}
		button(assistant, '复制消息').click()
		await waitFor(() => copied.length === 1)
		assert(
			copied[0] === finalText.join('\n'),
			'Native message copying included process text or omitted an interleaved final text part',
		)
		assert(
			faux.state.callCount === 2 && session.getSnapshot().executions.length === 0,
			'Copying a grouped answer invoked a model or JavaScript tool',
		)
		toggles[0]!.click()
		await waitFor(() => toggles[0]!.getAttribute('aria-expanded') === 'true')
		await waitFor(() => !!process[0]!.querySelector('[data-slot="reasoning-trigger"]'))
		const reasoning = process[0]!.querySelector<HTMLButtonElement>(
			'[data-slot="reasoning-trigger"]',
		)!
		assert(
			reasoning.getAttribute('aria-expanded') === 'false',
			'Settled reasoning remained in its live preview state',
		)
		reasoning.click()
		await waitFor(() => reasoning.getAttribute('aria-expanded') === 'true')
		await session.send('继续下一轮。')
		await waitFor(() => container.querySelectorAll('.agent-workspace-assistant').length === 2)
		assert(
			assistant === container.querySelector('.agent-workspace-assistant') &&
				toggles[0]!.getAttribute('aria-expanded') === 'true' &&
				reasoning.getAttribute('aria-expanded') === 'true',
			'A subsequent turn remounted the prior assistant or reset its manually expanded process/reasoning',
		)
		assert(
			Number(faux.state.callCount) === 3 && copied.length === 1,
			'A new turn replayed earlier models or clipboard actions',
		)
		const id = session.getSnapshot().id
		await session.newConversation()
		await waitFor(() => container.querySelectorAll('.agent-workspace-assistant').length === 0)
		await session.restore(id)
		await waitFor(() => container.querySelectorAll('.agent-workspace-assistant').length === 2)
		const restoredTexts = [
			...container.querySelectorAll<HTMLElement>(
				'.agent-workspace-assistant .agent-workspace-markdown',
			),
		]
			.filter((element) => !element.closest('.agent-workspace-process'))
			.map((element) => element.innerText)
		assert(
			restoredTexts.join('\n') === [...finalText, '下一轮正式回复。'].join('\n') &&
				Number(faux.state.callCount) === 3,
			'History restoration hid final text parts or replayed the native interleaved model turns',
		)
	} catch (error) {
		throw new Error(
			`${String(error)}; grouped parts: ${JSON.stringify({
				previewHeld,
				isRunning: session.getSnapshot().isRunning,
				callCount: faux.state.callCount,
				reasoning: [...container.querySelectorAll('[data-slot="reasoning-root"]')].map(
					(element) => ({ state: element.getAttribute('data-state'), text: element.textContent }),
				),
				html: container.innerHTML.slice(0, 1500),
			})}`,
			{ cause: error },
		)
	} finally {
		releasePreview()
		navigator.clipboard.writeText = originalWriteText
		root.unmount()
		container.remove()
		session.dispose()
		await forwarding
	}
	return {
		name: 'native grouped text/reasoning/tool parts preserve final answers, exact copy, disclosure state and read-only restoration',
		durationMs: Math.round(performance.now() - started),
	}
}

export async function runReactGeneratedTitleReview(): Promise<{
	name: string
	durationMs: number
}> {
	const started = performance.now()
	const title = '投票规则与回执检查'
	const finalResponse = '正式答复：活动规则与历史回执已完成检查。'
	const faux = fauxProvider({ tokensPerSecond: 50_000 })
	const models = createModels()
	models.setProvider(faux.provider)
	faux.setResponses([fauxAssistantMessage(finalResponse), fauxAssistantMessage(title)])
	// This separate case keeps the production default: one reply, then background metadata.
	const session = createAgentSession({
		scopeKey: `react-generated-title-${crypto.randomUUID()}`,
		documents: [],
		models,
		model: faux.getModel(),
		acquireApi: noApi,
	})
	const initialMessageCount = session.getSnapshot().messages.length
	const container = document.createElement('div')
	document.body.append(container)
	const root = createRoot(container)
	try {
		root.render(createElement(AgentWorkspace, { session }))
		await waitFor(() => !!container.querySelector('[aria-label="新会话"]'))
		await session.send('请先核对投票的活动规则，并检查过去的业务回执是否已经保存。')
		await waitFor(() => session.getSnapshot().title === title)
		await waitFor(
			() => container.querySelector('.agent-workspace-current-title h2')?.textContent === title,
		)
		await openHistory(container)
		await waitFor(() => !!document.querySelector(`[aria-label="打开会话 ${title}"]`))
		const titleButton = button(document, `打开会话 ${title}`)
		const moreButton = button(document, `${title}的更多操作`)
		assert(
			titleButton.parentElement?.textContent?.trim() === title &&
				!titleButton.parentElement.querySelector('time'),
			'Background generated metadata did not render a compact title-only native thread item',
		)
		const titleBounds = titleButton.getBoundingClientRect()
		const moreBounds = moreButton.getBoundingClientRect()
		assert(
			titleBounds.height > 0 &&
				titleBounds.height <= 40 &&
				moreBounds.height > 0 &&
				moreBounds.height <= 40 &&
				moreBounds.left >= 0 &&
				moreBounds.right <= innerWidth &&
				!titleButton.disabled &&
				!moreButton.disabled,
			'Generated native thread titles or their more actions are hidden or oversized',
		)
		const assistant = container.querySelector('.agent-workspace-assistant')
		assert(
			assistant?.textContent?.includes(finalResponse) && !assistant.textContent.includes(title),
			'The generated title was mixed into the final assistant response',
		)
		assert(
			session.getSnapshot().messages.length === initialMessageCount + 2 &&
				session.getSnapshot().messages.at(-2)?.role === 'user' &&
				session.getSnapshot().messages.at(-1)?.role === 'assistant' &&
				!JSON.stringify(session.getSnapshot().messages).includes(title) &&
				faux.state.callCount === 2,
			'Background title generation changed the native transcript or consumed extra responses',
		)
		const id = session.getSnapshot().id
		const stored = (await session.listHistory()).find((item) => item.id === id)
		assert(stored?.title === title, 'The generated title was displayed without being persisted')
		button(container, '新会话').click()
		await waitFor(() => session.getSnapshot().id !== id)
		await waitFor(
			() => container.querySelector('.agent-workspace-current-title h2')?.textContent === '新会话',
		)
		button(document, `打开会话 ${title}`).click()
		await waitFor(() => session.getSnapshot().id === id && !session.getSnapshot().isHistoryLoading)
		await waitFor(
			() => container.querySelector('.agent-workspace-current-title h2')?.textContent === title,
		)
		assert(
			session.getSnapshot().title === title && faux.state.callCount === 2,
			'Native thread restoration dropped the generated title or replayed its model request',
		)
		assert(
			container.querySelectorAll('.agent-workspace-assistant').length === 1 &&
				container.querySelector('.agent-workspace-assistant')?.textContent?.includes(finalResponse),
			'Generated-title thread restoration changed the final dialogue',
		)
	} finally {
		root.unmount()
		container.remove()
		session.dispose()
	}
	return {
		name: 'default background title generation updates compact React header/history and restores without polluting dialogue or replaying the model',
		durationMs: Math.round(performance.now() - started),
	}
}

export async function runReactSessionReplacementReview(): Promise<{
	name: string
	durationMs: number
}> {
	const started = performance.now()
	const scopeA = `react-old-${crypto.randomUUID()}`
	const scopeB = `react-new-${crypto.randomUUID()}`
	const first = createAgentSession({
		titleGeneration: false,
		scopeKey: scopeA,
		documents: [],
		acquireApi: noApi,
	})
	const second = createAgentSession({
		titleGeneration: false,
		scopeKey: scopeB,
		documents: [],
		acquireApi: noApi,
	})
	second.setModel({
		baseUrl: 'https://new-provider.example/v1',
		model: 'new-model',
		apiKey: 'new-memory-key',
		contextWindow: 8192,
	})
	const history = new WorkspaceHistory()
	const originalHistoryLoad = WorkspaceHistory.prototype.load
	let releaseHistoryLoad: (() => void) | undefined
	await history.save({
		id: 'old-history',
		scopeKey: scopeA,
		title: 'Private prior history',
		createdAt: 1,
		updatedAt: 1,
		messages: [],
		executions: [],
	})
	const container = document.createElement('div')
	document.body.append(container)
	const root = createRoot(container)
	try {
		root.render(
			createElement(AgentWorkspace, {
				session: first,
				referenceSources: [{ trigger: '@', label: '恢复检查', items: [] }],
			}),
		)
		await waitFor(() => !!container.querySelector('[aria-label="模型设置"]'))
		assert(
			!document.querySelector(settingsFormSelector),
			'Fresh session unexpectedly opened settings',
		)
		await openSettings(container)
		const providers = first.getModelProviders()
		await openPicker('供应商')
		await waitFor(() => options().length === providers.length + 1)
		assert(
			options().length === providers.length + 1 &&
				first.getSnapshot().modelSettings.provider === '',
			'The model form did not expose the native provider catalog and custom option',
		)
		const native = providers.find((entry) => entry.id === 'anthropic')
		assert(native?.models.length, 'Missing native Anthropic chat models')
		const nativeModel = native.models[0]!
		await choose('供应商', native.id)
		await openPicker('模型')
		fill(input('搜索模型'), 'UI_FILTER_NO_MATCH')
		await waitFor(() => options().length === 0)
		assert(
			document.body.textContent?.includes('没有匹配的模型。'),
			'Model search omitted its empty result',
		)
		assert(options().length === 0, 'Search retained unmatched models')
		fill(input('搜索模型'), nativeModel.id)
		await waitFor(() => options().length > 0)
		assert(
			options().every((entry) =>
				entry.textContent?.toLocaleLowerCase().includes(nativeModel.id.toLocaleLowerCase()),
			),
			'Native model filtering ignored the query',
		)
		await choose('模型', nativeModel.id)
		assert(
			!isVisible(findInput('Base URL')) && !isVisible(findInput('上下文窗口')),
			'Native advanced settings were expanded by default',
		)
		button(document, '高级设置').click()
		await waitFor(() => isVisible(findInput('上下文窗口')))
		assert(
			input('Base URL').value === '' &&
				!input('Base URL').required &&
				input('上下文窗口').value === '',
			'Native models required manual endpoint or context configuration',
		)
		button(document, '高级设置').click()
		fill(input('API Key'), 'native-memory-key')
		await applySettings()
		assert(
			first.getSnapshot().modelSettings.provider === native.id &&
				first.getSnapshot().modelSettings.contextWindow === nativeModel.contextWindow &&
				first.getSnapshot().modelSettings.baseUrl === '',
			'Native model selection did not use catalog defaults',
		)
		const alternateModel = native.models.find((entry) => entry.id !== nativeModel.id)
		assert(alternateModel, 'Native provider needs another catalog model for the daily picker')
		const composer = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息"]')!
		const draft = '保持这段未发送草稿，并继续编辑。'
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
			composer,
			draft,
		)
		composer.dispatchEvent(new Event('input', { bubbles: true }))
		composer.setSelectionRange(4, 4)
		await choose('当前模型', alternateModel.id)
		await waitFor(() => document.activeElement === composer)
		assert(composer.value === draft, 'Changing a model discarded the unsent draft')
		assert(composer.selectionStart === 4, 'Changing a model moved the draft caret')
		assert(
			picker('当前模型').closest('.agent-workspace-composer') &&
				button(container, '模型设置').closest('.agent-workspace-composer'),
			'Model controls must be next to the composer input',
		)
		assert(
			first.getSnapshot().modelSettings.model === alternateModel.id &&
				first.getSnapshot().hasModelKey &&
				!document.querySelector(settingsFormSelector),
			'Daily picker failed same-provider model change with the in-memory key',
		)
		assert(
			!JSON.stringify(first.getSnapshot()).includes('native-memory-key'),
			'Daily picker exposed the reused key',
		)
		await openSettings(container)
		assert(
			input('API Key').value === '' && !input('API Key').required,
			'Reopening native settings exposed a key or prohibited same-endpoint reuse',
		)
		await applySettings()
		await openSettings(container)
		const unavailable = providers.find((entry) => entry.unavailableReason)
		assert(unavailable, 'Missing unavailable native provider metadata')
		await choose('供应商', unavailable.name)
		assert(
			button(document, '应用模型设置').disabled &&
				document.body.textContent?.includes(unavailable.unavailableReason!),
			'The form allowed an unavailable browser provider',
		)
		await choose('供应商', 'azure')
		assert(
			input('Azure Endpoint').required &&
				![...document.querySelectorAll('label')].some((entry) =>
					entry.textContent?.startsWith('Base URL'),
				),
			'Native Azure omitted its required endpoint or exposed a duplicate URL override',
		)
		await choose('供应商', 'custom')
		await choose('协议', 'anthropic-messages')
		fill(input('Base URL'), 'https://custom-anthropic.example/v1')
		fill(input('模型 ID'), 'custom-anthropic-model')
		fill(input('API Key'), 'custom-memory-key')
		fill(input('上下文窗口'), '8192')
		await applySettings()
		assert(
			first.getSnapshot().modelSettings.provider === 'custom' &&
				first.getSnapshot().modelSettings.api === 'anthropic-messages',
			'Custom settings discarded the selected native pi protocol',
		)
		await openSettings(container)
		await choose('协议', 'azure-openai-responses')
		assert(
			input('Base URL').required &&
				![...document.querySelectorAll('label')].some((entry) =>
					entry.textContent?.startsWith('Azure Endpoint'),
				),
			'Custom Azure required a duplicate endpoint instead of one Base URL',
		)
		fill(input('API Key'), 'cancelled-draft-key')
		button(document, '取消').click()
		await waitFor(() => !document.querySelector(settingsFormSelector))
		await openSettings(container)
		assert(
			button(document, '协议').textContent?.includes(
				CUSTOM_MODEL_APIS.find((api) => api.id === 'anthropic-messages')!.label,
			) &&
				input('API Key').value === '' &&
				input('Base URL').value === 'https://custom-anthropic.example/v1',
			'Cancelling settings retained the draft protocol or secret',
		)
		await choose('协议', 'openai-completions')
		fill(input('Base URL'), 'https://old-provider.example/v1')
		fill(input('模型 ID'), 'old-model')
		fill(input('API Key'), 'old-memory-key')
		fill(input('上下文窗口'), '16384')
		await applySettings()
		await openSettings(container)
		assert(
			input('Base URL').value === 'https://old-provider.example/v1' &&
				input('模型 ID').value === 'old-model' &&
				input('上下文窗口').value === '16384',
			'Reopened settings lost nonsecret values',
		)
		assert(input('API Key').value === '', 'Reopened settings exposed the applied model key')
		button(document, '取消').click()
		await waitFor(() => !document.querySelector(settingsFormSelector))
		await openHistory(container)
		await waitFor(() => document.body.textContent?.includes('Private prior history') === true)
		WorkspaceHistory.prototype.load = async function deferredScopedLoad(scopeKey, id) {
			if (scopeKey === scopeA && id === 'old-history')
				await new Promise<void>((resolve) => {
					releaseHistoryLoad = resolve
				})
			return originalHistoryLoad.call(this, scopeKey, id)
		}
		button(document, '打开会话 Private prior history').click()
		await waitFor(() => first.getSnapshot().isHistoryLoading && !!releaseHistoryLoad)
		await waitFor(() => button(container, '模型设置').disabled)
		assert(
			button(container, '引用恢复检查').disabled,
			'Reference insertion remained available during an actual history restoration',
		)
		const modelTrigger = picker('当前模型')
		assert(
			modelTrigger instanceof HTMLButtonElement && modelTrigger.matches(':disabled'),
			'Model selection remained available during an actual history restoration',
		)
		assert(
			!first.getSnapshot().isRunning,
			'The model controls are blocked by restoration, not an Agent run',
		)
		releaseHistoryLoad!()
		await waitFor(
			() => first.getSnapshot().id === 'old-history' && !first.getSnapshot().isHistoryLoading,
		)
		WorkspaceHistory.prototype.load = originalHistoryLoad
		await waitFor(() => !button(container, '模型设置').disabled)
		const oldList = await first.listHistory()
		const listHistory = first.listHistory.bind(first)
		let resolveOldList: (value: WorkspaceHistorySummary[]) => void = missingListResolver
		let listStarted = false
		first.listHistory = () =>
			new Promise((resolve) => {
				listStarted = true
				resolveOldList = resolve
			})
		button(document, '刷新会话列表').click()
		await waitFor(() => listStarted)
		await closeHistory(container)
		await openSettings(container)
		fill(input('API Key'), 'unsubmitted-old-secret')
		root.render(createElement(AgentWorkspace, { session: second }))
		await waitFor(
			() =>
				!document.body.textContent?.includes('Private prior history') &&
				!document.querySelector(settingsFormSelector),
		)
		assert(
			[...document.querySelectorAll<HTMLInputElement>('input[type="password"]')].every(
				(element) => element.value !== 'unsubmitted-old-secret',
			),
			'Session replacement left an old secret in a portaled settings form',
		)
		await openSettings(container)
		assert(
			input('API Key').value === '' && input('模型 ID').value === 'new-model',
			'Session replacement retained an old draft or model',
		)
		button(document, '取消').click()
		await waitFor(() => !document.querySelector(settingsFormSelector))
		// A pending confirmation keeps other dialogs closed. Retire its owner in
		// a separate pass, while the first owner's deferred list remains unresolved.
		first.listHistory = listHistory
		root.render(createElement(AgentWorkspace, { session: first }))
		await waitFor(() => !!container.querySelector('[aria-label="模型设置"]'))
		await openHistory(container)
		await waitFor(() => !!document.querySelector('[aria-label="Private prior history的更多操作"]'))
		const deleteHistory = first.deleteHistory.bind(first)
		let resolveOldDelete: () => void = missingListResolver
		let deletionStarted = false
		first.deleteHistory = async (id) => {
			await new Promise<void>((resolve) => {
				deletionStarted = true
				resolveOldDelete = resolve
			})
			await deleteHistory(id)
		}
		const oldHistoryMore = button(document, 'Private prior history的更多操作')
		oldHistoryMore.focus()
		oldHistoryMore.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
		)
		await waitFor(() => !!document.querySelector('[role="menuitem"]'))
		const deletion = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
			(element) => element.textContent?.trim() === '删除',
		)
		assert(deletion, 'Missing old history deletion menu action')
		deletion.click()
		await waitFor(() => !!document.querySelector('[role="alertdialog"]'))
		button(document, '删除本地会话').click()
		await waitFor(() => deletionStarted)
		root.render(createElement(AgentWorkspace, { session: second }))
		await waitFor(
			() =>
				!document.body.textContent?.includes('Private prior history') &&
				!document.querySelector('[role="alertdialog"]'),
		)
		await openSettings(container)
		assert(
			input('API Key').value === '' && input('模型 ID').value === 'new-model',
			'A pending deletion retained the previous owner model settings',
		)
		resolveOldList(oldList)
		resolveOldDelete()
		await pause(100)
		assert(
			!document.body.textContent?.includes('Private prior history') &&
				input('Base URL').value === 'https://new-provider.example/v1',
			'A retired history callback rewrote the new view',
		)
		button(document, '取消').click()
		await waitFor(() => !document.querySelector(settingsFormSelector))
		await openHistory(container)
		await pause(20)
		assert(
			!document.body.textContent?.includes('Private prior history'),
			'Current history revealed another scope',
		)
		assert(
			!JSON.stringify(second.getSnapshot()).includes('new-memory-key'),
			'Model key entered the React snapshot',
		)
	} finally {
		WorkspaceHistory.prototype.load = originalHistoryLoad
		releaseHistoryLoad?.()
		root.unmount()
		container.remove()
		first.dispose()
		second.dispose()
		history.close()
	}
	return {
		name: 'React provider catalog, model search, custom protocol and private scoped settings/history',
		durationMs: Math.round(performance.now() - started),
	}
}
