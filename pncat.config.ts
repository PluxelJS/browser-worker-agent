import { defineConfig } from 'pncat'

export default defineConfig({
	saveExact: false,
	depFields: { peerDependencies: false },
	catalogRules: [
		{ name: 'tooling', match: ['pncat', 'rolldown', 'vite', 'typescript'], priority: 10 },
		{ name: 'test', match: ['vitest', 'playwright', 'fake-indexeddb'], priority: 20 },
		{ name: 'backend', match: ['capnweb'], priority: 30 },
		{ name: 'prod', match: ['radix-ui'], priority: 40 },
		{
			name: 'frontend',
			match: [
				'@earendil-works/*',
				'@assistant-ui/*',
				'@streamdown/*',
				'@tailwindcss/*',
				'@types/react',
				'@types/react-dom',
				'react',
				'react-dom',
				'tailwindcss',
				'lucide-react',
				'class-variance-authority',
				'cmdk',
				'clsx',
				'tailwind-merge',
				'streamdown',
			],
			priority: 50,
		},
	],
})
