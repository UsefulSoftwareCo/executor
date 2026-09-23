# Local server

This package owns the local host: PGlite, retained builds, credential encryption,
configuration and API access. Reusable account/app/tool operations live in
`packages/sdk` and are shared with the in-process SDK.
The server imports `createExecutor` and `Executor` from `@executor-js/sdk/core`.
Its HTTP, MCP, dashboard, and app UI handlers call that public Effect API.

Read these files in order:

1. `src/bin.ts` runs the CLI; `src/main.ts` is the headless supervisor entry. Both use `src/node.ts` for one scoped local server.
2. `src/implementation/server.ts` assembles storage, credentials, runtime and HTTP routes.
3. `src/implementation/storage.ts` opens the native Effect SQL PGlite driver and initializes the fumadb-effect schema.
4. `aesGcmCredentials` from `@executor-js/sdk/core` encrypts account fields with AES-GCM.
5. `packages/mcp` declares and implements execute, skills, search and the transport;
   `src/implementation/mcp.ts` supplies local SDK access and documentation I/O.
6. `src/implementation/executor-app.ts` deploys the bundled management app and selects its local API account.
7. `src/contracts/config.ts` defines local paths, port, explicit secrets and MCP limits.
8. `src/contracts/dashboard.ts` defines the typed dashboard API;
   `src/implementation/dashboard.ts` projects SDK data and `web.ts` serves the UI.

The exported `localApi(config, crypto)` is an Effect layer containing the SDK, MCP and dashboard routes.
The caller supplies Web Crypto and the HTTP platform and owns its scope. Closing the scope
closes the database. The executable entry point binds only to `127.0.0.1`.
Effect's Node runtime handles signals and shuts down the listener and database.

## Run

Use Node 22.23 or newer and an authenticated 1Password CLI. The repository launch
commands inject configuration through `op run` using the ignored
`.env.development.op` reference file. Run from the repository root:

```sh
bun run server
```

The default address is `http://127.0.0.1:4312`. For example:

```sh
bun run with:local sh -c \
  'curl -H "Authorization: Bearer $EXECUTOR_API_KEY" http://127.0.0.1:4312/v1/apps'
```

