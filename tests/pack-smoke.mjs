import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'
import assert from 'node:assert/strict'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'agent-workspace-pack-'))
const artifact = join(temporary, 'agent-workspace.tgz')
const reactArtifact = join(temporary, 'agent-react.tgz')
const uiArtifact = join(temporary, 'agent-ui.tgz')
const app = join(temporary, 'consumer')
const nativeApp = join(temporary, 'native-consumer')
const renderedPackages = [
	'@assistant-ui/react-streamdown',
	'streamdown',
	'@streamdown/code',
	'@streamdown/cjk',
]
async function command(program, args, cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn(program, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
		let output = ''
		child.stdout.on('data', (chunk) => {
			output += chunk
		})
		child.stderr.on('data', (chunk) => {
			output += chunk
		})
		child.on('error', reject)
		child.on('close', (code) =>
			code === 0
				? resolve(output)
				: reject(new Error(`${program} ${args.join(' ')} exited ${code}:\n${output}`)),
		)
	})
}

async function writeConsumerWorkspace(root) {
	await writeFile(
		join(root, 'pnpm-workspace.yaml'),
		`overrides:
  '@pluxel/browser-worker-agent': 'file:${artifact}'
  '@pluxel/browser-worker-agent-react': 'file:${reactArtifact}'
`,
	)
}

async function assertOpaqueSurface(surface, description) {
	assert.equal(
		await surface.evaluate((element) => {
			const canvas = document.createElement('canvas')
			canvas.width = canvas.height = 1
			const context = canvas.getContext('2d')
			context.fillStyle = getComputedStyle(element).backgroundColor
			context.fillRect(0, 0, 1, 1)
			return context.getImageData(0, 0, 1, 1).data[3]
		}),
		255,
		description,
	)
}

async function assertHeaderContext(page) {
	const header = page.locator('.agent-workspace-toolbar')
	const budget = header.getByRole('progressbar', { name: '上下文估算', exact: true })
	assert(await budget.isVisible(), 'the packed conversation shows its budget in the header')
	const values = (await budget.getAttribute('aria-valuetext'))?.match(/\d[\d,]*/g)
	const visibleText = await header.locator('.agent-workspace-context-usage').textContent()
	assert(values?.length >= 2 && visibleText.includes(values[0]) && visibleText.includes(values[1]))
	assert.equal(await page.locator('.agent-workspace-composer').getByRole('progressbar').count(), 0)
}

async function assertNoHeroUiConsumer(consumer) {
	const requireFromApp = createRequire(join(consumer, 'package.json'))
	for (const dependency of ['@heroui/react', '@heroui/styles'])
		assert.throws(() => requireFromApp.resolve(dependency), { code: 'MODULE_NOT_FOUND' })
	assert(
		!(await readdir(join(consumer, 'node_modules/.pnpm'))).some((name) =>
			name.startsWith('@heroui+'),
		),
		'the independent consumer dependency graph must not install any HeroUI package',
	)
	const manifest = JSON.parse(
		await readFile(
			join(consumer, 'node_modules/@pluxel/browser-worker-agent/package.json'),
			'utf8',
		),
	)
	for (const section of [
		'dependencies',
		'devDependencies',
		'peerDependencies',
		'peerDependenciesMeta',
	])
		assert(
			!Object.keys(manifest[section] ?? {}).some((name) => name.startsWith('@heroui/')),
			`the published library must not declare HeroUI in ${section}`,
		)
	assert.equal(manifest.exports['./heroui'], undefined)
	assert.equal(manifest.exports['./heroui/styles.css'], undefined)
	assert.equal(manifest.exports['./styles.css'], undefined)
	for (const dependency of renderedPackages) {
		assert.equal(manifest.dependencies?.[dependency], undefined)
		assert.equal(manifest.peerDependencies?.[dependency], undefined)
		assert.throws(() => requireFromApp.resolve(dependency), { code: 'MODULE_NOT_FOUND' })
	}
	return { requireFromApp, manifest }
}

