# Apps

Author apps with ordinary TypeScript and Promises. Framework operations use
Effect v4 internally. The root export contains declarations and schemas;
protocol helpers have separate entry points.

The Executor package starts at `0.0.1-beta.0`. The first npm beta is being
prepared; `latest` belongs to the earlier package and is not this framework.
Once the beta is published, install it with `npm install --save-exact apps@beta`.
For local testing, install the tarball made by `bun run pack` in this directory.

```ts
import { defineApp } from "apps";
import { mcpOperations } from "apps/mcp";

export default defineApp({ accounts: {} }, async ({ signal }) => ({
  ...(await mcpOperations({
    url: "https://mcp.deepwiki.com/mcp",
    ...(signal === undefined ? {} : { signal }),
  })),
}));
```

| Import           | Helper              | App dependency              |
| ---------------- | ------------------- | --------------------------- |
| `apps/mcp`       | `mcpOperations`     | `@modelcontextprotocol/sdk` |
| `apps/mcp/stdio` | `stdioOperations`   | `@modelcontextprotocol/sdk` |
| `apps/graphql`   | `graphqlOperations` | `graphql`                   |
| `apps/openapi`   | `openapiOperations` | None                        |

MCP and GraphQL are optional peers. Subpath imports isolate their module graphs;
optional peers keep unused libraries out of the dependency installation. The
MCP HTTP entry point does not import the stdio process adapter. Stdio requires
a host with process support.

`defineApp` declares behavior, not a name. Package identity lives in
`package.json.name`; the host separately names each installed copy.

Declare the needed peer in the deployed app's `package.json`, for example:

```json
{ "name": "deepwiki", "dependencies": { "@modelcontextprotocol/sdk": "1.30.0" } }
```

Product runtimes compile authored source and declared dependencies inside workerd,
then retain the executable Worker modules. Declare `apps` in `package.json` to
select its npm version for both server and browser code. Use an exact version to
keep rebuilds repeatable. Apps with no `apps` dependency use the host's framework.
In this repository, playground workspaces use `"apps": "workspace:*"` for development;
replace that workspace reference with a released version before deployment.

`liveOpenapiOperations` reads an OpenAPI document through `ctx.cache`. Generated
imports retain a source URL, allowed origin, and static credential bindings in
`openapi.json`. The framework compiles a revision on a cache miss. It writes each
operation and shared schema before publishing the current revision. A warm call
reads that revision and the requested operation's schema dependencies. It does
not download, parse, or read the full catalog. `openapiOperations` remains the
lower-level helper for already normalized metadata.
`parameterDefaults` binds path, query or header values to the selected account.
Those parameters become optional and publish their value as the schema `default`;
an explicit value still wins.

The default refresh window is five minutes fresh plus five minutes stale.
`freshFor` and `staleFor` can change it. A stale read schedules a bounded refresh;
a failed refresh keeps the last successful revision until its stale window ends.
The source URL and static compilation configuration identify a shared source.
Accounts bind at execution time. Live documents cannot change credential
placement or send credentials to another origin. Editing generated source and
redeploying is required to change those static choices.

Authenticated templates use `provider.many()` and `accountOperations` from `apps`:

```ts
export default defineApp({ accounts: { service: provider.many() } }, async ({ accounts, signal }) =>
  accountOperations(
    accounts.service,
    (account) =>
      mcpOperations({
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer " + account.fields.token },
        signal,
      }),
    { signal },
  ),
);
```

MCP and GraphQL helpers accept `cache: ctx.cache.forAccount(account)` (or
`ctx.cache` for a public source). They return `{ dynamicTools }`, cache remote
metadata, and compile only the selected tool. The defaults are five minutes fresh
plus five minutes stale. Use `freshFor` / `staleFor` to change the windows, or
`revalidate: true` to await a refresh. Tool results are never cached.

Each combined tool takes `{ accountId, input }`. `input` keeps the upstream shape;
`accountId` must identify a selected account that exposes that tool. Discovery
and validation remain specific to each account. An empty selection returns no
tools. This helper also works with OpenAPI, GraphQL and stdio operations.

