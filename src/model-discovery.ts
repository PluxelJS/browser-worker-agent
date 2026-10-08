import { validateModelBaseUrl } from './models.ts'

export type DiscoveredModel = { id: string; name: string; contextWindow?: number }
export type ModelDiscoverySettings = { api: string; baseUrl: string; apiKey: string }

export function supportsModelDiscovery(api: string): boolean {
	return ['openai-responses', 'openai-completions', 'anthropic-messages'].includes(api)
}

/** Discover IDs, never infer protocol support or tool capabilities from a models listing. */
export async function discoverModels(
	settings: ModelDiscoverySettings,
	signal?: AbortSignal,
): Promise<readonly DiscoveredModel[]> {
	if (!supportsModelDiscovery(settings.api))
		throw new Error('此协议暂不支持在线获取模型；请使用参考目录或手动填写模型 ID。')
	signal?.throwIfAborted()
	const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)])
	const key = settings.apiKey.trim()
	if (!key) throw new Error('请先填写 API Key，再获取此账户可用的模型。')
	if (/[{}]|%7[bBdD]/i.test(settings.baseUrl))
		throw new Error(
			'此供应商的地址需要运行时参数，暂不支持在线获取；请使用参考目录或手动填写模型 ID。',
		)
	const base = validateModelBaseUrl(settings.baseUrl)
	const anthropic = settings.api === 'anthropic-messages'
	const url = new URL(`${base}${anthropic && !base.endsWith('/v1') ? '/v1' : ''}/models`)
	const headers: Record<string, string> = anthropic
		? {
				'x-api-key': key,
				'anthropic-version': '2023-06-01',
				'anthropic-dangerous-direct-browser-access': 'true',
			}
		: { Authorization: `Bearer ${key}` }
	if (anthropic) url.searchParams.set('limit', '1000')
	const result = new Map<string, DiscoveredModel>()
	const cursors = new Set<string>()
	for (let page = 0; page < 20; page++) {
		requestSignal.throwIfAborted()
		// Pagination depends on the previous response cursor.
		// eslint-disable-next-line no-await-in-loop
		const response = await fetch(url, {
			headers,
			signal: requestSignal,
			credentials: 'omit',
			redirect: 'error',
		})
		if (!response.ok)
			throw new Error(
				`获取模型失败（HTTP ${response.status}）；请检查密钥、地址及服务权限，也可手动填写。`,
			)
		// Decode this page before deciding whether another page exists.
		// eslint-disable-next-line no-await-in-loop
		const body: unknown = await response.json().catch(() => {
			throw new Error('模型接口未返回有效 JSON；请检查 Base URL 或手动填写模型 ID。')
		})
		if (!body || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data))
			throw new Error('模型接口没有返回有效的 data 列表；请手动填写模型 ID。')
		for (const row of body.data) {
			if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id.trim()) continue
			const id = row.id.trim()
			if (id.length > 512) continue
			const context = row.max_input_tokens ?? row.context_length
			result.set(id, {
				id,
				name:
					typeof row.display_name === 'string'
						? row.display_name
						: typeof row.name === 'string'
							? row.name
							: id,
				...(Number.isInteger(context) && context >= 1024 && context <= 2_000_000
					? { contextWindow: context }
					: {}),
			})
		}
		if (!anthropic || !('has_more' in body) || body.has_more !== true)
			return [...result.values()].toSorted((a, b) => a.name.localeCompare(b.name))
		const cursor = 'last_id' in body ? body.last_id : undefined
		if (typeof cursor !== 'string' || !cursor || cursors.has(cursor))
			throw new Error('模型接口返回重复或无效的分页游标；请稍后重试。')
		cursors.add(cursor)
		url.searchParams.set('after_id', cursor)
	}
	throw new Error('模型列表超过分页上限；请手动填写模型 ID。')
}
