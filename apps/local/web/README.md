# Local dashboard

A browser view of configured apps, account metadata, retained source,
and live tool catalogs. The local server serves `dist/` after `bun run build`.
The CLI opens a one-use pairing link. `src/contracts/connection.ts` exchanges
it through a typed Effect Atom client before dashboard reads begin. The server
sets an HttpOnly session cookie; the reusable API key never enters browser
storage or build output. Disconnect revokes the session. Refresh preserves it;
sessions survive server restarts when the data directory and address stay the same.

`src/contracts/api.ts` builds an Effect `AtomHttpApi` client directly from
`@executor-js/local-server/contracts`. Every product request uses that client.
Overview, apps, accounts, and tools subscribe to typed SSE query snapshots.
Committed SDK/MCP writes update the mounted atoms automatically. Tool discovery
follows every page and pins the deployment across pages. Unrelated writes only
rerun a cheap input query; they do not reload upstream catalogs.
Source and schemas are rendered as text tokens, never evaluated in the browser.
Streams reauthenticate on snapshots and idle heartbeats. Transport failures
resubscribe from current state; query failures remain subscribed and can recover
after a later write. Source follows the active deployment unless a retained
version is explicitly selected. No polling or manual refresh is required.

The design follows the earlier Executor workspaces preview and current product:
Geist, neutral surfaces, hairline borders, a quiet sidebar, and compact app cards.
`@executor-js/ui/components/*` supplies the shared shadcn controls.
`@executor-js/ui/styles` owns the common theme and bundled Geist fonts.
Local page layouts and provider marks stay in this app.
No workspace model or app-authoring UI is introduced here.

## Layout

- `src/contracts/`: types, schemas, API client and atoms for dashboard data,
  connection state, navigation and highlighting.
- `src/implementation/`: React pages and components, browser helpers,
  highlighting engine, styles and bundled assets.
- `src/main.tsx`: browser entry point and Atom registry setup.

Commands:

```sh
bun run --cwd apps/local/web build
bun run dev # From the repository root
```

Development uses Vite middleware inside the local server at
`http://127.0.0.1:4312`. React Fast Refresh and CSS updates arrive over a
loopback HMR socket on port 24678. The browser uses the same origin for assets,
authenticated APIs, pairing and OAuth callbacks. `bun run web:dev` is an alias.
Stop the built preview before starting dev mode on the same port. UI changes
hot reload; server changes need a restart. Production still serves `dist/`.
