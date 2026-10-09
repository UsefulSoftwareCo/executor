## Use a provider account

Declare the provider's credential shape in source. The host derives its provider
ID, stores account credentials and supplies a selected account on each call.
Never put real tokens into source files or return them from tools.

**The provider ID comes from the whole definition except `hosts`, including
`name`, labels and OAuth `scopes`.** Changing any of them after users connect
gives a new provider, and existing accounts no longer fit the slot. Users must
connect a new account. Settle these before users connect.

This is a complete `index.ts` for Vercel with an API token:

```ts
import {
  query,
  type QueryContext,
  array,
  decodeJson,
  defineApp,
  defineProvider,
  object,
  secrets,
  string,
  router,
} from "apps";

const vercel = defineProvider({
  name: "Vercel",
  auth: {
    apiKey: secrets({
      label: "API token",
      fields: object({ token: string({ minLength: 1 }) }),
    }),
  },
});

const requirements = { accounts: { vercel } };
type Context = QueryContext<typeof requirements>;
const Projects = object({ projects: array(object({ id: string(), name: string() })) });
const listProjects = query(
  { description: "List projects accessible to the selected Vercel account", input: object({}) },
  async ({ accounts, fetch }: Context) => {
    const response = await fetch("https://api.vercel.com/v9/projects?limit=10", {
      headers: { Authorization: `Bearer ${accounts.vercel.fields.token}` },
    });
    return decodeJson(response, Projects);
  },
);

export default defineApp(requirements, { tools: router({ listProjects }) });
```

## Limit where credentials go

Declare `hosts` so app code never holds the secret values. Each unmarked string
field then reaches the app as an opaque handle. Executor's network replaces a
handle with the real value only on requests to a declared host, in the URL,
headers, Basic credentials, and JSON, form or text bodies up to 1 MiB. Executor
refuses a request that sends a handle anywhere else: `ctx.fetch` rejects with
`NetworkRefused`, naming the host and the provider's allowed hosts, and the
global `fetch` receives status 421 with the same details. Values the service
echoes back reach the app as handles.

**Adding a host to a provider that already declares hosts means users must
connect existing accounts again.** Each account keeps the hosts it was connected
with, so Executor refuses requests that send its credentials to the new host
until it is reconnected. Declare every host the app needs before users connect
accounts.

```ts
import { defineProvider, object, plain, raw, secrets, string } from "apps";

const example = defineProvider({
  name: "Example",
  hosts: ["api.example.com", "*.example.com"],
  auth: {
    apiKey: secrets({
      label: "API key",
      fields: object({
        region: plain(string()), // not secret; the app reads it and the form shows it
        token: string(), // secret: the app reads a handle
        signingKey: raw(string()), // secret the app must read, such as a signing key
      }),
    }),
  },
});
```

A host is an exact name, `host:port`, or `*.` plus a domain for one level of
subdomain. Pass handles to headers and clients as ordinary strings. Do not
decode, hash or sign them; mark such a field `raw()`, and the connect form
warns that the app can read it. Multipart and streamed bodies are sent
unchanged. A provider without `hosts` gives app code real values unless the
account was connected with hosts. Changing `plain()` or `raw()` changes the
provider, so existing accounts must be connected again.

