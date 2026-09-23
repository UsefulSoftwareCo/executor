# Live inbox

A configured app owns its records. Activating a deployment or changing selected
accounts keeps the same data. Adding another copy starts with separate data.

`listMessages` reads typed records. The host records the tables actually read,
including empty results. `receiveMessage` changes data in a transaction. A
successful commit reruns relevant subscriptions, including subscribers connected
through a different SDK instance sharing the same host storage.

Queries receive a read-only database. Mutations receive a writable one. Keep
network requests outside mutations: they hold a database transaction, and a
rollback cannot undo external effects. This first document store supports
keyed get/set/remove and full table reads. Indexed queries and schema migration
for authored tables remain follow-up work.

Use `executor.appData.query` or `executor.appData.mutate` with the configured app
ID, operation name and JSON input. Native serving hosts use `subscribeAppQuery`
from `@executor-js/sdk/core`; trusted Promise callers can iterate
`await executor.appData.subscribe(...)`.
The descriptor contains names and arguments, never executable closures or
credentials. The local host now provides private UI hosting and browser authentication.

See `playground/sdk/live-app.ts` for two callers: one subscribes while another
writes. The current coordinator supports one local/Docker server process.
Cloudflare Durable Object restoration and multi-server delivery are not implemented.

`client.ts` builds typed references using type-only imports of the server
operations. Its `messagesAtom(transport)` consumes a host-bound subscription and
validates each result with the shared message schema. The embedding host supplies
the transport for that lower-level sketch. `ui/main.tsx` uses the built-in host
transport from `createAppClient` instead.

## Open the UI

With the local Executor server running, run from the repository root:

```sh
node --env-file=.env playground/sdk/deploy-ui.ts
```

Open the printed dashboard URL. Executor opens the app on its own localhost
subdomain. Open it twice and add a message to see both windows update. Running
the deploy command again reloads both windows; messages persist.

## Agent instructions

The `skills/inbox/` directory ships with the app through `playground/sdk/deploy-ui.ts`.
Ask the MCP `skills` tool for `{ app: "live-inbox", name: "inbox" }`, using the
actual installed slug. It returns the document and the deployment ID for reading
its reference file. Skills never execute code or change tool grants.
