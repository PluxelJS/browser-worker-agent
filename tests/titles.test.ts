import { afterEach, expect, it, vi } from 'vitest'
import {
	createModels,
	fauxProvider,
	fauxAssistantMessage,
	fauxThinking,
	fauxToolCall,
} from '@earendil-works/pi-ai'
import {
	fallbackConversationTitle,
	generateConversationTitle,
	normalizeGeneratedTitle,
	TITLE_LIMITS,
} from '../src/titles.ts'

function fixture() {
	const faux = fauxProvider({ tokensPerSecond: 100_000 })
	const models = createModels()
	models.setProvider(faux.provider)
	return {
		faux,
		models,
		options: {
			models,
			model: faux.getModel(),
			apiKey: 'title-key',
			env: { TITLE_TEST_ENV: 'test' },
			userIntent: '请整理投票设置。',
			finalResponse: '已经确认投票的配置与校验方式。',
			signal: new AbortController().signal,
		},
	}
}

afterEach(() => {
	vi.restoreAllMocks()
	vi.useRealTimers()
})

it('generates a title from bounded excerpts without exposing tools', async () => {
	const { faux, models, options } = fixture()
	const complete = vi.spyOn(models, 'completeSimple')
	faux.setResponses([fauxAssistantMessage('投票配置整理')])
	await expect(
		generateConversationTitle({
			...options,
			userIntent: 'u'.repeat(TITLE_LIMITS.userCharacters + 100),
			finalResponse: 'a'.repeat(TITLE_LIMITS.answerCharacters + 100),
		}),
	).resolves.toBe('投票配置整理')
	const context = complete.mock.calls[0]![1]
	expect(context.tools).toEqual([])
	expect(context.messages).toHaveLength(1)
	expect(JSON.parse(context.messages[0]!.content as string)).toEqual({
		userIntent: 'u'.repeat(TITLE_LIMITS.userCharacters),
		finalResponse: 'a'.repeat(TITLE_LIMITS.answerCharacters),
	})
})

it.each([
	['"Title: Inspect draft"', 'Inspect draft'],
	['标题：投票草稿设置', '投票草稿设置'],
	['  「整理工单」  ', '整理工单'],
	['First title\nExtra explanation', undefined],
	['```js\nreturn api.value()\n```', undefined],
	['{"title":"tool output"}', undefined],
	['   ', undefined],
])('normalizes a standalone title %s', (input, expected) => {
	expect(normalizeGeneratedTitle(input!)).toBe(expected)
})

it('bounds generated and fallback titles without splitting a surrogate pair', () => {
	expect(normalizeGeneratedTitle('x'.repeat(100))).toHaveLength(TITLE_LIMITS.characters)
	expect(fallbackConversationTitle('  one\n two\tthree  ')).toBe('one two three')
	expect(fallbackConversationTitle('x'.repeat(39) + '😀')).toBe('x'.repeat(39))
	expect(normalizeGeneratedTitle('x'.repeat(39) + '😀')).toBe('x'.repeat(39))
})

it.each(['error', 'tools', 'thinking'])(
	'keeps failures and unsupported %s results optional without retry',
	async (outcome) => {
		const { faux, options } = fixture()
		faux.setResponses([
			outcome === 'error'
				? fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Unavailable' })
				: outcome === 'tools'
					? fauxAssistantMessage(fauxToolCall('runJavaScript', { code: 'return api.write()' }), {
							stopReason: 'toolUse',
						})
					: fauxAssistantMessage(fauxThinking('Private reasoning')),
		])
		await expect(generateConversationTitle(options)).resolves.toBeUndefined()
		expect(faux.state.callCount).toBe(1)
	},
)

it('cancels even when the provider never settles its result promise', async () => {
	const { models, options } = fixture()
	const complete = vi
		.spyOn(models, 'completeSimple')
		.mockImplementation(() => new Promise(() => {}))
	const controller = new AbortController()
	const result = generateConversationTitle({ ...options, signal: controller.signal })
	controller.abort()
	await expect(result).resolves.toBeUndefined()
	expect(complete.mock.calls[0]![2]!.signal!.aborted).toBe(true)
})

it('enforces its own short deadline when native provider timeout is ignored', async () => {
	vi.useFakeTimers()
	const { models, options } = fixture()
	const complete = vi
		.spyOn(models, 'completeSimple')
		.mockImplementation(() => new Promise(() => {}))
	const result = generateConversationTitle(options)
	await vi.advanceTimersByTimeAsync(TITLE_LIMITS.timeoutMs)
	await expect(result).resolves.toBeUndefined()
	expect(complete.mock.calls[0]![2]!.signal!.aborted).toBe(true)
	expect(complete).toHaveBeenCalledOnce()
})