Basic credentials work with handles. Encode `username:password` with `btoa` as
usual; Executor decodes a `Basic` `Authorization` header, replaces the handles
inside it and encodes it again. This [check](#check-an-account) sends a
`secrets` method's `username` and `password` fields to a declared host:

```ts
async health({ account, fetch, signal }) {
  const basic = btoa(`${account.fields.username}:${account.fields.password}`);
  const response = await fetch("https://api.example.com/v1/me", {
    signal,
    headers: { Authorization: `Basic ${basic}` },
  });
  const me = await decodeJson(response, object({ id: string(), email: string() }));
  return { accountInfo: { externalId: me.id, email: me.email } };
},
```

## Check an account

Give a provider a `health` function so Executor can tell whether a saved account
works before an agent's tool call fails. Make one safe authenticated read with no
side effects, such as the service's current-user endpoint. Returning passes.
Returning `accountInfo` also names the upstream account; Executor offers it as the
account's name and shows it beside the account. Every field is optional:
`externalId`, `displayName`, `username`, `email`, `avatarUrl` and `profileUrl`.

```ts
import { ProviderError, decodeJson, defineProvider, object, secrets, string } from "apps";

const User = object({ id: string(), username: string(), name: string(), email: string() });

const vercel = defineProvider({
  name: "Vercel",
  auth: {
    apiKey: secrets({
      label: "API token",
      fields: object({ token: string({ minLength: 1 }) }),
    }),
  },
  async health({ account, fetch, signal }) {
    const response = await fetch("https://api.vercel.com/v2/user", {
      signal,
      headers: { Authorization: `Bearer ${account.fields.token}` },
    });
    // Vercel answers an unknown or revoked token with 403 and `invalidToken: true`.
    if (response.status === 403 && (await response.json()).error?.invalidToken === true)
      throw new ProviderError({ reason: "unauthorized", status: 403 });
    const { user } = await decodeJson(response, object({ user: User }));
    return {
      accountInfo: {
        externalId: user.id,
        displayName: user.name,
        username: user.username,
        email: user.email,
      },
    };
  },
});
```

`account` is typed from `auth`; with several methods, switch on `account.method`.
A failed `decodeJson` status is classified for you: 401 means the credentials were
refused, 429 and 5xx mean the service is unavailable. Otherwise throw
`new ProviderError({ reason, status })` with the reason the service's evidence
supports:

| `reason`       | Use it when                                                      | Check status           |
| -------------- | ---------------------------------------------------------------- | ---------------------- |
| `unauthorized` | the service refused the credentials                              | `credentials_rejected` |
| `forbidden`    | explicit evidence of a missing permission (`insufficient_scope`) | `forbidden`            |
| `rate_limited` | the service is limiting requests                                 | `upstream_unavailable` |
| `unavailable`  | a server error or outage                                         | `upstream_unavailable` |
| `rejected`     | the service refused without saying why, such as a bare 403       | `check_failed`         |

A bare 403 is not enough for `forbidden`. Services that answer a bad token with
something other than 401, as Vercel does, need an explicit `unauthorized`. Tool
calls that fail with `rate_limited` or `unavailable` tell the agent to retry
later. `ProviderError` carries only its reason and optional HTTP status, never a
message.

Decode only the fields the check reads; `object()` drops the rest. A field the
service may return as `null` fails both `string()` and `string().optional()`,
which accepts only a missing field. There is no nullable helper, so declare it
with `json()` and use it only when it is a string. Each `accountInfo` value must
be a non-empty string of at most 255 characters, and its URLs must be http(s);
an invalid value fails the check, so leave such fields out:

```ts
const { user } = await decodeJson(
  response,
  object({ user: object({ id: string(), name: json() }) }),
);
const name = typeof user.name === "string" && user.name !== "" ? user.name : undefined;
return {
  accountInfo: { externalId: user.id, ...(name === undefined ? {} : { displayName: name }) },
};
```

To tell the user why the check failed, throw an ordinary `Error` with a message written for them.
The account form shows it after "Couldn't verify this API token:". Read the service's documented
error fields to choose the message; do not copy a response body, URL or credential into it.
Executor replaces the checked credentials if they appear, and shortens long messages.

```ts
if (response.status === 403 && (await response.json()).error?.code === "missing_scope")
  throw new Error("This token lacks the accounts scope. Create a token with accounts:read.");
```

Any error or a timeout means the check could not verify the account.
Executor never treats that as bad credentials. The check also receives `deadline`, the time in
epoch milliseconds when Executor stops waiting for it. A check still running then fails without a
message, so a check that waits on its own timer should end before it to say why.

Account forms run the same check on entered credentials before saving them, so the user sees
whether they work, and the name they belong to, before connecting.

For an MCP server, use `mcpHealth` from `apps/mcp` instead of a REST or GraphQL
read: `health: (check) => mcpHealth(check, { url, headers: headers(check.account) })`.
It takes the account, `signal` and `deadline` from the check context; see
[integrations.md](integrations.md#check-an-mcp-account). It verifies an account
only on a server that refuses requests without credentials. On a server that
answers anyone, it reports that it could not verify the account.

Each app checks with its own `health` function, so two apps can verify the same
account differently. Adding or editing `health` does not change the provider's
identity or disconnect accounts; it only makes earlier results outdated.

## OAuth sign-in

Prefer discovery. When the service publishes OAuth authorization server or OpenID
metadata, point `discover` at its issuer or MCP URL. Executor then reads the real
issuer, endpoints and supported client authentication, and checks the service's
responses against them:

```ts
const searchConsole = defineProvider({
  name: "Google Search Console",
  auth: {
    oauth: oauth2({
      discover: "https://accounts.google.com",
      scopes: ["https://www.googleapis.com/auth/webmasters"],
      // Google issues refresh tokens only when asked for offline access.
      authorizationParams: { access_type: "offline", prompt: "consent" },
    }),
  },
});
```

Check for metadata at `<issuer>/.well-known/oauth-authorization-server` or
`<issuer>/.well-known/openid-configuration`. The issuer is often the host of the
sign-in page, not the token URL: Google signs in at `accounts.google.com` and
issues tokens from `oauth2.googleapis.com`. List the scopes the app needs;
discovery only fills them in when the service advertises scopes for the resource.

When the service publishes its metadata at a nonstandard location, keep `discover`
pointing at the MCP resource or issuer and declare the exact document URL:

```ts
oauth2({
  discover: "https://mcp.example.com",
  authorizationServerMetadataUrl: "https://auth.example.com/oauth/.well-known/openid-configuration",
  scopes: ["reports:read", "offline_access"],
});
```

The host still checks the document's `issuer` against the issuer discovered from
`discover`. It applies its network policy and never follows a redirect or falls
back to another document when the explicit URL fails. Signing algorithms and
JWKS come from the validated metadata; validation cannot be disabled.

For MCP discovery, explicit `scopes` take precedence over the resource's Bearer
challenge scope, which takes precedence over its protected-resource metadata
`scopes_supported`. Authorization-server supported scopes are not requested
wholesale. Keep `openid`, `profile` and `email` only when the service or app needs
identity; an access-token-only app can declare its resource scopes explicitly.
The host adds `offline_access` when advertised and `scopes` is omitted.

Standard discovery requires the metadata's `issuer` to equal the issuer used to
construct the well-known metadata URL.
Microsoft Entra ID's multi-tenant `common` and `organizations` endpoints publish
the template `https://login.microsoftonline.com/{tenantid}/v2.0` instead, which
discovery accepts. Its `consumers` endpoint names a different issuer in its
metadata and fails the check: declare its endpoints and issuer.

`authorizationParams` adds service-defined parameters to the sign-in request,
from the service's docs. Use it for settings such as offline access or a
service's own selector, for example `{ providers: "..." }`. It works with
`discover` and with declared endpoints. Executor sets the protocol parameters
itself, so these names are rejected: `response_type`, `client_id`,
`redirect_uri`, `state`, `scope`, `code_challenge`, `code_challenge_method`,
`nonce`, `resource`, `request` and `request_uri`. Use `scopes` and `resource`
for those settings instead.

Declare `authorizationUrl`, `tokenUrl` and `scopes` only when the service
publishes no metadata. Then set `tokenEndpointAuthMethod` to what its docs say
the token endpoint accepts (`client_secret_basic`, `client_secret_post`, or `none`
for public PKCE clients), and `issuer` when the docs name one, so Executor can
check the service's `iss` responses. Without `issuer` those checks are skipped.
Do not copy endpoints from an OpenAPI `oauth2` scheme without checking the
service's docs; those schemes carry no issuer or client authentication.

A declared `authorizationUrl` may include a query string, such as
`https://auth.example.com/authorize?tenant=acme`; Executor keeps it and adds the
protocol parameters. Prefer `authorizationParams` for service settings. Declare
each parameter in one place: a name in both the URL and `authorizationParams`,
or a protocol parameter in the URL, fails the build.

Some services read OAuth requests or answer them differently from the
standard. Declare the difference from the service's docs; do not work around it
in app code:

- `scopeSeparator: ","` joins `scopes` with commas on the sign-in request, as
  Linear requires. The default is a space.
- `tokenRequestFormat: "json"` sends token requests (sign-in, renewal and
  client credentials) as a JSON object, as Atlassian, ClickUp and Notion
  require. The default is a form.
- `tokenResponse: { path: "authed_user" }` reads the grant from a nested member
  of the token response when the top level has no access token or scope.
  Slack returns user tokens there. Comma-separated scopes in that member become
  space-separated.

```ts
oauth2({
  authorizationUrl: "https://slack.com/oauth/v2/authorize",
  tokenUrl: "https://slack.com/api/oauth.v2.access",
  scopes: [],
  // Slack names user scopes in its own parameter.
  authorizationParams: { user_scope: "search:read,channels:history" },
  tokenResponse: { path: "authed_user" },
});
```

A connected account keeps the settings it signed in with; reconnect it after
changing them.

When the service documents an RFC 7009 token revocation endpoint, also declare
`revocationUrl`. Executor calls it when a user deletes the account, so the
provider stops honoring the saved token. Revocation is best effort and never
blocks the deletion. Discovered methods use the server's advertised
`revocation_endpoint` and do not accept `revocationUrl`.

Executor renews tokens before they expire. An `expires_in` of zero is treated
like an omitted one: the token is used until the service rejects it. A tool call
fails with `OAuthReconnectRequired` only when the token endpoint refuses the
renewal, such as with `invalid_grant`, or a renewed ID token names a different
user; reconnect that same account. During a
service outage, or when its response cannot be used, the call fails with the
retryable `OAuthRenewalFailed` and the saved sign-in is kept, so retry later
instead of reconnecting or changing the provider.

For service-to-service access without a user's sign-in, declare the client
credentials grant with `tokenUrl` (or `discover`), `scopes`, and the client
authentication the token endpoint accepts: `client_secret_basic`,
`client_secret_post`, or `client_secret_basic_raw` for a service that wants the
Basic credentials without form encoding.

```ts
const reports = defineProvider({
  name: "Reports",
  auth: {
    machine: oauth2({
      grant: "client_credentials",
      tokenUrl: "https://auth.example.com/oauth/token",
      scopes: ["reports:read"],
      tokenEndpointAuthMethod: "client_secret_basic",
    }),
  },
});
```

The connect page asks for the client ID and secret and exchanges them at once;
there is no browser redirect. App code reads `account.fields.access_token`.
Executor exchanges the client credentials again when the token expires; this
grant has no refresh token.

Deploy the source, create a profile, then request a connection for its account requirement.
The management examples below use the **local** API. For hosted calls, use
`profiles.create` and `accounts.connect` with `path.organization`, as shown in
[deploy.md](deploy.md). Hosted calls derive owner and subject from the caller.
Discover the management profile path with `tools.search` before calling it:

```js
const executor = tools.executor.profiles["<management-profile-id>"];
const app = await executor.apps.get({ path: { app: "<vercel-app-id>" } });
const profile = await executor.appProfiles.create({
  path: { app: app.id },
  body: { owner: "alice", subject: "alice", accounts: {}, idempotencyKey: "vercel-setup" },
});
return await executor.accountConnect.issue({
  body: { owner: "alice", target: { app: app.id, profile: profile.id, requirement: "vercel" } },
});
```

Give the returned URL to the user. Executor renders the provider's credential
form or OAuth sign-in. Never ask users to paste secrets into chat, inspect their
files for tokens, or put credentials in app source or execute code.
After the user finishes, check the request in a new execute call:

```js
const executor = tools.executor.profiles["<management-profile-id>"];
const connection = await executor.accountConnections.get({
  path: { connection: "<connection-id>" },
});
return connection.state; // { status: "completed", account } means setup finished.
// A pending state with `failure` holds the error the user saw, including the service's own error.
```

Completing a request saves the account and selects it for the named profile in
one transaction. A `.many()` target appends without duplicates. Other selections
are kept. If a single-account selection or the requirement changed during sign-in,
completion returns `AccountConnectionTargetChanged` without saving credentials;
inspect the profile and request a new link. A pending link whose app was redeployed
with a different provider for that requirement, such as an API key instead of OAuth,
returns the same error when read or opened. Request a new link after such a deploy.

Every request names an app profile requirement; there are no standalone
connections. To replace the credentials of an account a profile already uses,
add `account` beside `target`. The account keeps its ID, name and selections:

```js
return await tools.executor.profiles["<management-profile-id>"].accountConnect.issue({
  body: {
    owner: "alice",
    target: { app: "<app-id>", profile: "<profile-id>", requirement: "vercel" },
    account: "<account-id>",
  },
});
```

Requests expire after thirty minutes. Cancelled or expired requests need a new link. Do not wait or busy-poll
inside execute.

Use `accounts.list({ query: { provider } })` to find compatible saved accounts first when
appropriate. `appProfiles.update({ path: { app, profile }, body: { expectedRevision, accounts } })`
replaces the whole profile selection map. Include every slot you want to keep.
A missing required slot prevents tool discovery and calls for that profile.
Account-dependent apps without profiles expose no direct MCP tools.
Connect the account, then start a new execution to discover or call its profile.

An account has `id`, `method`, and typed `fields` inside app code. It exists
independently of the app and can be selected by several apps with the same
normalized provider definition. Changing that definition can change its provider
ID and account compatibility. Account owners and app owners can differ. Owner
values are lookup metadata, not access control; the current local bearer key
allows access to the entire local instance.

## Two accounts and multiple tools

To use the same app with a second account, call:

```js
const executor = tools.executor.profiles["<management-profile-id>"];
return await executor.appProfiles.create({
  path: { app: "<vercel-app-id>" },
  body: {
    owner: "alice",
    subject: "alice",
    name: "Personal Vercel",
    idempotencyKey: "vercel-personal",
    accounts: { vercel: "<second-compatible-account-id>" },
  },
});
```

Profiles share the app's code, deployment and data. Each has its own account
selections and appears under `tools[appSlug].profiles[profileId]`. Use `apps.copy`
only when you need an independent app with its own source, Git history and data.

For an app that needs several accounts together, declare a collection slot:
`const accounts = { mailboxes: gmail.many() }`. Select it with
`{ mailboxes: [workAccountId, personalAccountId] }`. In app code,
`context.accounts.mailboxes` is an array. Select `[]` explicitly to use zero.
Requirements apply to the whole app. A plain provider requires exactly one
account; optional single-account requirements are not implemented.

`defineApp(requirements, definition)` accepts a plain object for static declarations.
Each handler receives fresh accounts, traced fetch and cancellation in `ctx`.
External handlers can share types from a separate requirements module without
importing the final app. `AppContext<typeof requirements>` describes factory
context, which has no database session.

An async factory passed to `defineApp` runs afresh during inspection and calls.
It can return tools based on its selected accounts and upstream state. Keep
writes inside tool handlers; do not register webhooks or perform mutations in
the factory. Build output retains code, not a permanent tool catalog.
