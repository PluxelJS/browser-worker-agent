import { createContext, memo, useContext } from 'react'
import { StreamdownTextPrimitive, type SecurityConfig } from '@assistant-ui/react-streamdown'
import { code as shiki } from '@streamdown/code'
import { cjk } from '@streamdown/cjk'
import {
	CodeBlock as StreamdownCodeBlock,
	CodeBlockCopyButton,
	CodeBlockDownloadButton,
	Streamdown,
	type BlockProps,
	type CodeHighlighterPlugin,
	type StreamdownProps,
} from 'streamdown'
import { useWorkspacePortalContainer } from './lib/portal-scope.tsx'

// Keep the native renderer and controls for large payloads, but skip Shiki's
// syntax tokenization. Returning the current plain tokens also replaces a
// previous highlighted result when a streamed fence crosses this threshold.
const nativeCode: CodeHighlighterPlugin = shiki
const boundedCode: CodeHighlighterPlugin = {
	...nativeCode,
	highlight(options, callback) {
		if (options.code.length > 8_000) {
			return {
				bg: 'transparent',
				fg: 'inherit',
				tokens: [[{ content: options.code, color: 'inherit' }]],
			}
		}
		return nativeCode.highlight(options, callback)
	},
}

const plugins = { code: boundedCode, cjk }
const translations = {
	copyCode: '复制代码',
	copied: '已复制',
	downloadFile: '下载文件',
	copyTable: '复制表格',
	copyTableAsMarkdown: '复制为 Markdown',
	copyTableAsCsv: '复制为 CSV',
	copyTableAsTsv: '复制为 TSV',
	downloadTable: '下载表格',
	downloadTableAsCsv: '下载为 CSV',
	downloadTableAsMarkdown: '下载为 Markdown',
	viewFullscreen: '全屏查看',
	exitFullscreen: '退出全屏',
	imageNotAvailable: '图片无法加载',
	downloadImage: '下载图片',
	close: '关闭',
}
const displayProps = {
	plugins,
	translations,
	codeBlockMaxHeight: '24rem',
	lineNumbers: false,
	linkSafety: { enabled: false },
	// Prevent raw HTML from entering Streamdown's rehype-raw pipeline at all.
	remarkRehypeOptions: { allowDangerousHtml: false },
	skipHtml: true,
} satisfies StreamdownProps
const security: SecurityConfig = {
	allowedProtocols: ['http:', 'https:', 'irc:', 'ircs:', 'mailto:', 'xmpp:'],
	allowDataImages: false,
	// Keep ordinary relative Markdown links usable with native URL hardening.
	defaultOrigin: globalThis.location?.origin,
}

/** Native block-aware parsing and deferred updates from the active text part. */
export function MarkdownText() {
	const portal = useWorkspacePortalContainer()
	return (
		<StreamdownTextPrimitive
			{...displayProps}
			portal={portal}
			containerClassName="agent-workspace-markdown"
			security={security}
			defer
		/>
	)
}

const CodeLanguageContext = createContext('javascript')
const singleCodeBlock = (source: string) => [source]

function ReadOnlyCodeBlock({ content }: BlockProps) {
	const language = useContext(CodeLanguageContext)
	return (
		<StreamdownCodeBlock code={content} language={language} lineNumbers={false}>
			<CodeBlockDownloadButton language={language} />
			<CodeBlockCopyButton />
		</StreamdownCodeBlock>
	)
}

/** Native code slots under Streamdown's theme/plugin/translation providers.
 * The public block parser bypasses Markdown entirely, preserving embedded
 * fences, HTML and exact clipboard text without interpreting tool output.
 */
export const CodeBlock = memo(function CodeBlock({
	code,
	language = 'javascript',
}: {
	code: string
	language?: string
}) {
	const portal = useWorkspacePortalContainer()
	return (
		<CodeLanguageContext value={language}>
			<Streamdown
				{...displayProps}
				portal={portal}
				className="agent-workspace-code-block"
				parseMarkdownIntoBlocksFn={singleCodeBlock}
				BlockComponent={ReadOnlyCodeBlock}
				parseIncompleteMarkdown={false}
				isAnimating={false}
			>
				{code}
			</Streamdown>
		</CodeLanguageContext>
	)
})