Press Ctrl+C to stop. Package-level `bun run start` reads its existing process
environment; the repository scripts own 1Password injection. Relative data paths
are resolved from the process working directory. See [configuration](../../../README.md#development-configuration)
for the vault setup. The server itself does not depend on 1Password.

## Configuration

| Variable                        | Meaning                                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `EXECUTOR_DATA_DIR`             | Directory containing `executor.pglite/`, `browser-auth.pglite/`, and `builds/`; defaults to `.local/executor`.  |
| `EXECUTOR_PORT`                 | Loopback listener port; defaults to `4312`.                                                                     |
| `EXECUTOR_API_KEY`              | Optional supplied bearer token; set with the encryption key. At least 32 characters.                            |
| `EXECUTOR_ENCRYPTION_KEY`       | Optional supplied AES key; set with the API key. Exactly 64 hexadecimal characters.                             |
| `EXECUTOR_MCP_TIMEOUT_MS`       | Catalog discovery plus program timeout; defaults to `30000`.                                                    |
| `EXECUTOR_MCP_MAX_TOOL_CALLS`   | Admitted calls per execute, including search; defaults to `100`.                                                |
| `EXECUTOR_MCP_MAX_OUTPUT_BYTES` | Result value/log truncation budget; defaults to `65536`. Protocol metadata and truncation markers add overhead. |

First launch saves generated keys in the OS credential store and records the
installation ID in `installation.json`. Linux requires a persistent Secret
Service. There is no plaintext or kernel-keyring fallback. Existing data with
missing keys stops with a restore instruction. Explicit environment keys stay
supported and are never persisted. A directory keeps its chosen key source.
Back up the OS credential and installation record with the data, or retain both
supplied keys. Changing an encryption key does not re-encrypt existing accounts. Database rows
contain encrypted bytes, and each ciphertext is bound to its account ID.

SDK routes, including `/mcp` and `/openapi.json`, require `Authorization: Bearer …`.
The local token grants access to the whole local instance. Owner filters do not
represent user authentication. SDK and MCP requests with a browser `Origin`
header are rejected. Dashboard data requires the same bearer key and permits
only the configured loopback origin when an `Origin` header is present.

## Local dashboard

For UI development, run `bun run dev` from the repository root. It starts the
same local server at `http://127.0.0.1:4312` with Vite middleware and React Fast
Refresh. UI changes update without rebuilding or refreshing the page. The HMR
WebSocket listens separately on loopback port 24678. API requests, session
cookies, pairing and OAuth callbacks keep the product server's origin. Stop
an existing server on that port before starting dev mode. Server code changes
still require a restart.

Build the dashboard from the repository root, then start the server:

```sh
bun run web:build
bun run server
```

`bun run executor` starts the server and opens a one-use connection link.
`bun run executor serve` (or `bun run server`) prints the link without opening a
browser. `bun run executor pair` prints a fresh link for the running server.
A paired dashboard can also issue a new link through `POST /auth/pair`, with its
session cookie and a valid local Origin. Executor desktop uses this for **File →
Open in browser**. A bearer key alone still cannot mint a link from browser requests.
Repository commands run TypeScript source through Node. The npm beta uses
`executor`, `executor serve`, and `executor pair`, with data in
`~/.executor/v2/cli`. Build it with `bun run release:cli`; see
[release packaging](../../../scripts/releases/README.md).

The link expires after five minutes and is consumed once. Its token is carried
in the URL fragment, removed from browser history before exchange, and replaced
by a seven-day HttpOnly, SameSite=Strict cookie. Refresh retains the session.
Sessions survive server restarts when the same data directory and address are
used. Only token digests and expiry dates are saved in `browser-auth.pglite/`.
Disconnect revokes the session persistently; restarting does not extend its
seven-day expiry. Outstanding pairing links remain process-local. No reusable API key enters the browser.
Bearer authentication for SDK/MCP remains unchanged. Requests must use the exact
`http://127.0.0.1:<port>` origin and Host; no remote access or CORS is enabled.
The public HTML and bundled assets contain no key or account data.

Inspect apps, saved account selections, live tools, retained deployments and
source files. The Accounts page shows provider metadata and the apps that use
each account. It never returns saved credentials. This first dashboard is
also supports catalog imports, reusable account creation and app account selection.
The SDK and MCP expose the underlying operations to other clients.

The React UI lives in `apps/local/web`. Effect Atom reads the shared HTTP API
contract, including response schemas and typed errors. Dashboard reads use live
SSE subscriptions driven by committed storage writes, including SDK and MCP writes.
See [reactive storage](../../../notes/reactive-storage.md) for runtime limits. Development and built
previews both use the local server origin. `src/dev.ts` owns Vite's lifetime;
the production entry points do not load Vite.

## Desktop startup foundation

The desktop foundation lets a parent launch the same `src/bin.ts --bootstrap-fd 3` process
with a private pipe at fd3. It sends a JSON `DesktopBootstrap` envelope:
`{ "version": 1, "token": "<64 lowercase hex characters>" }`, then closes the pipe.
The parent generates this ephemeral token; it is not a persistent API key.

The server parses and bounds the pipe input, registers the one-use token, and
writes a credential-free `ServerReady` line to stdout:
`{ "version": 1, "url": "http://127.0.0.1:<port>" }`. The parent opens that URL with
`/#pair=<token>` in its renderer, using the same cookie exchange as the browser.
No token is sent in argv, environment variables, or readiness logs.

`startLocalServer` is exported from `@executor-js/local-server/node` for in-process
hosts. Its Effect scope owns HTTP, persistence, and auth; closing it interrupts
requests and closes retained connections. `EXECUTOR_PORT=0` chooses an available
loopback port. The fd3 protocol is exercised by a real child-process test. The
[Electron desktop host](../desktop/README.md) now uses this server composition
with its own entry, Vite middleware, and a private OAuth callback pipe. Run
`bun run desktop:dev` from the repository root. Distribution packaging and
a cross-process reconnect manager remain separate work.

## Connect an MCP client

- Transport: Streamable HTTP
- URL: `http://127.0.0.1:4312/mcp`
- Header: `Authorization: Bearer <EXECUTOR_API_KEY>`
- Tools: `skills`, for authoring docs; `execute`, with a `code` string

Before writing an app, discover the Executor app with `skills({})`, then call
`skills` with `{ app: "executor", name: "app-authoring" }` using its current slug. It returns
the guide with runnable source, schema helpers, provider accounts and the
deployment flow. Call it with `{}` to list skills from accessible apps. The guide is an ordinary
skill file in the Executor app deployment.

Start discovery inside `execute` with this code:

```js
return await tools.search({ query: "Executor" });
```

Search returns exact callable paths and signatures. The Executor app exposes
`deployApp`, `addApp`, `listApps`, `getApp`, `addAccount`, `listAccounts`,
`getAccount`, `activateDeployment` and `listTools`. Account selections use
`apps.profiles` with an explicit profile and expected revision.
It calls this server's API through an ordinary selected account. The host uses
the existing configured bearer key; it does not create a separate admin key.
The persisted host-owned app is named `Executor`, with owner `executor-local`.
Startup restores its bundled source and updates its local account's port/key
while retaining the account identity. Leave that connection under host control.

All configured apps get an app-ID namespace. Copies with different accounts
have independent source and deployments. The catalog is evaluated at
the start of each execute, and tool calls resolve the saved selection again.
Run a new execute to discover apps added or configured during a previous one.
Incomplete or failing apps appear in `unavailableApps` with a safe error tag.

Programs support `await`, `Promise.all`, loops and data transformation. There
are no direct imports, fetch, process or filesystem globals. App tools still run
as trusted Node code with the selected credentials. Interpreter limits are
cooperative; they do not isolate arbitrary app code or bound process memory.
App code can pass `context.signal` to fetch to observe cancellation. Effects
already completed are not rolled back when an execution fails or is cancelled.

## Implemented

- Deploy source, derive provider IDs and retain immutable deployments.
- Add API-key accounts and read account metadata without returning credentials.
- Create configured app copies and save independent account selections.
- Validate account existence, provider compatibility, cardinality and duplicates.
- List live tools and invoke them using a snapshot of saved account selections.
- Activate retained deployments in the same code lineage.
- Serve MCP execute for app calls and management through the bundled Executor app.
- Serve a read-only skills tool for deployed app documents, including the Executor app’s authoring guide.
- Handle July 2026 and November 2025 MCP requests, with authentication on every request.
- Serve a local dashboard over the same persisted apps and accounts, with catalog imports and account setup.

SDK writes use database transactions. Builds and app execution run outside
transactions. A failed selection or activation leaves the saved app unchanged.
Unused retained builds can remain after a later database failure; build garbage
collection is deferred.

The remote SDK, workspace folders, app-authored UI and an `executor dev`
command remain separate work. Account creation validates the serialized provider
schema; native app validation also runs on invocation. Serialized schemas retain
the known Effect beta limitation around optional undefined/null values.

## Verify

From the repository root:

```sh
node --test apps/local/server/test/mcp.test.ts apps/local/server/test/auth.test.ts
```

This starts real loopback listeners with an isolated temporary database. The
official MCP client reads the authoring skill and deploys its exact example,
then connects two accounts and calls both copies of an account-based fixture,
and reopens the host using the same data. It also checks live catalogs across
pages, errors, bearer/origin enforcement, cancellation, and execution budgets.
A raw July request complements the official client's November protocol test.
The generated dashboard client also checks inventory, retained source, credential
exclusion, deployment lineage and bearer/origin enforcement.

## Provider OAuth

For a private HTTPS proxy such as Tailscale Serve, set `EXECUTOR_BROWSER_ORIGIN`
to its exact origin. Pairing links and remote OAuth callbacks use that origin;
loopback access remains available. No wildcard origins or forwarded headers are
trusted. HTTPS browser sessions receive Secure cookies.

The account form resolves an OAuth client automatically through saved configuration,
CIMD or DCR. If the provider needs a supplied client, the form shows its callback
URL and client fields. Client secrets, authorization attempts and refresh tokens
are encrypted on the host. Apps receive only their declared access-token fields.

Set `EXECUTOR_OAUTH_CLIENT_METADATA_URL` only when you have a public HTTPS client
metadata document. There is no hosted Executor OAuth broker in the local app.
See [OAuth notes](../../../notes/oauth.md) for the protocol library and limits.

### Add apps and accounts

The local dashboard can import OpenAPI and MCP apps from the public integrations.sh
catalog. **Apps → Add app** generates ordinary `index.ts`, `provider.ts`,
`request.ts`, and `operations.json` source and deploys it through the SDK. Choose
an unused app name; this flow never replaces an existing app. API definitions
are fetched at import time, not when a tool runs.

**Apps → Add app → Custom app** also accepts MCP, GraphQL, and OpenAPI URLs.
These templates generate source and deploy through the same SDK. API keys are
connected afterward. GraphQL uses live account-specific introspection; OpenAPI
supports an optional API base URL override and relative server URLs.

MCP entries instead generate `index.ts` and, when needed, `provider.ts`. Select
Automatic, OAuth, API key, or No authentication. Tools load live using the app's
selected account. Streamable HTTP and legacy SSE servers are supported. Each
discovery or tool call owns its connection; session state is not retained across
separate calls. Remote prompts/resources, sampling, and elicitation are
not included. See [catalog imports](../../../notes/catalog-imports.md).

For stdio, choose **MCP → Local process (stdio)** in Custom app. Enter an
executable, one argument per line, an optional working directory, and any
environment variable names. Environment values are saved through the normal
account flow. No-account servers can be used immediately.

This generates `index.ts`, `stdio.ts`, `package.json`, and a provider declaration
when environment fields are needed. The retained `stdio.ts` uses the official
MCP SDK as an ordinary npm dependency; the apps framework has no stdio transport.
Discovery and calls launch separate processes, pass arguments without a shell,
and close the child on success, failure, timeout, or cancellation. Each process
gets the selected account's environment plus the MCP SDK's basic inherited
environment, rather than the host's full environment. Stderr is not sent to
Executor logs. The default operation timeout is 30 seconds and is editable in
the generated app source. Persistent process sessions are not part of this template.

Automatic import checks the server's Bearer OAuth metadata advertisement when
the catalog does not already include OAuth. This supplements incomplete API-key
entries with OAuth while keeping their API-key method. The account form prefers
OAuth when available. An authentication error alone does not imply OAuth support.

After import, choose a compatible saved account or add one. **Accounts → Add
account** uses the same form and the provider definitions of installed apps.
Saving an account and selecting it for an app are separate operations. If account
selection fails, the saved account remains available and selection can be retried.
Account responses never include credentials. If a network failure leaves saving
uncertain, inspect Accounts before submitting a new account.

On an app page, **Delete app** opens a full-page confirmation. It removes only
that configured copy and its account selections. Saved accounts, other app
copies, and retained source/builds stay available. The built-in Executor app is
managed by the local server and cannot be deleted. The same operation is exposed
as `executor.apps.remove({ app })` and the management app's `removeApp` tool.

OpenAPI 3.0/3.1 imports support header/query API keys, bearer tokens, combined
API-key requirements, JSON bodies, and base64-encoded binary uploads. Generated
OAuth declarations retain authorization-code metadata when available.
GraphQL and CLI catalog entries are labeled unavailable; Swagger 2, external
references, server URL templates, multipart bodies, and custom signing need
further importer work. Unsupported features fail explicitly before deployment.

## Storage transition

Local uses disk-persisted PGlite with the PostgreSQL schema and an in-process
live coordinator. The host owns each database until shutdown. Only one server
process may open a data directory. `fumadb-effect/pglite` configures the native
Effect driver to preserve UTC dates on machines outside UTC.

Existing `executor.sqlite` and `browser-auth.sqlite` files are untouched and are
not imported automatically. The new directories start empty, so old browser
cookies require a new pairing. To retain records, stop the host and plan a
separate one-shot transfer that preserves IDs, selections, ciphertexts, keys,
and session digests. See [storage](../../../notes/storage.md).