Contracts live in `src/contracts/`; native operations live in `src/implementation/`.
Promise conversion happens at the public entry points. `apps/mcp/effect` exposes
the native HTTP discovery operation for host-side import probing.

Helpers are ordinary app libraries. The SDK still builds and invokes one app
model with the configured account selections; there is no protocol dispatcher.
Existing retained builds keep their bundled code until a new deployment.

The packaged runtime uses host protocol 1. A package missing that runtime or using
an unsupported protocol fails at build time; it is never replaced silently with
the host's framework. An unsuccessful update preserves the active deployment.
Beta compatibility is checked with an earlier package fixture, not a promise to
support all historical versions indefinitely.

Each query or mutation can declare `approval` in its options. Import `always()` or
`never()` from `apps/operations/approval`, or supply a synchronous/async callback that
returns `approved`, `denied`, or `user-approval`. It receives `toolName`, decoded
`toolInput`, and `signal`. Reuse a policy function across tools or attach it when
composing generated tools. There is no app-level policy.
The framework enforces the decision before the selected tool body.
Human approval delivery is separate; Executor SDK call/resume persists the pending invocation. See [tool approvals](../../notes/app-policies.md).

## Browser UI

React is the only supported app UI framework for now. Add `ui/index.html` with
a module script such as `./main.tsx`, and declare `react` and `react-dom` in the
app's dependencies. UI code is compiled into a separate browser bundle; import
server operation types with `import type`. SSR and React Server Components are
not supported yet.

Use your own React components or browser-compatible npm component libraries.
Declare library dependencies and include their required styles and assets.
Libraries that need custom build plugins require additional build support.

Tailwind CSS v4 compilation is built in. Import a stylesheet from your React
entry and put `@import "tailwindcss";` in that stylesheet. No Tailwind package,
config file or separate build command is required. Ordinary CSS imports and
stylesheet links continue to work.

The build scans complete class names in the browser bundle, including imported
components and lazy chunks. Use CSS `@theme` for custom tokens and `@source
inline("...")` for classes that only arrive at runtime. Filesystem `@source`
paths and JavaScript `@config` or `@plugin` files are not supported.

```ts
import type { listMessages, receiveMessage } from "./index.ts";
import { array } from "apps";
import { createAppClient, queryReference, mutationReference } from "apps/client";
import { Message } from "./schema.ts";

const client = createAppClient();
const inbox = client.queryAtom(
  queryReference<typeof listMessages>("listMessages"),
  {},
  array(Message),
);
await client.mutate(
  mutationReference<typeof receiveMessage>("receiveMessage"),
  { id: crypto.randomUUID(), subject: "Hello" },
  Message,
);
```

React components use `useAppQuery(inbox)` from `apps/react`. It returns `data`,
`pending`, and `error`, and owns its Effect Atom subscription until unmount.
`apps/react` requires the optional React peer; apps without a UI do not need it.
Use the Promise client methods for one-time reads and explicit writes.

The product host supplies authentication and binds the browser to one configured
app. No app ID, account token or Executor API key belongs in UI code. New
activations reload open app pages. See [the full example](../../playground/demo-apps/live-inbox/ui/main.tsx)
and [hosting notes](../../notes/app-ui.md).

## Webhooks

Expose `webhooks: { issueOpened }` beside queries and mutations. Each definition
has an `account` requirement, `config` and `state` schemas, and async `register`,
`handle`, and `unregister` callbacks. Register and unregister must be idempotent;
handle must verify the provider signature before acting.

The SDK creates durable subscriptions with `executor.webhooks.create`. A
subscription pins its deployment and saved account IDs while resolving fresh
credentials on each invocation. `.many()` sources use one subscription per
selected source account. Local, self-host and cloud use the same author API.
See [the lifecycle and management API](../../notes/webhooks.md) and
[the GitHub/Gmail example](../../playground/demo-apps/issue-mail/webhooks.ts).

