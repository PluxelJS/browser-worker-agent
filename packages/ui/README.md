# Browser Worker Agent — UI

Ready-made browser chat built on the React bridge, assistant-ui, Radix and Streamdown. No application backend, Pluxel runtime or login is required. The frontend provides a core session and its local or remote Cap’n Web capability; model requests use the connection selected by the user or an injected pi model.

The core, React bridge, Cap’n Web, React, React DOM and assistant-ui are shared peers. Install the package family from its vendored workspace or built tarballs; these instructions do not assume registry publication. In a workspace containing those packages:

```sh
pnpm add '@pluxel/browser-worker-agent@workspace:*' '@pluxel/browser-worker-agent-react@workspace:*' '@pluxel/browser-worker-agent-ui@workspace:*'
pnpm add 'capnweb@^0.12.0' 'react@^19.3.0' 'react-dom@^19.3.0' '@assistant-ui/react@^0.15.23'
pnpm add -D 'vite@^8.3.1'
```

Enable pi’s browser adapter in Vite, alongside any existing React plugin:

```ts
import { defineConfig } from 'vite'
import { browserWorkerAgent } from '@pluxel/browser-worker-agent/vite'

export default defineConfig({ plugins: [browserWorkerAgent()] })
```

Import the stylesheet explicitly. Give the component a container with a useful height:

```tsx
import { AgentWorkspace, type AgentWorkspaceWelcomeProps } from '@pluxel/browser-worker-agent-ui'
import '@pluxel/browser-worker-agent-ui/styles.css'

function Welcome({ configured, onConfigure }: AgentWorkspaceWelcomeProps) {
	return <button onClick={onConfigure}>{configured ? 'Model settings' : 'Connect a model'}</button>
}

;<div style={{ height: '100dvh' }}>
	<AgentWorkspace
		session={session}
		components={{ Welcome }}
		theme={{ primary: '#2563eb', 'primary-foreground': '#ffffff' }}
	/>
</div>
```

Create the core session inside React `useEffect`; return cleanup that calls `session.dispose()` before disposing any locally owned root capability. This means React lifecycle, not a Pluxel effect. Use a keyed component to retire old React state when changing local workspaces or API owners. A fixed local workspace needs no authentication or remote connection. The core package’s shipped README includes a complete local-capability/session example. Unmounting the UI alone does not dispose your session.

`AgentWorkspace` includes its runtime provider. Do not wrap it in another `AgentWorkspaceProvider` or `AssistantRuntimeProvider`. It starts unconfigured and offers model settings; no model is selected or called until configured and explicitly used.

`components` changes presentation while retaining grouping, error notices, history and composer behavior. Define component types outside the parent render function:

- `Welcome` receives `{ configured: boolean; onConfigure(): void }`; calling `onConfigure` opens model settings.
- `Text` reads assistant-ui’s native message-part context and renders assistant text/reasoning. Your replacement owns its HTML and URL handling.
- `Tool` receives native `ToolCallMessagePartProps`. Registered assistant-ui tool UI takes precedence. Displaying a tool result does not execute it.

`theme` accepts CSS color strings for `background`, `foreground`, `primary`, `primary-foreground`, `muted`, `muted-foreground`, `border` and `destructive`. It applies to the chat and its portalled dialogs/popovers independently per instance. `className` controls layout. CSS is compiled and scoped; no consumer Tailwind setup or HeroUI is required. The default UI currently uses Chinese labels and has no localization API.

Radix and internal control utilities are regular dependencies. Renderer dependencies ship together in this package. Attribution is included in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
