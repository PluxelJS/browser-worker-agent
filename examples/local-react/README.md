# Local React example

A frontend-only Agent: React owns a local note; a Cap’n Web `RpcTarget` exposes reading and writing it to a JavaScript Worker. No backend, authentication, API key, or network model is involved. pi's deterministic **faux demo model** always runs the same uppercase operation on the first message. It is not a language model; reopen the notebook to restart the scripted demonstration.

From the **browser-worker-agent repository root** (or its vendor directory):

```sh
pnpm install
pnpm build:all
pnpm --dir examples/local-react dev
```

Open the URL Vite prints, edit the note, and send any chat message. Switch notebooks to see independent browser session scopes. Closing a notebook disposes its session and then its root capability; opening it creates new resources.

```sh
pnpm --dir examples/local-react typecheck
pnpm --dir examples/local-react build
node tests/example-browser.mjs
```

The acceptance test runs this example in development and as a production build, rejects external requests, and exercises local Worker RPC, scope replacement, and unmount/reopen under React StrictMode.

`useEffect` here is React's lifecycle hook. There is no Pluxel plugin lifecycle. The keyed `Notebook` component removes the old UI immediately when selecting a different notebook; each effect setup creates fresh resources, and each cleanup disposes precisely those resources, including React StrictMode's development setup/cleanup probe.

`scopeKey` partitions local conversation storage; it does not mean a user account or a backend connection. The note itself is in-memory demo data and resets on notebook replacement. The worker borrows a duplicate capability per execution; it never owns the root reference.

To use an actual browser-compatible model, replace `fauxProvider` with the documented session model configuration. Whether that model needs network access or credentials depends on its provider; this library does not require an application backend.
