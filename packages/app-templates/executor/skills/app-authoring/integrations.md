# Connect a service

Use this when the user asks you to add a service, often from a setup prompt
copied from the dashboard. Pick the helper below, read the service's
authentication docs, and ask the user how they sign in when it is unclear. Put
that method in `provider.ts` ([accounts.md](accounts.md)); never put a
credential in source. When the service has a safe current-user or account read,
give the provider a `health` check that calls it ([accounts.md](accounts.md#check-an-account)),
so users can validate credentials before saving and see which account they connected. Look up exact helper options with `framework.describe`.

| Interface                   | Helper                                                    |
| --------------------------- | --------------------------------------------------------- |
| Remote MCP server           | `mcpRouter` from `apps/mcp`                               |
| Local MCP process           | `stdioRouter` from `apps/mcp/stdio`                       |
| OpenAPI or Swagger document | `liveOpenapiRouter` from `apps/openapi`                   |
| GraphQL endpoint            | `graphqlRouter` from `apps/graphql`                       |
| Anything else               | Queries and mutations with `fetch` ([tools.md](tools.md)) |

## Approvals for imported tools

Helpers attach no approval. Wrap the router with `withApprovals` from `apps`
and choose each tool's policy in app code. Ask before every OpenAPI and
GraphQL mutation (non-`GET`/`HEAD` methods and GraphQL mutation fields), and
before MCP tools whose server sets `destructiveHint: true`:

```ts
import { toolAnnotations, withApprovals } from "apps";
import { always } from "apps/operations/approval";

// OpenAPI and GraphQL
withApprovals(await liveOpenapiRouter(options), (tool) =>
  tool.kind === "mutation" ? always() : undefined,
);
// MCP, HTTP or stdio
withApprovals(await mcpRouter(options), (tool) =>
  toolAnnotations(tool)?.destructiveHint === true ? always() : undefined,
);
```

The callback also receives the tool's name relative to the router. Returning
`undefined` keeps the tool's own approval. With accounts, wrap each account's
router inside the `accountRouter` callback, so each account keeps its own
tools' hints. Quick-add MCP apps are generated with the MCP rule above.

## Remote MCP tools

Import `mcpRouter` from `apps/mcp`. Add `@modelcontextprotocol/client` and
`@modelcontextprotocol/core` (currently `2.0.0` for both) to the app's `package.json` dependencies. The dashboard's quick add
generates this for public and OAuth servers. A public server needs no account:

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

Authenticated apps declare `service: provider.many()` and combine discovery
with `tools: await accountRouter(accounts.service, account => mcpRouter({ ... }), { signal })`
from `apps`. Each tool takes `{ accountId, input }`: the chosen account ID and the
original upstream input. Same-name tools keep one name with an input schema for
each account. Empty selections expose no tools.

Pass that callback's `account` with headers derived from it. Headers are only
accepted together with the account they belong to.
OAuth uses `oauth2({ discover: "https://example.com/mcp" })`
and `Authorization: "Bearer " + account.fields.access_token`.
API-key methods use a `secrets` field and the header the server documents,
for example `headers: { "X-API-Key": account.fields.token }`.
The factory runs with each configured app's selected account, so different
accounts can expose different catalogs. Do not keep a global authenticated catalog.

Streamable HTTP and legacy SSE are supported. Every discovery/call owns and
closes its connection. Session-local workflows do not survive separate tool
calls. Results retain MCP `content`, `structuredContent`, `isError`, and `_meta`;
remote tool failures are results, while transport failures reject the call.
A tool's output type describes that whole result, with the server's output schema
under `structuredContent`, and every result is checked against it. Read typed
fields from `result.structuredContent` after checking `result.isError`.
Calls are never automatically retried. Upstream form elicitation automatically
uses the running tool context; preserve that context when wrapping generated tools.
Request and response metadata, including approval persistence choices, pass through.
Show approval terms from request metadata to the user. Return a persistence choice
only when the user explicitly selects it; accepting once must not add a saved grant.
Input waits pause the active upstream timeout; the server can impose its own deadline.
Discovery cannot prompt. Remote prompts/resources, sampling and URL-mode elicitation
are not exposed. Stdio uses the separate helper below.

The helper returns a router. Its title, description and icons come from the
server's `serverInfo`, and its `instructions` become a skill agents can read. To
keep several servers in one app, mount each under a key; tools become
`<key>.<tool>` and a server that cannot be reached is reported without hiding the
others:

```ts
const bearer = (account) => ({ Authorization: "Bearer " + account.fields.access_token });

tools: router({
  linear: await mcpRouter({
    url: "https://mcp.linear.app/mcp",
    account: accounts.linear,
    headers: bearer(accounts.linear),
    cache,
    signal,
  }),
  sentry: router(
    await mcpRouter({
      url: "https://mcp.sentry.dev/mcp",
      account: accounts.sentry,
      headers: bearer(accounts.sentry),
      cache,
      signal,
    }),
    { description: "Errors and releases for the web app" },
  ),
}),
```

## Local stdio MCP tools

Import `stdioRouter` from `apps/mcp/stdio` and declare
`@modelcontextprotocol/client` and `@modelcontextprotocol/core` (currently `2.0.0`
for both) in the app's dependencies. The HTTP helper never
imports this process adapter. Pass the command, literal arguments, and an
optional working directory. Declare each secret environment variable as a
`secrets` field; pass the chosen `account.fields` as the child's environment
with `provider.many()` and `accountRouter`, as above. Do not embed tokens
in source, command arguments, or working-directory paths. Servers with no
environment fields need no account. Use `framework.describe` for the exact
`stdioRouter` options.

The helper discovers tools with the selected account and starts a
fresh initialized process for each discovery and call. It validates schemas,
retains MCP result semantics, forwards cancellation, and closes the process
on completion, error, or timeout. Arguments are literal; there is no shell.
Unlike `mcpRouter`, it does not read the server's `serverInfo` or
`instructions`; describe it with `router(await stdioRouter(...), { title, instructions })`.
The process receives the MCP SDK's basic inherited environment plus the
selected fields, not the host's full environment. Stderr is ignored. Edit the
source for server-specific behavior; this helper does not retain sessions
across calls. Process spawning requires a host that provides it, such as the
local Node runtime.

## OpenAPI APIs

Call `liveOpenapiRouter` from `apps/openapi` with `ctx.cache`, `ctx.fetch`,
the signal and the selected account. It downloads and compiles the definition
inside the app, caching each revision; no extra dependency is needed. Pass the
settings the definition cannot be trusted to decide:

- `source`: `{ url }` for a public definition (up to 40 MB), or `{ document }`.
- `allowedOrigin`: the one origin that may receive credentials. `baseUrl`
  overrides the definition's server.
- `securitySchemes`: usually `components.securitySchemes` from the definition.
- `methods`: which account fields fill each scheme for each `secrets` method,
  e.g. `{ apiKey: [{ scheme: "bearerAuth", field: "token", part: "value", prefix: "" }] }`.
  Basic auth binds `username` and `password` parts.
- `oauth`: names of `oauth2` provider methods, each named like the OpenAPI
  `oauth2` scheme it fills. Declare those methods as in
  [accounts.md](accounts.md#oauth-sign-in), preferring `discover`.
- Optional `fallbackSecurity` when the definition declares no security, and
  `patches` for mistakes in a definition you do not control.
- Optional `kinds`, keyed by operationId, when an operation's HTTP method
  misclassifies it as a query or mutation.

Tools are grouped by the operation's first tag, or its first path segment:
operationId `listProjects` tagged `projects` becomes
`projects.listProjects`, and `accounts_connect` tagged `accounts`
becomes `accounts.connect`. Discover the exact names with search.

Operations the helper cannot represent, and operations whose security needs
another method, are left out rather than failing the app. Public APIs need no
account: call `liveOpenapiRouter` without `accountRouter` and with
`methods: {}` and `oauth: []`. `openapiRouter` is the lower-level helper for
normalized metadata. Use `contentType` to choose an alternate declared request
media type. Binary request bodies and multipart binary fields take base64
strings. Binary responses return `{ base64, contentType }`; text and NDJSON
return text. Success responses have a 16 MiB / 30-second read bound. Live SSE
requires an authored subscription.

OpenAPI apps return documented errors with an exact HTTP status, a required
literal `_tag`, and either a declared string `message` or a schema description.
Local component references and plain `anyOf` alternatives are supported. A matching JSON failure returns its
code, status, and message in MCP's `execution.error.response`. The message comes
from the validated response field, or static documentation when the declaration
has no message field. Messages are limited to 4,096 characters. A body `recovery`
object with non-empty `action` and `instructions` strings is also returned as
`response.recovery`, and `error.message` ends with `Recovery: <action>`. A missing
or malformed `recovery` is ignored. Other payload fields, headers, and stacks are
not forwarded.
Authentication and rate limits keep their existing provider-error handling.
Unknown, malformed, oversized, or stalled error bodies use the generic failure.

Inside an `execute` program's `catch`, CodeMode exposes only `error.message`.
For these declared API errors it contains JSON with `code`, `status`,
`message`, and an optional `recovery`; parse it with `JSON.parse`. Other failures are ordinary diagnostic
strings, so guard that parse. A failed mutation may already have made changes;
inspect its state before retrying.

## GraphQL APIs

Use `graphqlRouter` from `apps/graphql` with the endpoint, the selected
account and its headers, and optional cancellation signal. Declare `graphql`
(currently `16.11.0`) in the app's dependencies. Authenticated apps use
`provider.many()` and `accountRouter` as above; public endpoints need no
account selection.

Helpers are separate subpath imports. Importing `apps` alone does not load
MCP or GraphQL. Optional dependencies must appear in the app's manifest and
resolve from its own installation. A missing peer fails the deployment with
the package to add. A declared `apps` version owns its framework dependencies;
otherwise the host supplies them.

Pass `cache: ctx.cache` to `mcpRouter`. With an account, the helper keeps the
catalog in that account's cache scope, so a token renewal keeps it and a
reconnected account starts fresh. The helper returns a dynamic router; it lists
metadata without compiling every tool, and resolves one executable for each
call. Cached identity is the server URL within that scope; headers and
credentials never enter it. Defaults are five minutes fresh plus five minutes
stale.

Set `revalidate: true` on a specific `mcpRouter` call to await a new catalog
at a logical connection or explicit refresh boundary. Do not set it on every
app evaluation unless every request must reload discovery. Each HTTP transport
session is short-lived; opening that transport does not force a catalog refresh.
A received `notifications/tools/list_changed` invalidates the retained manifest.
There is no idle background connection, so TTL or explicit refresh covers changes
made while disconnected. A failed explicit refresh retains the previous catalog.
Only metadata is cached; credentials and executable handlers remain invocation-owned.

GraphQL apps use the same cache policy through `graphqlRouter`:

```ts
await graphqlRouter({
  url,
  account,
  headers: { Authorization: "Bearer " + account.fields.token },
  cache: ctx.cache,
  signal: ctx.signal,
});
```

The helper returns a dynamic router. One introspection request creates a
revision of per-tool definitions. Listing reads those definitions; execution
loads and compiles only the selected query or mutation, without reading the
full introspection schema. The current account supplies execution credentials.
Public endpoints take no account or headers. Omitting the cache keeps discovery
local to the current evaluation. Keys are the URL within the account's scope.

`freshFor`, `staleFor`, and `revalidate: true` have the same meanings as MCP.
GraphQL has no standard schema-change notification, so TTL or an explicit
refresh discovers changed fields and input types. Failed refreshes retain the
previous revision. Cached introspection never caches query or mutation results.
