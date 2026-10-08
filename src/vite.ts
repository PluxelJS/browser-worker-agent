import type { Plugin } from 'vite'

const piBrowserModules =
	/[/\\]@earendil-works[/\\]pi-ai[/\\]dist[/\\](?:api[/\\]bedrock-converse-stream\.lazy|auth[/\\]context|auth[/\\]oauth[/\\]load|env-api-keys|utils[/\\]provider-env)\.js$/

const browserEnvironment =
	'export function getProviderEnvValue(name, env) { return env?.[name] || undefined }'
const lazyImport = 'import(__rewriteRelativeImportExtension('
const browserLazyImport = 'import(/* @vite-ignore */ __rewriteRelativeImportExtension('

function unsupportedPiModule(id: string): never {
	throw new Error(
		`[browser-worker-agent] Unsupported pi module shape: ${id}. ` +
			"Use this package's declared pi versions. When upgrading pi, update the browser adapter and run the independent pack test.",
	)
}

function piBrowserImports() {
	return {
		name: 'browser-worker-agent:pi-browser-imports',
		transform: {
			filter: { id: piBrowserModules },
			handler(code: string, id: string) {
				if (id.replaceAll('\\', '/').endsWith('/utils/provider-env.js')) {
					if (code === browserEnvironment) return
					if (!code.includes('export function getProviderEnvValue(name, env)'))
						unsupportedPiModule(id)
					// Browser callers supply scoped credentials/environment explicitly.
					return {
						code: browserEnvironment,
						map: null,
					}
				}
				// pi 1.1.0 deliberately defers these Node-only modules. Preserve that
				// boundary through Vite import analysis, including dependency prebundling.
				const imports = code.split(lazyImport).length - 1
				const annotated = code.split(browserLazyImport).length - 1
				if (imports === 0 && annotated === 1) return
				if (imports !== 1 || annotated !== 0) unsupportedPiModule(id)
				return { code: code.replace(lazyImport, browserLazyImport), map: null }
			},
		},
	}
}

/** Browser-only pi integration for Vite 8; Worker assets use Vite's native handling. */
export function browserWorkerAgent(): Plugin {
	return {
		...piBrowserImports(),
		enforce: 'pre',
		applyToEnvironment: (environment) => environment.config.consumer === 'client',
		configEnvironment(name, options) {
			if (options.consumer === 'server' || (name !== 'client' && options.consumer !== 'client'))
				return
			return { optimizeDeps: { rolldownOptions: { plugins: [piBrowserImports()] } } }
		},
	}
}
