## Remote MCP tools

Import `mcpOperations` from `apps/mcp`. Add `@modelcontextprotocol/sdk` (currently
`1.30.0`) to the app's `package.json` dependencies. Custom Add generates this
manifest and the app/provider source. A public server needs no account:

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

Authenticated templates declare `service: provider.many()` and combine discovery
with `accountOperations(accounts.service, account => mcpOperations({ ... }), { signal })`
from `apps`. Each tool takes `{ accountId, input }`: the chosen account ID and the
original upstream input. Same-name tools keep one name with an input schema for
each account. Empty selections expose no tools.

Pass headers derived from that callback's account.
OAuth uses `oauth2({ discover: "https://example.com/mcp" })`
and `Authorization: "Bearer " + account.fields.access_token`.
API-key methods use their declared fields and the server's required headers.
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
`@modelcontextprotocol/sdk` in the app's dependencies. The local product's
**Custom app → MCP → Local process (stdio)** generates `index.ts`, an optional
`provider.ts`, and `package.json`. The HTTP helper never imports this process adapter.

Declare environment variable names in the form. The generated provider stores
their values as accounts and passes the chosen `account.fields` to the child.
The generated app uses `provider.many()` and `accountOperations`, as above.
Do not embed tokens in source, command arguments, or working-directory paths.
Servers with no environment fields need no account.

The helper discovers tools with the selected account and starts a
fresh initialized process for each discovery and call. It validates schemas,
retains MCP result semantics, forwards cancellation, and closes the process
on completion, error, or timeout. Arguments are literal; there is no shell.
The process receives the MCP SDK's basic inherited environment plus the
selected fields, not the host's full environment. Stderr is ignored. Edit the
source for server-specific behavior; this template does not retain sessions
across calls. Process spawning requires a host that provides it, such as the
local Node runtime.

## GraphQL and OpenAPI helpers

Use `graphqlOperations` from `apps/graphql` with the endpoint, selected account's
headers, and optional cancellation signal. Declare `graphql` (currently
`16.11.0`) in the app's dependencies.

Use `liveOpenapiOperations` from `apps/openapi` with `ctx.cache`, the generated
`openapi.json` configuration, and the selected account. Custom Add retains the
source URL, allowed origin, and static authentication bindings. The framework
refreshes compiled revisions through the app cache. A call reads one operation
and only the shared definitions it needs. Live metadata cannot move credentials
to another origin or change their header placement. No extra dependency is needed.
`openapiOperations` is the lower-level helper for normalized metadata.
Use `contentType` to choose an alternate declared request media type. Binary
request bodies and multipart binary fields take base64 strings. Binary responses
return `{ base64, contentType }`; text and NDJSON return text. Success responses
have a 16 MiB / 30-second read bound. Live SSE requires an authored subscription.
Existing retained apps keep their source and bundled helper until redeployment.

OpenAPI imports retain documented errors with an exact HTTP status, a required
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
inspect its state before retrying. Existing imports need regenerated metadata
and a new deployment to gain this behavior.

Authenticated GraphQL and OpenAPI templates also use `provider.many()` and
`accountOperations`. Public templates keep their original tool inputs and need
no account selection. Existing apps change only when their source is edited and
deployed again.

Helpers are separate subpath imports. Importing `apps` alone does not load
MCP or GraphQL. Optional dependencies must appear in the app's manifest and
resolve from its own installation. A missing peer fails the deployment with
the package to add. A declared `apps` version owns its framework dependencies;
otherwise the host supplies them.

MCP imports pass `ctx.cache.forAccount(account)` to `mcpOperations`. Public
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
Existing generated apps need the cache option added and a new deployment.