async function checkCoreConsumer() {
	const root = join(temporary, 'core-consumer')
	await mkdir(root)
	await writeFile(
		join(root, 'package.json'),
		JSON.stringify({
			name: 'independent-core-consumer',
			private: true,
			type: 'module',
			dependencies: {
				'@pluxel/browser-worker-agent': `file:${artifact}`,
				capnweb: '0.12.0',
				'@earendil-works/pi-ai': '1.1.0',
			},
			devDependencies: { vite: '8.3.1' },
		}),
	)
	await writeFile(join(root, '.npmrc'), 'auto-install-peers=false\n')
	await command('pnpm', ['install', '--ignore-scripts'], root)
	const graph = await readdir(join(root, 'node_modules/.pnpm'))
	assert(
		!graph.some((name) =>
			/^(react@|react-dom@|radix-ui@|lucide-react@|@assistant-ui\+|streamdown@|@streamdown\+)/.test(
				name,
			),
		),
		'a core-only install must not install presentation dependencies',
	)
	await command(
		'node',
		[
			'--input-type=module',
			'-e',
			"import { runJavaScript } from '@pluxel/browser-worker-agent/execution'; if (typeof runJavaScript !== 'function') throw new Error('missing executor')",
		],
		root,
	)
	await writeFile(
		join(root, 'index.html'),
		'<!doctype html><html><body><script type="module" src="./main.js"></script></body></html>',
	)
	await writeFile(
		join(root, 'main.js'),
		`
import {runJavaScript} from '@pluxel/browser-worker-agent/execution';
import {RpcTarget,RpcStub} from 'capnweb';
class Api extends RpcTarget { async readDto(){return {revision:7}} }
const host=new RpcStub(new Api());
Object.assign(window,{runCoreSmoke:async()=>{
  let released=0;
  const record=await runJavaScript({code:'return await api.readDto();',acquireApi(){const api=host.dup();return {api,release(){released++;api[Symbol.dispose]()}}}});
  return {record,released,shared:await host.readDto()};
}});
`,
	)
	const requireFromCore = createRequire(join(root, 'package.json'))
	const vite = await import(requireFromCore.resolve('vite'))
	const coreBrowser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
	try {
		// No library plugin, alias, worker factory or optimizeDeps workaround in either mode.
		const development = await vite.createServer({
			configFile: false,
			root,
			base: '/agent/',
			server: { host: '127.0.0.1', port: 0 },
		})
		try {
			await development.listen()
			await assertCoreWorker(coreBrowser, development.httpServer.address().port, 'development')
		} finally {
			await development.close()
		}
		await vite.build({ configFile: false, root, base: '/agent/' })
		const production = await vite.preview({
			configFile: false,
			root,
			base: '/agent/',
			preview: { host: '127.0.0.1', port: 0 },
		})
		try {
			await assertCoreWorker(coreBrowser, production.httpServer.address().port, 'production')
		} finally {
			await new Promise((resolve) => production.httpServer.close(resolve))
		}
		await checkPiCatalogDevelopment(root, vite, coreBrowser)
	} finally {
		await coreBrowser.close()
	}
	console.log(
		'CORE PACK ACCEPTED: standalone execution, Vite dev and nested-base production Worker RPC, no presentation packages',
	)
}

async function checkPiCatalogDevelopment(root, vite, browser) {
	await writeFile(
		join(root, 'catalog.html'),
		'<!doctype html><html><body><script type="module" src="./catalog.js"></script></body></html>',
	)
	await writeFile(
		join(root, 'catalog.js'),
		`
import {createAgentSession} from '@pluxel/browser-worker-agent';
import {builtinModels} from '@earendil-works/pi-ai/providers/all';
const models=builtinModels({authContext:{env:async()=>undefined,fileExists:async()=>false}});
const session=createAgentSession({scopeKey:'packed-catalog',titleGeneration:false,documents:[],acquireApi(){throw new Error('Catalog reads cannot acquire RPC')}});
Object.assign(window,{catalogSmoke:{providers:models.getProviders().map(provider=>provider.id),sessionProviders:session.getModelProviders().map(provider=>provider.id)}});
session.dispose();
`,
	)
	await writeFile(
		join(root, 'vite.config.mjs'),
		"import { browserWorkerAgent } from '@pluxel/browser-worker-agent/vite'; export default { plugins: [browserWorkerAgent()] };",
	)
	const warnings = []
	const logger = vite.createLogger('silent')
	logger.warn = (message) => warnings.push(message)
	const development = await vite.createServer({
		configFile: join(root, 'vite.config.mjs'),
		root,
		base: '/agent/',
		customLogger: logger,
		ssr: { noExternal: ['@earendil-works/pi-ai'] },
		server: { host: '127.0.0.1', port: 0 },
	})
	const page = await browser.newPage()
	const errors = []
	const requests = []
	page.on('pageerror', (error) => errors.push(error.message))
	page.on('request', (request) => requests.push(request.url()))
	try {
		await development.listen()
		// The same Vite server must preserve pi's Node environment lookup for SSR.
		const serverEnvironment = await development.ssrLoadModule(
			join(root, 'node_modules/@earendil-works/pi-ai/dist/utils/provider-env.js'),
		)
		assert.equal(serverEnvironment.getProviderEnvValue('PATH'), process.env.PATH)
		await page.goto(`http://127.0.0.1:${development.httpServer.address().port}/agent/catalog.html`)
		await page.waitForFunction(() => !!window.catalogSmoke)
		const result = await page.evaluate(() => window.catalogSmoke)
		assert.equal(
			result.providers.length,
			42,
			'the unpatched pi 1.0 package exposes its full built-in catalog',
		)
		assert(
			result.sessionProviders.includes('openai') && result.sessionProviders.includes('deepseek'),
		)
		assert.deepEqual(errors, [])
		assert(
			!warnings.some((warning) =>
				/cannot be analyzed|import-analysis|dynamic import/i.test(warning),
			),
			warnings.join('\n'),
		)
		assert(
			!requests.some((url) => /node:|node%3A|@aws-sdk|%40aws-sdk/i.test(url)),
			JSON.stringify(requests),
		)
		console.log(
			'PI CATALOG DEV ACCEPTED: packed Vite plugin, unpatched pi, full catalog, no Node-only requests or import-analysis warnings',
		)
	} finally {
		await page.close()
		await development.close()
	}
}

