# Browser Worker Agent — React

Frontend-only assistant-ui bindings for `@pluxel/browser-worker-agent`. No application backend, Pluxel plugin runtime or authentication is required. A core session can expose local page functions to its Worker using Cap’n Web `RpcTarget`/`RpcStub`.

Install this package with the core package, `capnweb`, React, React DOM and `@assistant-ui/react` at the versions declared in their peer dependencies. Use the package family's vendored workspace or built tarballs; these instructions do not assume registry publication. In a workspace containing those packages:

```sh
pnpm add '@pluxel/browser-worker-agent@workspace:*' '@pluxel/browser-worker-agent-react@workspace:*'
pnpm add 'capnweb@^0.12.0' 'react@^19.3.0' 'react-dom@^19.3.0' '@assistant-ui/react@^0.15.23'
pnpm add -D 'vite@^8.3.1'
```

Enable the core browser adapter in your Vite configuration, alongside any existing React plugin:

```ts
import { defineConfig } from 'vite'
import { browserWorkerAgent } from '@pluxel/browser-worker-agent/vite'

export default defineConfig({ plugins: [browserWorkerAgent()] })
```

Render your own assistant-ui components inside the provider:

```tsx
import { AgentWorkspaceProvider, useAgentWorkspace } from '@pluxel/browser-worker-agent-react'

;<AgentWorkspaceProvider session={session}>
	<YourAssistantUIThread />
</AgentWorkspaceProvider>
```

The application creates and disposes the core session. In React, create it inside `useEffect` and return cleanup that calls `session.dispose()` before disposing any locally owned root capability. This is React’s lifecycle, not a Pluxel effect. Use a keyed component when replacing the local workspace or API owner so old session state is removed immediately. A fixed frontend workspace needs no identity or connection lifecycle. See the core package’s shipped README for a complete local-capability and React lifecycle example.

The provider owns the assistant-ui runtime, draft isolation and local-history controls; it already installs `AssistantRuntimeProvider`, so do not wrap it in another runtime provider. `useAgentWorkspace()` exposes `session`, `snapshot`, projected `messages`, native `runtime` and `history`. Native Thread, Composer, Message and ThreadList primitives use that runtime directly. No default UI, stylesheet or renderer is imported.

The history controller exposes loading/errors, management actions and `intent`. A new-thread request during execution or failed storage sets `intent.kind === 'new'`. Your view must ask for confirmation before invoking `session.newConversation({ discardUnsaved })` through `history.perform`, then clear the intent. Removing the provider retires display state but does not dispose your session. Replacing the session resets drafts and consumer overlays together. Displaying or restoring history never replays tools.
