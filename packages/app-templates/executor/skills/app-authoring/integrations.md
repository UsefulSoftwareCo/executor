# Connect a service

Use this when the user asks you to add a service, often from a setup prompt
copied from the dashboard. Pick the helper below, read the service's
authentication docs, and ask the user how they sign in when it is unclear. Put
that method in `provider.ts` ([accounts.md](accounts.md)); never put a
credential in source. Look up exact helper options with `framework_describe`.

| Interface                   | Helper                                                    |
| --------------------------- | --------------------------------------------------------- |
| Remote MCP server           | `mcpOperations` from `apps/mcp`                           |
| Local MCP process           | `stdioOperations` from `apps/mcp/stdio`                   |
| OpenAPI or Swagger document | `liveOpenapiOperations` from `apps/openapi`               |
| GraphQL endpoint            | `graphqlOperations` from `apps/graphql`                   |
| Anything else               | Queries and mutations with `fetch` ([tools.md](tools.md)) |

## Remote MCP tools

Import `mcpOperations` from `apps/mcp`. Add `@modelcontextprotocol/sdk` (currently
`1.30.0`) to the app's `package.json` dependencies. The dashboard's quick add
generates this for public and OAuth servers. A public server needs no account:

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

Authenticated apps declare `service: provider.many()` and combine discovery
with `accountOperations(accounts.service, account => mcpOperations({ ... }), { signal })`
from `apps`. Each tool takes `{ accountId, input }`: the chosen account ID and the
original upstream input. Same-name tools keep one name with an input schema for
each account. Empty selections expose no tools.

Pass headers derived from that callback's account.
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
Calls are never automatically retried. Upstream form elicitation automatically
uses the running tool context; preserve that context when wrapping generated tools.
Request and response metadata, including approval persistence choices, pass through.
Show approval terms from request metadata to the user. Return a persistence choice
only when the user explicitly selects it; accepting once must not add a saved grant.
Input waits pause the active upstream timeout; the server can impose its own deadline.
Discovery cannot prompt. Remote prompts/resources, sampling and URL-mode elicitation
are not exposed. Stdio uses the separate helper below.

## Local stdio MCP tools

Import `stdioOperations` from `apps/mcp/stdio` and declare
`@modelcontextprotocol/sdk` in the app's dependencies. The HTTP helper never
imports this process adapter. Pass the command, literal arguments, and an
optional working directory. Declare each secret environment variable as a
`secrets` field; pass the chosen `account.fields` as the child's environment
with `provider.many()` and `accountOperations`, as above. Do not embed tokens
in source, command arguments, or working-directory paths. Servers with no
environment fields need no account. Use `framework_describe` for the exact
`stdioOperations` options.

The helper discovers tools with the selected account and starts a
fresh initialized process for each discovery and call. It validates schemas,
retains MCP result semantics, forwards cancellation, and closes the process
on completion, error, or timeout. Arguments are literal; there is no shell.
The process receives the MCP SDK's basic inherited environment plus the
selected fields, not the host's full environment. Stderr is ignored. Edit the
source for server-specific behavior; this helper does not retain sessions
across calls. Process spawning requires a host that provides it, such as the
local Node runtime.

## OpenAPI APIs

Call `liveOpenapiOperations` from `apps/openapi` with `ctx.cache`, `ctx.fetch`,
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

Operations the helper cannot represent, and operations whose security needs
another method, are left out rather than failing the app. Public APIs need no
account: call `liveOpenapiOperations` without `accountOperations` and with
`methods: {}` and `oauth: []`. `openapiOperations` is the lower-level helper for
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

Use `graphqlOperations` from `apps/graphql` with the endpoint, the selected
account's headers, and optional cancellation signal. Declare `graphql`
(currently `16.11.0`) in the app's dependencies. Authenticated apps use
`provider.many()` and `accountOperations` as above; public endpoints need no
account selection.

Helpers are separate subpath imports. Importing `apps` alone does not load
MCP or GraphQL. Optional dependencies must appear in the app's manifest and
resolve from its own installation. A missing peer fails the deployment with
the package to add. A declared `apps` version owns its framework dependencies;
otherwise the host supplies them.

MCP apps pass `ctx.cache.forAccount(account)` to `mcpOperations`. Public
sources without account requirements can pass `ctx.cache`. The helper returns
`{ dynamicTools }`; it lists metadata without compiling every tool, and resolves
one executable for each call. Cached identity includes the server URL, normalized
headers and account ID. Defaults are five minutes fresh plus five minutes stale.

Set `revalidate: true` on a specific `mcpOperations` call to await a new catalog
at a logical connection or explicit refresh boundary. Do not set it on every
app evaluation unless every request must reload discovery. Each HTTP transport
session is short-lived; opening that transport does not force a catalog refresh.
A received `notifications/tools/list_changed` invalidates the retained manifest.
There is no idle background connection, so TTL or explicit refresh covers changes
made while disconnected. A failed explicit refresh retains the previous catalog.
Only metadata is cached; credentials and executable handlers remain invocation-owned.

GraphQL apps use the same cache policy through `graphqlOperations`:

```ts
await graphqlOperations({
  url,
  headers,
  accountId: account.id,
  cache: ctx.cache.forAccount(account),
  signal: ctx.signal,
});
```

The helper returns `{ dynamicTools }`. One introspection request creates a
revision of per-tool definitions. Listing reads those definitions; execution
loads and compiles only the selected query or mutation, without reading the
full introspection schema. The current account supplies execution credentials.
Public apps can use `ctx.cache`. Omitting the cache keeps discovery local to the
current evaluation. Keys include the URL, normalized headers and account ID.

`freshFor`, `staleFor`, and `revalidate: true` have the same meanings as MCP.
GraphQL has no standard schema-change notification, so TTL or an explicit
refresh discovers changed fields and input types. Failed refreshes retain the
previous revision. Cached introspection never caches query or mutation results.
