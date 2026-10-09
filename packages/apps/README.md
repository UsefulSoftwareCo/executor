# Apps

Author apps with ordinary TypeScript and Promises. Framework operations use
Effect v4 internally. The root export contains declarations and schemas;
protocol helpers have separate entry points.

Install the exact version your Executor host runs: agents read it with the
Executor app's `framework.release`, and `executor apps framework` prints it. Run
`npm install --save-exact apps@<version>` and declare the same version in the
app's `package.json`. Do not install `apps@latest`; that tag is an unrelated,
earlier package. The package includes `framework-reference.json`, generated from
these declarations. The Executor app's `app-authoring` skill is the authoring
guide; [Author an app](https://v2.executor.sh/docs/author-an-app) summarizes
it. In this repository, `bun run pack` builds a local tarball.

```ts
import { defineApp } from "apps";
import { mcpRouter } from "apps/mcp";

export default defineApp({ accounts: {} }, async ({ signal }) => ({
  tools: await mcpRouter({
    url: "https://mcp.deepwiki.com/mcp",
    ...(signal === undefined ? {} : { signal }),
  }),
}));
```

| Import           | Helper                   | App dependency                                               |
| ---------------- | ------------------------ | ------------------------------------------------------------ |
| `apps/mcp`       | `mcpRouter`, `mcpHealth` | `@modelcontextprotocol/client`, `@modelcontextprotocol/core` |
| `apps/mcp/stdio` | `stdioRouter`            | `@modelcontextprotocol/client`, `@modelcontextprotocol/core` |
| `apps/graphql`   | `graphqlRouter`          | `graphql`                                                    |
| `apps/openapi`   | `liveOpenapiRouter`      | None                                                         |

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
then retain the executable Worker modules. Every app declares the exact `apps`
version in `package.json`; it selects the framework for both server and browser
code and keeps rebuilds repeatable. A build without it fails and names the
version the host ships.
In this repository, playground workspaces use `"apps": "workspace:*"` for development;
replace that workspace reference with a released version before deployment.

`liveOpenapiRouter` reads an OpenAPI document through `ctx.cache`. Generated
imports retain a source URL, allowed origin, and static credential bindings in
`openapi.json`. The framework compiles a revision on a cache miss. It writes each
operation and shared schema before publishing the current revision. A warm call
reads that revision and the requested operation's schema dependencies. It does
not download, parse, or read the full catalog. `openapiRouter` remains the
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

Authenticated templates use `provider.many()` and `accountRouter` from `apps`:

```ts
export default defineApp(
  { accounts: { service: provider.many() } },
  async ({ accounts, signal }) => ({
    tools: await accountRouter(
      accounts.service,
      (account) =>
        mcpRouter({
          url: "https://example.com/mcp",
          account,
          headers: { Authorization: "Bearer " + account.fields.token },
          signal,
        }),
      { signal },
    ),
  }),
);
```

MCP and GraphQL helpers take the account their headers come from, and accept
`cache: ctx.cache`; an account's catalog is kept in that account's scope and
credentials never enter its key. They return a dynamic router, cache remote
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
Human approval delivery is separate; Executor SDK call/resume persists the pending invocation.
See [Tools and approvals](https://v2.executor.sh/docs/concepts/tools-and-approvals).

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
activations reload open app pages. The `live-inbox` example in `framework-reference.json` is a complete app with a UI.

## Webhooks

Expose `webhooks: { issueOpened }` beside `tools`. Each definition
has an `account` requirement, `config` and `state` schemas, and async `register`,
`handle`, and `unregister` callbacks. Register and unregister must be idempotent;
handle must verify the provider signature before acting.

The SDK creates durable subscriptions with `executor.webhooks.create`. A
subscription pins its deployment and saved account IDs while resolving fresh
credentials on each invocation. `.many()` sources use one subscription per
selected source account. Local, self-host and cloud use the same author API.
The app-authoring skill's `webhooks.md` covers the lifecycle and examples.

Providers without a webhook API can use
`setup: { instructions: "...", signingSecret: "executor" }`
instead of `register` and `unregister`. The private setup page collects the
`state` schema and the signing secret. Agents get a setup link and safe status
through the normal management API.

## Workflows

Declare `workflow(options, handler)` and register it in `defineApp(...).workflows`.
Use `WorkflowContext<typeof requirements>` for a standalone handler. The body gets
`runId` and `step`. `step.do` supplies fresh accounts and fetch; `step.runQuery`
and `step.runMutation` call registered operations. Durable timers use `step.sleep`
and `step.sleepUntil`.

Start and inspect runs through `executor.apps.workflowRuns`. Inside an app,
queries can inspect `ctx.workflows`; mutations and webhooks can also start and
terminate runs. Workflow execution has no live `elicit` capability.

The app-authoring skill's `workflows.md` covers replay, idempotency and limits.

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

## Routers

An app's `tools` is a router. Keys form tool paths, and routers nest like tRPC's:
`router({ health, issues: router({ list, close }, { description }) })` exposes
`health`, `issues.list` and `issues.close`. Each query or mutation keeps its own
kind; names carry no `queries.` or `mutations.` prefix. Router options are
`title`, `description`, `instructions`, `icons` and `tags`. Instructions become a
skill named `tools` for the root router and `tools-<path>` below it, such as
`tools-issues`. Paths other than lowercase letters and digits get a slug and a
hash of the path, so names never collide. An authored skill with the same name
replaces the generated one. `router(source, options)` overrides a source's
metadata. Keys `__proto__`, `constructor` and `prototype` are reserved, and an
mutation can be mounted at only one path.

Protocol helpers return routers, so an app mounts several sources under keys.
`mcpRouter` takes its title, description, icons and instructions from the
server, and `liveOpenapiRouter` from the document's `info` and tags. `stdioRouter`,
`openapiRouter` and `graphqlRouter` carry no source metadata. A nested router that fails to load is reported on its own catalog entry;
the app's other tools still load. The root failing fails discovery.

`dynamicRouter({ list, resolve })` separates descriptions from executable
operations. `list()` returns tool metadata with names relative to the router,
such as `getProject`; names may contain dots. `resolve(name)` returns a
query/mutation declaration or `undefined`. The host validates input and applies
approval policy after resolving an operation. `accountRouter` preserves this
separation. Static operations run without resolving a source; listings reject
duplicate names.

```ts
export default defineApp(
  { accounts: {} },
  {
    tools: dynamicRouter({
      list: async () => [
        {
          name: "ping",
          description: "Return pong",
          inputSchema: { type: "object", properties: {} },
          readOnly: true,
        },
      ],
      resolve: async (name) =>
        name === "ping" ? query({ input: object({}) }, async () => "pong") : undefined,
    }),
  },
);
```

Mark queries with `readOnly: true`; other listed tools are mutations. `list`
describes available tools; `resolve` returns the matching declaration. An
optional `meta()` returns the router's title, description and instructions.

`ctx.cache.revalidate(options)` takes the same options as `get`, but always
awaits a refresh. Concurrent refreshes share a load. The previous value stays
available to ordinary readers while refresh runs, and a failed refresh does not
remove it. Use this at an explicit connection or user refresh boundary; it is
not a reason to refresh on every tool call.
