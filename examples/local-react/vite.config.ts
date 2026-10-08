import { defineConfig } from 'vite'
import { browserWorkerAgent } from '@pluxel/browser-worker-agent/vite'

export default defineConfig({
	plugins: [browserWorkerAgent()],
	// Exercise the same built public entry points a published-package consumer uses.
	resolve: { conditions: ['browser', 'module', 'production'] },
})