Providers without a webhook API can use
`setup: { instructions: "...", signingSecret: "executor" }`
instead of `register` and `unregister`. The private setup page collects the
`state` schema and the signing secret. Agents get a setup link and safe status
through the normal management API. See [manual setup](../../notes/webhooks.md#manual-registration).

## Workflows

Declare `workflow(options, handler)` and register it in `defineApp(...).workflows`.
Use `WorkflowContext<typeof requirements>` for a standalone handler. The body gets
`runId` and `step`. `step.do` supplies fresh accounts and fetch; `step.runQuery`
and `step.runMutation` call registered operations. Durable timers use `step.sleep`
and `step.sleepUntil`.

Start and inspect runs through `executor.apps.workflowRuns`. Inside an app,
queries can inspect `ctx.workflows`; mutations and webhooks can also start and
terminate runs. Workflow execution has no live `elicit` capability.

See [workflow semantics](../../notes/app-workflows.md) for replay, idempotency,
self-host recovery and v1 limits, and the
[repository report example](../../playground/demo-apps/workflow-report/) for a full app.

Local and self-host products run authored apps in Alchemy/workerd, using the
same Worker build format and app-data facets as Cloud. Host filesystem and
subprocess access are unavailable to app code. Agent `execute(code)` continues
to use OpenCode CodeMode.

## App cache and lazy sources

Every app context has `cache`. Keys must contain every input that changes the
result. The host adds app and build isolation. Use `forAccount(account)` for
private data; it also includes the current credential fingerprint. Use the
shared cache for public metadata that is identical across accounts.

```ts
const projects = await ctx.cache.forAccount(ctx.accounts.service).get({
  key: ["projects", region],
  schema: array(object({ id: string(), name: string() })),
  freshFor: "1 minute",
  staleFor: "2 minutes",
  load: async ({ fetch, signal }) => {
    const response = await fetch(urlFor(region), { signal });
    if (!response.ok) throw new Error("Project lookup failed");
    return response.json();
  },
});
```

Use the loader's `fetch`, `signal`, and `cache` for background work. Their
lifetime can outlast the original request. Only successful, schema-valid JSON
is stored. Concurrent misses share a fenced lease. `invalidate(key)` revokes
both a cached value and an in-flight loader's right to publish it. Cache storage
is disposable and bounded: 2 MB per entry, 8 MB per write batch, 128 entries per
batch, 128 MB and 100,000 entries per app, and seven days of retention. Capacity
errors are explicit. Background refreshes have a 30-second deadline.

`read` and `readMany` read retained data without loading it. `write` stores
bounded JSON batches with a retention duration. These support immutable pieces
that must be stored before a manifest becomes visible.

`dynamicTools({ list, resolve })` separates descriptions from executable
operations. `list()` returns tool metadata with qualified names such as
`queries.getProject`. `resolve(name)` returns a query/mutation declaration or
`undefined`. The host validates input and applies approval policy after resolving
an operation. `accountOperations` preserves this separation. Static operations
can run without resolving the source; listings reject duplicate names.

Assign the resolver to the app's `dynamicTools` field. The helper returns only
`list` and `resolve`, never static query or mutation maps. Both static maps are
optional, so an app can contain only dynamic tools.

```ts
export default defineApp(
  { accounts: {} },
  {
    dynamicTools: dynamicTools({
      list: async () => [
        {
          name: "queries.ping",
          description: "Return pong",
          inputSchema: { type: "object", properties: {} },
          readOnly: true,
        },
      ],
      resolve: async (name) =>
        name === "queries.ping" ? query({ input: object({}) }, async () => "pong") : undefined,
    }),
  },
);
```

Names include `queries.` or `mutations.`. `list` describes available tools;
`resolve` returns the matching query or mutation declaration.

`ctx.cache.revalidate(options)` takes the same options as `get`, but always
awaits a refresh. Concurrent refreshes share a load. The previous value stays
available to ordinary readers while refresh runs, and a failed refresh does not
remove it. Use this at an explicit connection or user refresh boundary; it is
not a reason to refresh on every tool call.
