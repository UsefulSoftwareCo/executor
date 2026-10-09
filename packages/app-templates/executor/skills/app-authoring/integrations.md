# Connect a service

Use this when the user asks you to add a service, often from a setup prompt
copied from the dashboard. Pick the helper below, read the service's
authentication docs, and ask the user how they sign in when it is unclear. Put
that method in `provider.ts` ([accounts.md](accounts.md)); never put a
credential in source. When the service has a safe current-user or account read,
give the provider a `health` check that calls it ([accounts.md](accounts.md#check-an-account)),
so users can validate credentials before saving and see which account they connected. For an
MCP server, use [`mcpHealth`](#check-an-mcp-account). Look up exact helper options with `framework.describe`.

| Interface                   | Helper                                                    |
| --------------------------- | --------------------------------------------------------- |
| Remote MCP server           | `mcpRouter` from `apps/mcp`                               |
| Local MCP process           | `stdioRouter` from `apps/mcp/stdio`                       |
| OpenAPI or Swagger document | `liveOpenapiRouter` from `apps/openapi`                   |
| GraphQL endpoint            | `graphqlRouter` from `apps/graphql`                       |
| Anything else               | Queries and mutations with `fetch` ([tools.md](tools.md)) |

## OAuth apps the user registers

Every `oauth2` method needs an OAuth client. Executor gets one itself when the
authorization server advertises a `registration_endpoint`, or accepts client ID
metadata documents and the host publishes one: Executor Cloud does, and
self-host does when its operator turns it on. Otherwise the method needs a
client from the user: the connect page asks them to create an OAuth app in the
service's developer settings, add Executor's redirect URI to it, and enter its
client ID and client secret. Public PKCE clients, declared
with `tokenEndpointAuthMethod: "none"`, have no secret. Executor saves the
client after a successful connection and reuses it. Give the user the connect
link as usual; never ask for a client ID or secret in chat.

The redirect URI belongs to the host. The connect page shows it. On hosted
Executor, `accounts.connection` also returns it as `redirectUri`, so you can tell
the user what to register before they open the link. The local server uses
`/api/oauth/callback` on its own origin.

Expect to need a user's client for Google, GitHub and Slack, which offer no
registration, and for services such as Fastmail that accept only clients and
redirect URIs registered in advance. When a service advertises registration but
refuses it, the first connect attempt fails and the page opens the same client
form. Client-credentials methods always take the user's client
([accounts.md](accounts.md#oauth-sign-in)).

## Approvals for imported tools

Helpers attach no approval. Wrap the router with `withApprovals` from `apps`
and choose each tool's policy in app code. Ask before every OpenAPI and
GraphQL mutation (non-`GET`/`HEAD` methods and GraphQL mutation fields), and
before MCP tools whose server sets `destructiveHint: true`:

```ts
import { toolAnnotations, withApprovals } from "apps";
import { always } from "apps/operations/approval";

// OpenAPI and GraphQL. liveOpenapiRouter returns the router; the other helpers return a Promise.
withApprovals(liveOpenapiRouter(options), (tool) =>
  tool.kind === "mutation" ? always() : undefined,
);
// MCP, HTTP or stdio
withApprovals(await mcpRouter(options), (tool) =>
  toolAnnotations(tool)?.destructiveHint === true ? always() : undefined,
);
```

To ask before every MCP tool the server does not mark read-only, including tools
with no hints, invert the rule:

```ts
withApprovals(await mcpRouter(options), (tool) =>
  toolAnnotations(tool)?.readOnlyHint === true ? undefined : always(),
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
each account. Empty selections expose no tools. The callback may return the
router or a Promise of it, and may return a `router` of your own queries and
mutations; `defineApp` checks their handler contexts as for any router.

Pass that callback's `account` with headers derived from it. Headers are only
accepted together with the account they belong to.
OAuth uses `oauth2({ discover: "https://example.com/mcp" })`
and `Authorization: "Bearer " + account.fields.access_token`.
API-key methods use a `secrets` field and the header the server documents,
for example `headers: { "X-API-Key": account.fields.token }`.

When quick add refuses a server, its reason names what the server answered
without credentials. A 401 with a Bearer challenge and no OAuth metadata means
a key sent as `Authorization: "Bearer " + ...`; confirm the header in the
service's documentation. A 403 web page means a firewall refused Executor's
check, not that a key is needed. A public server that also offers OAuth is
added without an account; its `provider.ts` keeps the discovered OAuth.
The factory runs with each configured app's selected account, so different
accounts can expose different catalogs. Do not keep a global authenticated catalog.

### Check an MCP account

Give an authenticated MCP provider `mcpHealth` from `apps/mcp` as its `health`
check. It connects to the server with the account's headers, initializes, and
reads the first page of tools. Then it does the same without any headers, to
show that the server needs the credentials. No tool runs. Do not check MCP accounts with the
vendor's REST or GraphQL API: an MCP OAuth token is often valid only for the MCP
server it was issued for. Do not import `@modelcontextprotocol/sdk` to write
your own check.

```ts
import { defineProvider, oauth2 } from "apps";
import { mcpHealth } from "apps/mcp";

export const url = "https://mcp.example.com/mcp";
export const headers = (account: { fields: { access_token: string } }) => ({
  Authorization: "Bearer " + account.fields.access_token,
});

export const provider = defineProvider({
  name: "Example",
  hosts: ["mcp.example.com"],
  auth: { oauth: oauth2({ discover: url }) },
  health: (check) => mcpHealth(check, { url, headers: headers(check.account) }),
});
```

Pass the check context `health` receives as the first argument. `mcpHealth`
reads the account, `signal` and `deadline` from it: both checks share the time
Executor gives the account check and stop early enough to report a server that
did not answer in time. Use the same `url` and `headers` in `mcpRouter`. Send
credentials only in `headers`: the check without them uses the same `url`. Do
not set `timeoutMs` for a longer wait: it can only shorten that time.

With the account's headers, a refused token reports rejected credentials, an
`insufficient_scope` challenge a missing permission, and 429 or 5xx an
unavailable service. The check stops there. A server that cannot be reached, or
answers in a way Executor cannot use, means the check could not verify the
account. The account form shows why.

When the server accepts the account, the check passes only if the server
refuses the same requests without credentials (401 or 403, while initializing or
listing tools). Some servers answer without credentials, so a wrong key would
pass as well. The check then could not verify the account, and the form says:
"This MCP server answers without credentials, so Executor can't check this
account. A refused key will show up when a tool is called." It also could not
verify the account if the requests without credentials time out or fail in any
other way, such as 429 or 5xx; the form names that failure. MCP has no standard
current-user request, so the check reports no account name. Quick-add OAuth apps
are generated with this check.

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
the signal and the selected account. It returns the router at once, then
downloads and compiles the definition inside the app when its tools are listed
or called, caching each revision; no extra dependency is needed. Pass the
settings the definition cannot be trusted to decide:

- `source`: `{ url }` for a public definition (up to 40 MB), or `{ document }`:
  Swagger 2.0 or OpenAPI 3.0, 3.1 or 3.2. The `url` is fetched without account
  credentials; see [private definitions](#private-definitions).
- `allowedOrigin`: the one origin that may receive credentials. `baseUrl`
  overrides the definition's server.
- `securitySchemes`: usually `components.securitySchemes` from the definition.
- `methods`: which account fields fill each scheme for each `secrets` method,
  e.g. `{ apiKey: [{ scheme: "bearerAuth", field: "token", part: "value", prefix: "" }] }`.
  Basic auth binds `username` and `password` parts.
  An `oauth2` method can fill a scheme here too, through its `access_token`
  field. Use this when the definition declares only an http bearer scheme:
  `{ oauth: [{ scheme: "bearerAuth", field: "access_token", part: "value", prefix: "" }] }`.
  List such a method in `methods` only, not in `oauth`.
- `oauth`: names of `oauth2` provider methods, each named like the OpenAPI
  `oauth2` scheme it fills. This fills only `oauth2` and OpenID Connect schemes.
  Declare those methods as in [accounts.md](accounts.md#oauth-sign-in),
  preferring `discover`.
- Optional `fallbackSecurity` when the definition declares no security, and
  `patches` for mistakes in a definition you do not control.
- Optional `pathPrefix`, such as `/projects/{project}`, when the definition's
  paths omit leading segments. It goes between the server and every path; each
  `{name}` becomes a required path parameter of every tool.
- Optional `kinds`, keyed by operationId, when an operation's HTTP method
  misclassifies it as a query or mutation.

Tools are grouped by the operation's first tag, or its first path segment:
operationId `listProjects` tagged `projects` becomes
`projects.listProjects`, and `accounts_connect` tagged `accounts`
becomes `accounts.connect`. Both parts are camelCased from their words: tag
`Team Members` with operationId `list_team_members` becomes
`teamMembers.listTeamMembers`, and `GetUserByID` becomes `getUserById`.
Without an operationId the name comes from the method and path. Names that
collide, whether or not they come from operationIds, are told apart in this
order: first the path's version segment, as in `users.v2.listUsers`; then the
path segments that differ, so `GET /builds` and `GET /builds/{build_num}` become
`builds.getBuilds` and `builds.getBuildsByBuildNum`; then the whole path; then
the HTTP method; then a stable hash. Each step applies only to names that still
collide. `kinds` still uses the original operationId. Discover the exact names
with search, or before an account connects as below.

Operations the helper cannot represent, and operations whose security needs
another method, are left out rather than failing the app. Reading or calling a
left-out operation's tool fails with why, such as the JSON Pointer of an
invalid schema. When none can be imported, the router's error lists the
operations left out and why, and the origins the operations use when none
matches `allowedOrigin`. Public APIs need no
account: call `liveOpenapiRouter` without `accountRouter` and with
`methods: {}` and `oauth: []`. `openapiRouter` is the lower-level helper for
normalized metadata. Use `contentType` to choose an alternate declared request
media type. Binary request bodies and multipart binary fields take base64
strings. Binary responses return `{ base64, contentType }`; text and JSON
sequences (NDJSON, JSON Lines, `json-seq`) return text. Success responses have
a 16 MiB / 30-second read bound. Live SSE
requires an authored subscription.

A call resolves to the response body itself, never `{ status, body }`: parsed
JSON, text, the binary object above, or `null` for 204 and `HEAD`. A failure
status rejects the call instead. The output type comes from the definition's
success responses. When one declares no content, or JSON content without a
schema, the signature says `Promise<unknown>`. Results are not checked against
the declared schema, so check the fields you use.

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
Unknown, malformed, oversized, or stalled error bodies use the generic failure. It
names the operation's method and templated path, such as `GET /items/{item}`, and
the response's status, media type, and declared length, but never its body.

Inside an `execute` program's `catch`, CodeMode exposes only `error.message`.
For these declared API errors it contains JSON with `code`, `status`,
`message`, and an optional `recovery`; parse it with `JSON.parse`. Other failures are ordinary diagnostic
strings, so guard that parse. A failed mutation may already have made changes;
inspect its state before retrying.

### Tool names before an account connects

An account's tools are listed only once it connects. `openapiToolNames` from
`apps/openapi` reads the definition with the router's options, minus `cache`,
`account` and `parameterDefaults`, and resolves to `{ tools, skipped }`. Each
tool has its `name` as `withApprovals` receives it, `method`, `path` (with any
`pathPrefix`), `kind`, and which `methods` and `oauth` entries expose it
(`public` when it needs no credentials). `skipped` lists only the operations the
compiler left out, and why. An operation that no `methods` or `oauth` entry can
authorize is missing from `tools` and not listed in `skipped`. To check the
names an approval policy uses before deploying, keep the options and the policy
in their own module:

```ts
// openapi.ts; index.ts imports it as "./openapi.js"
import type { OpenapiToolNamesOptions } from "apps/openapi";
import { always } from "apps/operations/approval";

export const options = {
  source: { url: "https://api.example.com/openapi.json" },
  allowedOrigin: "https://api.example.com",
  securitySchemes: {},
  methods: {},
  oauth: [],
} satisfies OpenapiToolNamesOptions;
export const approvals = new Map([["projects.deleteProject", always()]]);
```

In `index.ts`, wrap the router with
`withApprovals(liveOpenapiRouter({ ...options, cache, fetch, signal, account }), (_, name) => approvals.get(name))`.
After installing the app's packages as in [deploy.md](deploy.md), run this in
the app directory with Node.js 22.18 or newer:

```sh
node --input-type=module -e '
import { openapiToolNames } from "apps/openapi";
import { approvals, options } from "./openapi.ts";
const names = new Set((await openapiToolNames(options)).tools.map((tool) => tool.name));
const unknown = [...approvals.keys()].filter((name) => !names.has(name));
if (unknown.length) throw new Error(`No tools named ${unknown.join(", ")}`);
console.log([...names].join("\n"));'
```

### Custom tools beside generated ones

Mount the generated router under a key next to hand-written queries and
mutations ([tools.md](tools.md)):

```ts
tools: router({
  weeklySummary,
  api: await accountRouter(
    accounts.service,
    (account) => liveOpenapiRouter({ ...options, cache, fetch, signal, account }),
    { signal },
  ),
}),
```

The key renames every generated tool: `projects.listProjects` becomes
`api.projects.listProjects`. Update skills and callers that use the old names.

### Private definitions

When the definition itself needs the account's credentials, load it in a cache
scoped to the account and pass it as `source: { document }`. `record(json())`
from `apps` accepts any JSON object:

```ts
async (account) => {
  const url = "https://api.example.com/openapi.json";
  const document = await cache.forAccount(account).get({
    key: ["openapi-definition", url],
    schema: record(json()),
    freshFor: "1 hour",
    load: async ({ fetch, signal }) =>
      decodeJson(
        await fetch(url, { signal, headers: { Authorization: `Bearer ${account.fields.token}` } }),
        record(json()),
      ),
  });
  return liveOpenapiRouter({ ...options, source: { document }, cache, fetch, signal, account });
};
```

A cache entry holds up to 2 MB. Reconnecting the account starts an empty scope.

### Session cookies

For a service that exchanges a username and password for a session cookie,
declare both as `secrets` fields with the service's `hosts`. Sign in from a
cache loader, then pass `liveOpenapiRouter` a `fetch` that adds the cookie.
Clear the definition's security so operations need no declared scheme:

```ts
async (account) => {
  const sessions = cache.forAccount(account);
  const session = () =>
    sessions.get({
      key: ["session"],
      schema: string(),
      freshFor: "20 minutes", // shorter than the service's session lifetime
      load: async ({ fetch, signal }) => {
        const response = await fetch("https://app.example.com/api/login", {
          method: "POST",
          signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            username: account.fields.username,
            password: account.fields.password,
          }),
        });
        if (!response.ok) throw new Error(`Sign-in failed with status ${response.status}.`);
        const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]);
        if (cookies.length === 0) throw new Error("Sign-in returned no session cookie.");
        return cookies.join("; ");
      },
    });
  return liveOpenapiRouter({
    source: { url: "https://app.example.com/openapi.json" },
    allowedOrigin: "https://app.example.com",
    securitySchemes: {},
    methods: {},
    oauth: [],
    patches: [{ op: "add", path: "/security", value: [] }],
    cache,
    signal,
    account,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("cookie", await session());
      const response = await fetch(input, { ...init, headers });
      // An expired session signs in again on the next call.
      if (response.status === 401) await sessions.invalidate(["session"]);
      return response;
    },
  });
};
```

The patch replaces only the document's top-level `security`; patch any
operation that declares its own. Give the provider a `health` check that signs
in the same way, so the account form reports refused credentials.

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
