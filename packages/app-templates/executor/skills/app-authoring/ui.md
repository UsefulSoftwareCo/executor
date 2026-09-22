## Private app UI

Author app UIs as React SPAs. React is the only supported UI framework for now.
Add `ui/index.html`, a module script such as `ui/main.tsx`, and styles. The host
compiles browser assets alongside the server build. Declare `react` and
`react-dom` in the deployment's package dependencies. The local product opens
each configured app on its own localhost subdomain.

Use local React components or browser-compatible npm component libraries.
Declare library dependencies and include their required styles and assets.
Do not assume that the host runs custom build plugins required by a library.

Tailwind CSS v4 compilation is built in. Import `./style.css` from `ui/main.tsx`
and start the stylesheet with `@import "tailwindcss";`. No Tailwind dependency,
config file or build script is needed. Use complete class names in React code;
the build scans the browser bundle, including imported components and lazy
chunks. Customize tokens with CSS `@theme`. Use `@source inline("...")` for
classes supplied only at runtime. Do not use filesystem `@source` paths or
JavaScript `@config` and `@plugin` files. Plain CSS and library styles still work.
The full Tailwind import includes Preflight, which resets browser button and
form styles. Importing only `theme.css` and `utilities.css` omits those resets;
use that split only when you supply the required base styles yourself.

For hosted apps, discover and call `appUi_location` after deployment:

```js
return await tools.executor.queries.appUi_location({
  path: { organization: "<approved-organization-id>", app: "<app-id>" },
});
```

The response is `{ url: "https://<app-slug>.<org-slug>.executor.website" }`
on Executor Cloud. Self-host uses its configured app domain. Use the returned
URL rather than constructing one. `url: null` means the app has no UI or the
host has no app domain configured. Deployment builds and activates the UI;
there is no separate publish step. Give the URL to the user to open in a
browser. The browser completes sign-in using their Executor session. MCP
credentials do not grant a browser session. A `403` response alone does not
prove the URL is correct or that the UI renders; invalid hosts also return it.
Verify the actual page before claiming that the UI works.
Use an available authenticated browser session for that check. A fresh profile
may stop at sign-in. Successful tool calls or rows added by someone else do not
verify the page's layout, controls or optimistic interactions.

Import `createAppClient`, `queryReference`, and `mutationReference` from
`apps/client`. Import server operation **types only** from `index.ts`; put shared
schemas in a separate file. Use `client.queryAtom(reference, input, outputSchema)`
with `useAppQuery` from `apps/react`, and `client.mutate(reference, input,
outputSchema)` for explicit writes. `client.query(reference, input, outputSchema)`
reads once. Both operation types may fetch external APIs. External changes do
not invalidate subscriptions, and a database rollback cannot undo external
effects. All callbacks use Promises; the framework runs Effect internally.

Do not include an app ID or credentials in browser code. The host binds both
identity and authentication. Keep asset URLs relative to the document's base;
compiled imports and `ui/public/` files are retained with the deployment. Each
activation automatically reloads open pages. SSR, React Server Components and
public sharing are not part of this version.

## Hook result

`useAppQuery(atom)` returns `{ data, pending, error }`, never the query data directly.
`data` is `undefined` until a successful result. `pending` means no result has arrived.
`error` is an optional safe message. Keep an existing result visible during a failed refresh.

```tsx
const { data, pending, error } = useAppQuery(todosAtom);
const todos = data ?? [];
```

Use `framework_describe` for `apps/react.useAppQuery`, `AppClient.queryAtom`, and
`AppClient.mutate` before using an unfamiliar call shape. Type parameters on
`queryReference` and `mutationReference` describe the individual operation,
for example `queryReference<typeof list>("list")`, not the entire app.

## Optimistic mutations

Use the Convex-style `withOptimisticUpdate` helper on a callable mutation:

```tsx
const listRef = queryReference<typeof list>("list");
const todos = client.queryAtom(listRef, {}, array(Todo));
const setDone = client
  .mutation(mutationReference<typeof setTodoDone>("setTodoDone"), Todo)
  .withOptimisticUpdate((store, input) => {
    const rows = store.getQuery(listRef, {});
    if (rows !== undefined) {
      store.setQuery(
        listRef,
        {},
        rows.map((row) => (row.id === input.id ? { ...row, done: input.done } : row)),
      );
    }
  });
await setDone({ id, done: true });
```

`getQuery` reads the projected value, or `undefined` when the query is not loaded.
`getAllQueries(reference)` returns `{ input, value }` for every mounted argument
variant. Update filtered lists deliberately. `setQuery` replaces a mounted value
and validates it with that query's output schema. It does not create a subscription.
The complete `live-inbox` example returned by `framework_describe` shows insertion
with a temporary ID. Create IDs before calling the mutation, and pass them as input.

A temporary ID is only a UI placeholder. The example's server ignores `clientId`
and returns a row with a database-generated ID; the client does not rewrite IDs
in later mutation arguments. If you add per-row actions, use distinguishable
temporary IDs (for example, `"pending:" + crypto.randomUUID()`) and disable edit,
toggle and delete for those rows. Enable them when reconciliation replaces the
placeholder with the authoritative row. Awaiting the create Promise alone is
not sufficient: it resolves before the placeholder is necessarily replaced.
Do not send a temporary ID to a database mutation or assume queued writes map it.

The callback must be synchronous, pure, and return nothing. It can run repeatedly
over newer server data. Do not mutate values, make network calls, or generate IDs
inside it. A failed callback before execution prevents that write. A callback that
fails on a later replay loses its projection and reports a browser error; it does
not change the outcome of a write already sent.

Use one client per page and create stable query atoms outside components or with
`useMemo`. Components using the same client, operation and input share a cache.
One-shot `client.query` calls do not populate it. Dispose the client when its owner
is removed; page navigation disposes it automatically.

All invocations project immediately in call order. Writes from this client run
one at a time. The framework pauses old subscriptions, sends a write once, and
reads mounted queries again before sending the next write. Each reconciliation
read has a 30-second timeout; reads for unmounted queries are cancelled. Pending
projections replay over those fresh results. A rejected write removes only its
own projection. No component rollback snapshots or manual invalidation are needed.

The mutation Promise resolves when the server acknowledges the write. Its
projection remains until reconciliation finishes. A read failure appears in the
query's `error`, with its last authoritative value, and releases the queue.
Subscriptions then resume and can recover. A lost write response can leave the
outcome uncertain; the client reconciles but never retries the write automatically.
Other clients remain independent. This API does not provide offline writes or
atomic visibility across separate clients or different queries.

The client requests the browser's leave-page warning while any mutation is
queued or waiting for its response. It removes the warning once those Promises
settle, even if query reconciliation continues. The queue lives in the page:
choosing to leave, force-closing the browser, or a browser that suppresses the
warning can still discard unsent writes. Optimistic UI is not proof of a saved
write, and this warning does not provide durable background delivery.

Describe `AppClient.mutation`, `AppMutation.withOptimisticUpdate`, and
`OptimisticLocalStore.getAllQueries` for their generated signatures.