async function assertCoreWorker(browser, port, mode) {
	const page = await browser.newPage()
	const errors = []
	const workers = []
	page.on('pageerror', (error) => errors.push(error.message))
	page.on('worker', (worker) => workers.push(worker.url()))
	try {
		await page.goto(`http://127.0.0.1:${port}/agent/`)
		await page.waitForFunction(() => typeof window.runCoreSmoke === 'function')
		const result = await page.evaluate(() => window.runCoreSmoke())
		assert.equal(result.record.status, 'completed', `${mode}: ${JSON.stringify(result)}`)
		assert.deepEqual(result.record.value, { revision: 7 })
		assert.deepEqual(result.shared, { revision: 7 }, 'the host stub survives execution cleanup')
		assert.equal(result.released, 1, 'the execution lease is released once')
		assert.equal(workers.length, 1, 'the default factory starts a real browser Worker')
		assert(new URL(workers[0]).pathname.startsWith('/agent/'), workers[0])
		assert.deepEqual(errors, [], mode)
	} finally {
		await page.close()
	}
}

async function checkNativeConsumer() {
	await mkdir(nativeApp)
	await writeConsumerWorkspace(nativeApp)
	await writeFile(
		join(nativeApp, 'package.json'),
		JSON.stringify(
			{
				name: 'independent-native-agent-workspace-consumer',
				private: true,
				type: 'module',
				dependencies: {
					'@pluxel/browser-worker-agent': `file:${artifact}`,
					'@pluxel/browser-worker-agent-react': `file:${reactArtifact}`,
					'@earendil-works/pi-ai': '1.1.0',
					'@assistant-ui/react': '0.15.23',
					react: '19.3.0',
					'react-dom': '19.3.0',
					capnweb: '0.12.0',
				},
				devDependencies: {
					vite: '8.3.1',
					typescript: '7.0.2',
					'@types/react': '19.3.0',
					'@types/react-dom': '19.3.0',
				},
			},
			null,
			2,
		),
	)
	// This sibling owns its dependencies and must not inherit the other consumer's UI.
	await writeFile(join(nativeApp, '.npmrc'), 'auto-install-peers=false\n')
	await writeFile(
		join(nativeApp, 'index.html'),
		'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
	)
	await writeFile(
		join(nativeApp, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				target: 'ES2023',
				module: 'ESNext',
				moduleResolution: 'bundler',
				strict: true,
				jsx: 'react-jsx',
				lib: ['ES2023', 'DOM', 'ESNext.Disposable'],
				types: ['vite/client'],
				skipLibCheck: true,
				noEmit: true,
			},
			include: ['main.tsx'],
		}),
	)
	await writeFile(
		join(nativeApp, 'main.tsx'),
		`
import {createRoot} from 'react-dom/client';
import {createAgentSession} from '@pluxel/browser-worker-agent';
import {AgentWorkspaceProvider,useAgentWorkspace} from '@pluxel/browser-worker-agent-react';
import {ThreadPrimitive,MessagePrimitive,ComposerPrimitive,ThreadListPrimitive,ThreadListItemPrimitive} from '@assistant-ui/react';
import {createModels,fauxProvider,fauxAssistantMessage} from '@earendil-works/pi-ai';
const faux=fauxProvider({tokensPerSecond:10000});const models=createModels();models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage('native first reply'),fauxAssistantMessage('native second reply')]);
let acquisitions=0;
const session=createAgentSession({scopeKey:'native-independent-consumer',titleGeneration:false,model:faux.getModel(),models,documents:[],acquireApi(){acquisitions++;throw new Error('Native conversation checks must not acquire an RPC capability')}});
function Message(){return <MessagePrimitive.Root><MessagePrimitive.Content/></MessagePrimitive.Root>}
function Conversation(){return <ThreadListItemPrimitive.Root><ThreadListItemPrimitive.Trigger><ThreadListItemPrimitive.Title/></ThreadListItemPrimitive.Trigger></ThreadListItemPrimitive.Root>}
function Workspace(){
  const {session:providedSession,snapshot,messages,history,runtime}=useAgentWorkspace();
  if(providedSession!==session||!runtime.thread)throw new Error('Generic provider did not expose its native session/runtime');
  return <>
    <output data-testid="current-id">{snapshot.id}</output>
    <output data-testid="display-messages">{messages.length}</output>
    <output data-testid="stored-conversations">{history.items.length}</output>
    <ThreadListPrimitive.Root aria-label="会话列表">
      <ThreadListPrimitive.New aria-label="新会话">新会话</ThreadListPrimitive.New>
      <ThreadListPrimitive.Items components={{ThreadListItem:Conversation}}/>
    </ThreadListPrimitive.Root>
    <ThreadPrimitive.Root>
      <ThreadPrimitive.Viewport><ThreadPrimitive.Messages components={{UserMessage:Message,AssistantMessage:Message}}/></ThreadPrimitive.Viewport>
      <ComposerPrimitive.Root>
        <ComposerPrimitive.Input aria-label="消息"/>
        <ComposerPrimitive.Send aria-label="发送">发送</ComposerPrimitive.Send>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  </>
}
createRoot(document.getElementById('root')!).render(<AgentWorkspaceProvider session={session}><Workspace/></AgentWorkspaceProvider>);
Object.assign(window,{peekNative:()=>({id:session.getSnapshot().id,isRunning:session.getSnapshot().isRunning,saveState:session.getSnapshot().historySaveState,title:session.getSnapshot().title,modelCalls:faux.state.callCount,acquisitions}),nativeHistory:()=>session.listHistory()});
`,
	)
	console.log('Installing the generic React entry without HeroUI in a sibling temporary consumer.')
	await command('pnpm', ['install', '--ignore-scripts'], nativeApp)
	const { requireFromApp, manifest } = await assertNoHeroUiConsumer(nativeApp)
	assert.equal(manifest.exports['./react'], undefined)
	const typeResolution = await command(
		'pnpm',
		['exec', 'tsc', '--noEmit', '--traceResolution'],
		nativeApp,
	)
	assert.doesNotMatch(
		typeResolution,
		/Resolving module ['"](?:@heroui\/|@streamdown\/|streamdown['"/]|@assistant-ui\/react-(?:streamdown|markdown)|react-syntax-highlighter|[^'"\n]+\.css(?:['"]|\?))/,
		'generic React declarations must not resolve display renderers, HeroUI or CSS',
	)
	const vite = await import(requireFromApp.resolve('vite'))
	await vite.build({
		configFile: false,
		root: nativeApp,
		plugins: [
			{
				name: 'generic-entry-dependency-boundary',
				resolveId(source) {
					assert.doesNotMatch(
						source,
						/@heroui\/|@streamdown\/|(?:^|\/)streamdown(?:\/|$)|@assistant-ui\/react-(?:streamdown|markdown)|react-syntax-highlighter|\.css(?:$|\?)/,
					)
				},
			},
		],
	})
	assert(
		!(await readdir(join(nativeApp, 'dist/assets'))).some((name) => name.endsWith('.css')),
		'the generic React build must not emit presentation CSS',
	)
	let nativeServer, nativeBrowser
	try {
		nativeServer = await vite.preview({
			configFile: false,
			root: nativeApp,
			preview: { host: '127.0.0.1', port: 0 },
		})
		nativeBrowser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
		const page = await nativeBrowser.newPage()
		const errors = []
		page.on('pageerror', (error) => errors.push(error.message))
		await page.goto(`http://127.0.0.1:${nativeServer.httpServer.address().port}`)
		await page.waitForFunction(() => typeof window.peekNative === 'function')
		const composer = page.getByRole('textbox', { name: '消息', exact: true })
		await composer.fill('native first')
		await page.getByRole('button', { name: '发送', exact: true }).click()
		await page.getByText('native first reply', { exact: true }).waitFor()
		await page.waitForFunction(
			() => !window.peekNative().isRunning && window.peekNative().saveState === 'saved',
		)
		const first = await page.evaluate(() => window.peekNative())
		assert.equal(first.modelCalls, 1)
		assert.equal(first.acquisitions, 0)
		assert.equal(await page.getByTestId('display-messages').textContent(), '2')
		await composer.fill('native first draft')
		await page.getByRole('button', { name: '新会话', exact: true }).click()
		await page.waitForFunction((id) => window.peekNative().id !== id, first.id)
		assert.equal(
			await composer.inputValue(),
			'',
			'a native new thread starts with its own composer',
		)
		await composer.fill('native second')
		await page.getByRole('button', { name: '发送', exact: true }).click()
		await page.getByText('native second reply', { exact: true }).waitFor()
		await page.waitForFunction(
			() => !window.peekNative().isRunning && window.peekNative().saveState === 'saved',
		)
		const second = await page.evaluate(() => window.peekNative())
		assert.equal(second.modelCalls, 2)
		assert.notEqual(first.id, second.id)
		await composer.fill('native second draft')
		await page.getByRole('button', { name: first.title, exact: true }).click()
		await page.waitForFunction((id) => window.peekNative().id === id, first.id)
		assert.equal(
			await composer.inputValue(),
			'native first draft',
			'native thread switching restores the first draft',
		)
		await page.getByRole('button', { name: second.title, exact: true }).click()
		await page.waitForFunction((id) => window.peekNative().id === id, second.id)
		assert.equal(
			await composer.inputValue(),
			'native second draft',
			'native thread switching restores the second draft',
		)
		assert.equal((await page.evaluate(() => window.peekNative())).modelCalls, 2)
		assert.equal((await page.evaluate(() => window.nativeHistory())).length, 2)
		await page.reload()
		await page.waitForFunction(() => typeof window.peekNative === 'function')
		await page.getByRole('button', { name: first.title, exact: true }).click()
		await page.waitForFunction((id) => window.peekNative().id === id, first.id)
		await page.getByText('native first reply', { exact: true }).waitFor()
		assert.equal(await page.getByText('native second reply', { exact: true }).count(), 0)
		assert.equal(
			await composer.inputValue(),
			'',
			'unsent drafts remain in memory across page reloads',
		)
		await composer.fill('reloaded first draft')
		await page.getByRole('button', { name: second.title, exact: true }).click()
		await page.waitForFunction((id) => window.peekNative().id === id, second.id)
		await page.getByText('native second reply', { exact: true }).waitFor()
		assert.equal(await composer.inputValue(), '')
		await composer.fill('reloaded second draft')
		await page.getByRole('button', { name: first.title, exact: true }).click()
		await page.waitForFunction((id) => window.peekNative().id === id, first.id)
		assert.equal(await composer.inputValue(), 'reloaded first draft')
		await page.getByRole('button', { name: second.title, exact: true }).click()
		await page.waitForFunction((id) => window.peekNative().id === id, second.id)
		assert.equal(await composer.inputValue(), 'reloaded second draft')
		const restored = await page.evaluate(() => window.peekNative())
		assert.equal(
			restored.modelCalls,
			0,
			'native reload and thread switches never replay the provider',
		)
		assert.equal(
			restored.acquisitions,
			0,
			'native reload and thread switches never acquire RPC capabilities',
		)
		assert.equal(await page.getByTestId('stored-conversations').textContent(), '2')
		assert.deepEqual(errors, [])
		console.log(
			'NATIVE REACT PACK ACCEPTED',
			JSON.stringify({
				consumer: nativeApp,
				heroUiInstalled: false,
				typeAndBuildResolveHeroUiOrCss: false,
				primitives: ['Thread', 'Message', 'Composer', 'ThreadList'],
				checks: [
					'send',
					'native new thread',
					'draft isolation',
					'IndexedDB page reload',
					'native thread restore',
					'no provider or RPC replay',
				],
			}),
		)
	} finally {
		await nativeBrowser?.close()
		if (nativeServer) await new Promise((resolve) => nativeServer.httpServer.close(resolve))
	}
}

let server, browser
try {
	await command('pnpm', ['build:all'], packageRoot)
	await command('pnpm', ['pack', '--out', artifact], packageRoot)
	await command('pnpm', ['pack', '--out', reactArtifact], join(packageRoot, 'packages/react'))
	await command('pnpm', ['pack', '--out', uiArtifact], join(packageRoot, 'packages/ui'))
	await checkCoreConsumer()
	await checkNativeConsumer()
	await mkdir(app)
	await writeConsumerWorkspace(app)
	await writeFile(
		join(app, 'package.json'),
		JSON.stringify(
			{
				name: 'independent-agent-workspace-consumer',
				private: true,
				type: 'module',
				dependencies: {
					'@pluxel/browser-worker-agent': `file:${artifact}`,
					'@pluxel/browser-worker-agent-react': `file:${reactArtifact}`,
					'@pluxel/browser-worker-agent-ui': `file:${uiArtifact}`,
					'@earendil-works/pi-ai': '1.1.0',
					'@assistant-ui/react': '0.15.23',
					react: '19.3.0',
					'react-dom': '19.3.0',
					capnweb: '0.12.0',
				},
				devDependencies: {
					vite: '8.3.1',
					tailwindcss: '4.3.3',
					'@tailwindcss/vite': '4.3.3',
					typescript: '7.0.2',
					'@types/react': '19.3.0',
					'@types/react-dom': '19.3.0',
				},
			},
			null,
			2,
		),
	)
	await writeFile(join(app, '.npmrc'), 'auto-install-peers=false\n')
	await writeFile(
		join(app, 'index.html'),
		'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
	)
	await writeFile(
		join(app, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				target: 'ES2023',
				module: 'ESNext',
				moduleResolution: 'bundler',
				strict: true,
				jsx: 'react-jsx',
				lib: ['ES2023', 'DOM', 'ESNext.Disposable'],
				types: ['vite/client'],
				skipLibCheck: true,
				noEmit: true,
			},
			include: ['main.tsx'],
		}),
	)
	await writeFile(
		join(app, 'theme.css'),
		'@import "tailwindcss";\n@source "./main.tsx";\nbody{margin:0;padding:1rem;font-family:system-ui}#root{height:calc(100dvh - 2rem)}',
	)
	await writeFile(
		join(app, 'main.tsx'),
		`
import {createRoot} from 'react-dom/client';
import {createAgentSession} from '@pluxel/browser-worker-agent';
import {AgentWorkspace, type WorkspaceReferenceSource} from '@pluxel/browser-worker-agent-ui';
import './theme.css';
import '@pluxel/browser-worker-agent-ui/styles.css';
import {RpcTarget,RpcStub} from 'capnweb';
import {createModels,fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
class Api extends RpcTarget { async readDto(){return {revision:7}} }
const host=new RpcStub(new Api());
const faux=fauxProvider({tokensPerSecond:10000}); const models=createModels();models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage([fauxToolCall('runJavaScript',{code:'return await api.readDto();'})],{stopReason:'toolUse'}),fauxAssistantMessage(['# pack accepted','','~~~js','const revision = 7;','~~~'].join('\\n'))]);
const session=createAgentSession({scopeKey:'independent-consumer',titleGeneration:false,model:faux.getModel(),models,documents:[],acquireApi(){const api=host.dup();return {api,release(){api[Symbol.dispose]()}}}});
const referenceSources=[{trigger:'@',label:'资料',items:[{id:'resource:alpha',label:'Alpha reference',description:'Neutral host resource',insertText:'Alpha reference (resourceId="alpha")'}]}] satisfies readonly WorkspaceReferenceSource[];
createRoot(document.getElementById('root')!).render(<AgentWorkspace session={session} referenceSources={referenceSources}/>);
Object.assign(window,{peekPackCalls:()=>faux.state.callCount,runPackSmoke:async()=>{await session.send('read');const record=session.getSnapshot().executions[0];return {record,shared:await host.readDto(),modelCalls:faux.state.callCount,history:(await session.listHistory()).length}}});
`,
	)
	console.log(
		'Installing the default assistant-ui workbench without HeroUI in an independent Vite project.',
	)
	await command('pnpm', ['install', '--ignore-scripts'], app)
	const { requireFromApp, manifest } = await assertNoHeroUiConsumer(app)
	assert.equal(manifest.exports['.'].development, undefined, 'pack must point at built files only')
	assert.equal(manifest.exports['./react'], undefined)
	assert.equal(manifest.exports['./ui'], undefined)
	const presentationManifests = await Promise.all(
		['react', 'ui'].map(async (name) => ({
			name,
			entry: JSON.parse(
				await readFile(
					join(app, `node_modules/@pluxel/browser-worker-agent-${name}/package.json`),
					'utf8',
				),
			),
		})),
	)
	for (const { name, entry } of presentationManifests) {
		assert.equal(entry.exports['.'].import, './dist/index.js')
		assert.equal(entry.exports['.'].development, undefined)
		const shared = ['@pluxel/browser-worker-agent', 'react', 'react-dom', '@assistant-ui/react']
		if (name === 'ui') shared.push('@pluxel/browser-worker-agent-react')
		for (const dependency of shared) {
			assert.equal(
				typeof entry.peerDependencies?.[dependency],
				'string',
				`${name}: ${dependency} is a host peer`,
			)
			assert.doesNotMatch(entry.peerDependencies[dependency], /workspace:|catalog:/)
			assert.equal(
				entry.dependencies?.[dependency],
				undefined,
				`${name}: ${dependency} must not install a private runtime`,
			)
		}
	}
	assert.equal(manifest.exports['./worker'], './dist/execution.worker.js')
	const packedStyles = await readFile(
		join(app, 'node_modules/@pluxel/browser-worker-agent-ui/dist/ui.css'),
		'utf8',
	)
	assert.doesNotMatch(
		packedStyles,
		/@(?:apply|theme|tailwind|source)\b/i,
		'tarball CSS must compile Tailwind directives before reaching the consumer',
	)
	assert.doesNotMatch(
		packedStyles,
		/@import\s+(?:url\(\s*)?["']?tailwindcss(?:[/\s;"')]|$)/i,
		'tarball CSS must not ask the consumer to compile a Tailwind import',
	)
	assert(!JSON.stringify(manifest.dependencies).includes('workspace:'))
	assert(!JSON.stringify(manifest.dependencies).includes('catalog:'))
	assert(
		!Object.keys(manifest.dependencies).some(
			(name) => name.startsWith('@omni/') || name.startsWith('@pluxel/'),
		),
	)
	const typeResolution = await command(
		'pnpm',
		['exec', 'tsc', '--noEmit', '--traceResolution'],
		app,
	)
	assert.doesNotMatch(typeResolution, /Resolving module ['"]@heroui\//)
	const vite = await import(requireFromApp.resolve('vite'))
	const { default: tailwindcss } = await import(requireFromApp.resolve('@tailwindcss/vite'))
	const warnings = []
	await vite.build({
		configFile: false,
		root: app,
		plugins: [
			tailwindcss(),
			{
				name: 'default-ui-dependency-boundary',
				resolveId(source) {
					assert.doesNotMatch(source, /@heroui(?:\/|\+)/)
				},
			},
		],
		build: {
			rolldownOptions: {
				onwarn(warning) {
					warnings.push(warning.message)
				},
			},
		},
	})
	const externalWarnings = warnings.filter((warning) =>
		warning.includes('externalized for browser'),
	)
	assert(
		externalWarnings.every(
			(warning) => warning.includes('provider-env.js') && warning.includes('node:fs'),
		),
		externalWarnings.join('\n'),
	)
	console.log(
		'Browser dependency warning:',
		externalWarnings.length
			? 'pi Bun-only require(node:fs) externalized; no polyfill installed'
			: 'none',
	)
	// Eval is allowed only by the Worker script response policy; the main page remains strict.
	server = await vite.preview({
		configFile: false,
		root: app,
		preview: { host: '127.0.0.1', port: 0 },
		plugins: [
			{
				name: 'worker-scoped-csp',
				configurePreviewServer(preview) {
					preview.middlewares.use((request, response, next) => {
						response.setHeader(
							'Content-Security-Policy',
							request.url?.includes('execution.worker')
								? "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'none'"
								: "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
						)
						next()
					})
				},
			},
		],
	})
	browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
	const page = await browser.newPage()
	const errors = []
	page.on('pageerror', (error) => errors.push(error.message))
	await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
	await page.waitForFunction(() => typeof window.runPackSmoke === 'function')
	const composer = page.getByRole('textbox', { name: '消息', exact: true })
	await page.getByRole('button', { name: '引用资料', exact: true }).click()
	await page.getByRole('listbox', { name: '资料引用', exact: true }).getByRole('option').waitFor()
	assert.equal(await composer.inputValue(), '@')
	await composer.press('Escape')
	await page.getByRole('listbox', { name: '资料引用', exact: true }).waitFor({ state: 'detached' })
	await composer.fill('@Alpha')
	await page.getByRole('listbox', { name: '资料引用', exact: true }).waitFor()
	await composer.press('Enter')
	assert.equal(await composer.inputValue(), 'Alpha reference (resourceId="alpha") ')
	assert.equal(
		await page.evaluate(() => window.peekPackCalls()),
		0,
		'reference selection never sends',
	)
	await composer.fill('before @Alpha after')
	await Array.from({ length: ' after'.length }).reduce(async (previous) => {
		await previous
		await composer.press('ArrowLeft')
	}, Promise.resolve())
	await page.getByRole('listbox', { name: '资料引用', exact: true }).getByRole('option').waitFor()
	await composer.press('Enter')
	const middleText = 'before Alpha reference (resourceId="alpha") after'
	assert.equal(await composer.inputValue(), middleText)
	const cursor = middleText.length - 'after'.length
	await page.waitForFunction(
		(expected) => {
			const input = document.querySelector('.agent-workspace-input')
			return input?.selectionStart === expected && input.selectionEnd === expected
		},
		cursor,
		{ timeout: 5000 },
	)
	assert.deepEqual(
		await composer.evaluate((input) => [input.selectionStart, input.selectionEnd]),
		[cursor, cursor],
		'reference selection leaves the caret after the insertion',
	)
	await composer.press('x')
	assert.equal(await composer.inputValue(), `${middleText.slice(0, cursor)}xafter`)
	assert.equal(await page.evaluate(() => window.peekPackCalls()), 0)
	await composer.fill('')
	const result = await page.evaluate(() => window.runPackSmoke())
	assert.equal(result.record.status, 'completed', JSON.stringify(result))
	assert.equal(result.record.value.revision, 7)
	assert.equal(result.shared.revision, 7)
	assert.equal(result.modelCalls, 2)
	assert.equal(result.history, 1)
	await page.getByRole('heading', { name: 'pack accepted', exact: true }).waitFor()
	const headingStyles = await page
		.getByRole('heading', { name: 'pack accepted', exact: true })
		.evaluate((heading) => ({
			fontSize: Number.parseFloat(getComputedStyle(heading).fontSize),
			fontWeight: Number.parseFloat(getComputedStyle(heading).fontWeight),
		}))
	assert(
		headingStyles.fontSize >= 28 && headingStyles.fontWeight >= 600,
		`native Markdown heading styles ship in the tarball without a host theme: ${JSON.stringify(headingStyles)}`,
	)
	assert.equal(
		await page.locator('.agent-workspace-assistant').count(),
		1,
		'one native pi user turn renders one assistant including its tool continuation',
	)
	assert.equal(
		await page.getByRole('button', { name: /查看处理过程|正在处理/ }).getAttribute('aria-expanded'),
		'false',
		'the completed native faux turn keeps its final answer visible and its process folded',
	)
	const viewport = page.locator('[data-slot="aui_thread-viewport"]')
	await viewport.waitFor()
	const viewportStyles = await viewport.evaluate((element) => ({
		overflowY: getComputedStyle(element).overflowY,
		height: element.clientHeight,
	}))
	assert(
		['auto', 'scroll'].includes(viewportStyles.overflowY) && viewportStyles.height > 0,
		`the compiled default thread viewport must own vertical scrolling: ${JSON.stringify(viewportStyles)}`,
	)
	const footer = viewport.locator('.aui-thread-viewport-footer')
	await footer.waitFor()
	assert.deepEqual(
		await footer.evaluate((element) => {
			const styles = getComputedStyle(element)
			return { position: styles.position, bottom: styles.bottom }
		}),
		{ position: 'sticky', bottom: '0px' },
		'the native viewport footer docks the composer after a reply',
	)
	const userBubble = page.locator('.aui-user-message-content')
	await userBubble.waitFor()
	const bubbleStyles = await userBubble.evaluate((element) => {
		const styles = getComputedStyle(element)
		return {
			background: styles.backgroundColor,
			radii: [
				styles.borderTopLeftRadius,
				styles.borderTopRightRadius,
				styles.borderBottomRightRadius,
				styles.borderBottomLeftRadius,
			],
		}
	})
	assert(
		bubbleStyles.background !== 'transparent' && bubbleStyles.background !== 'rgba(0, 0, 0, 0)',
		`the default user bubble must have a visible background: ${JSON.stringify(bubbleStyles)}`,
	)
	assert(
		bubbleStyles.radii.every((radius) => Number.parseFloat(radius) > 0),
		`the default user bubble must have rounded corners: ${JSON.stringify(bubbleStyles)}`,
	)
	const highlightedCode = page.locator('.agent-workspace-markdown pre code')
	await page.waitForFunction(() =>
		[
			...document.querySelectorAll('.agent-workspace-markdown pre code span[style*="--sdm-c"]'),
		].some((token) => token.textContent.trim() === 'const'),
	)
	assert((await highlightedCode.locator('span[style*="--sdm-c"]').count()) > 2)
	assert.equal((await highlightedCode.innerText()).trim(), 'const revision = 7;')
	assert(
		await highlightedCode.evaluate((code) => {
			const keyword = [...code.querySelectorAll('span[style*="--sdm-c"]')].find(
				(token) => token.textContent.trim() === 'const',
			)
			return keyword && getComputedStyle(keyword).color !== getComputedStyle(code).color
		}),
		'tarball CSS gives Markdown syntax tokens a visible highlight color',
	)
	await page.setViewportSize({ width: 320, height: 740 })
	await assertHeaderContext(page)
	const narrowDraft = 'pack narrow composer draft'
	await composer.fill(narrowDraft)
	const send = page.getByRole('button', { name: '发送', exact: true })
	await send.click({ trial: true })
	assert.equal(await send.isEnabled(), true, 'a populated narrow composer enables sending')
	const sendBounds = await send.boundingBox()
	assert(sendBounds, 'the narrow send action must be visible')
	assert(
		sendBounds.width >= 44 && sendBounds.height >= 44,
		`the narrow send action needs a 44px target: ${JSON.stringify(sendBounds)}`,
	)
	assert(
		sendBounds.x >= 0 &&
			sendBounds.y >= 0 &&
			sendBounds.x + sendBounds.width <= 320 &&
			sendBounds.y + sendBounds.height <= 740,
		`the narrow send action must fit inside the viewport: ${JSON.stringify(sendBounds)}`,
	)
	const narrowLayout = await viewport.evaluate((element) => ({
		windowWidth: window.innerWidth,
		documentWidth: document.documentElement.scrollWidth,
		bodyWidth: document.body.scrollWidth,
		viewportWidth: element.clientWidth,
		viewportContentWidth: element.scrollWidth,
	}))
	assert(
		narrowLayout.documentWidth <= narrowLayout.windowWidth + 1 &&
			narrowLayout.bodyWidth <= narrowLayout.windowWidth + 1 &&
			narrowLayout.viewportContentWidth <= narrowLayout.viewportWidth + 1,
		`the default thread and composer must not overflow horizontally at 320px: ${JSON.stringify(narrowLayout)}`,
	)
	assert.equal(await composer.inputValue(), narrowDraft, 'actionability checks preserve the draft')
	assert.equal(
		await page.evaluate(() => window.peekPackCalls()),
		2,
		'narrow layout checks never send an extra model request',
	)
	await composer.fill('')
	await page.setViewportSize({ width: 1280, height: 720 })
	await assertHeaderContext(page)
	await page.getByRole('button', { name: '模型设置', exact: true }).click()
	const settingsDialog = page.getByRole('dialog', { name: '模型设置', exact: true })
	await settingsDialog.waitFor()
	await assertOpaqueSurface(settingsDialog, 'the compiled settings dialog has an opaque surface')
	assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '')
	await page.getByRole('combobox', { name: '供应商', exact: true }).click()
	const providerSearch = page.getByRole('combobox', { name: '搜索供应商', exact: true })
	await providerSearch.waitFor()
	await assertOpaqueSurface(
		page.locator('[data-slot="model-selector-content"]'),
		'the compiled provider selector has an opaque surface',
	)
	await providerSearch.fill('custom')
	assert.equal(await page.getByRole('option').count(), 1)
	await providerSearch.press('Escape')
	await providerSearch.waitFor({ state: 'detached' })
	await page.getByRole('button', { name: '关闭模型设置', exact: true }).click()
	assert.equal(await page.evaluate(() => window.peekPackCalls()), 2)
	assert.deepEqual(errors, [])
	console.log(
		'PACK ACCEPTED',
		JSON.stringify({
			packages: ['core', 'react', 'ui'],
			exports: ['core', 'execution', 'worker', 'react', 'ui', 'ui/styles.css'],
			consumer: app,
			worker: result.record.status,
			sharedConnection: 'still callable',
			mainPageCsp: 'no unsafe-eval',
			provider: 'native pi faux',
			presentation:
				'official assistant-ui, standard shadcn settings, grouped pi turn, Markdown and neutral host references',
			heroUiInstalled: false,
			typeAndBuildResolveHeroUi: false,
			nodePolyfills: false,
		}),
	)
} finally {
	await browser?.close()
	if (server) await new Promise((resolve) => server.httpServer.close(resolve))
	if (!process.env.KEEP_AGENT_PACK_SMOKE) await rm(temporary, { recursive: true, force: true })
}
