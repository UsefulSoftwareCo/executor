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

`openapiOperations` accepts normalized operations from the template generator,
credential placement metadata, and an optional selected account. It does not
parse a raw OpenAPI specification. `packages/app-templates` owns that compiler.
No extra OpenAPI parser is installed in the app.

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
