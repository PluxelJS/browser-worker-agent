import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RpcStub, RpcTarget } from 'capnweb'
import {
	createModels,
	fauxProvider,
	fauxAssistantMessage,
	fauxToolCall,
} from '@earendil-works/pi-ai'
import { createAgentSession, type AgentSession } from '@pluxel/browser-worker-agent'
import { AgentWorkspace } from '@pluxel/browser-worker-agent-ui'
import '@pluxel/browser-worker-agent-ui/styles.css'
import './style.css'

class Notes extends RpcTarget {
	constructor(
		private read: () => string,
		private write: (text: string) => void,
	) {
		super()
	}
	readNote() {
		return this.read()
	}
	writeNote(text: string) {
		this.write(text)
		return text
	}
}

function Notebook({ name }: { name: string }) {
	const [note, setNote] = useState(`A note from ${name}`)
	const currentNote = useRef(note)
	const [session, setSession] = useState<AgentSession | null>(null)

	useEffect(() => {
		// This is a local capability in the browser, not a backend connection.
		let active = true
		const api = new RpcStub(
			new Notes(
				() => currentNote.current,
				(text) => {
					if (active) {
						currentNote.current = text
						setNote(text)
					}
				},
			),
		)
		const faux = fauxProvider({ tokensPerSecond: 10000 })
		const models = createModels()
		models.setProvider(faux.provider)
		// A deterministic demo model: any message uppercases this notebook's note.
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall('runJavaScript', {
						code: 'const text = await api.readNote(); return await api.writeNote(text.toUpperCase());',
					}),
				],
				{ stopReason: 'toolUse' },
			),
			fauxAssistantMessage('The local note is now uppercase.'),
		])
		const next = createAgentSession({
			scopeKey: `local-notebook:${name}`,
			model: faux.getModel(),
			models,
			titleGeneration: false,
			documents: [
				{
					id: 'notes',
					title: 'Local notes',
					version: '1',
					text: 'api.readNote(): Promise<string>; api.writeNote(text: string): Promise<string>. These access only the current browser notebook.',
				},
			],
			acquireApi: () => {
				const lease = api.dup()
				return { api: lease, release: () => lease[Symbol.dispose]() }
			},
		})
		setSession(next)
		return () => {
			active = false
			next.dispose()
			api[Symbol.dispose]()
		}
	}, [name])

	return (
		<>
			<label>
				Local note ({name})
				<textarea
					aria-label="Local note"
					value={note}
					onChange={(event) => {
						currentNote.current = event.target.value
						setNote(event.target.value)
					}}
				/>
			</label>
			<section className="chat" aria-label={`${name} assistant`}>
				{session ? <AgentWorkspace session={session} /> : <p>Starting browser session…</p>}
			</section>
		</>
	)
}

function App() {
	const [name, setName] = useState('Personal')
	const [open, setOpen] = useState(true)
	return (
		<main>
			<h1>Local browser Agent</h1>
			<p>
				No backend or API key. The demo model uppercases your note through a Worker and a local
				Cap’n Web capability. Send one message to try it.
			</p>
			<nav aria-label="Notebook controls">
				<label>
					Notebook{' '}
					<select value={name} onChange={(event) => setName(event.target.value)}>
						<option>Personal</option>
						<option>Work</option>
					</select>
				</label>
				<button onClick={() => setOpen(!open)}>{open ? 'Close notebook' : 'Open notebook'}</button>
			</nav>
			{/* A new key prevents the previous notebook's session from rendering during replacement. */}
			{open && <Notebook key={name} name={name} />}
		</main>
	)
}

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<App />
	</StrictMode>,
)
