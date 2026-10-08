import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'
import tailwindcss from '@tailwindcss/vite'
const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const dependencies = [
	...Object.keys(manifest.dependencies),
	...Object.keys(manifest.peerDependencies),
]
export default defineConfig({
	plugins: [...tailwindcss()],
	build: {
		lib: { entry: 'src/index.tsx', formats: ['es'], fileName: 'index', cssFileName: 'ui' },
		rolldownOptions: {
			external: (id) => dependencies.some((name) => id === name || id.startsWith(`${name}/`)),
		},
	},
})
