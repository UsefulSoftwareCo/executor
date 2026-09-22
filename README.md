# executor-next

The canonical development checkout is `~/agent-workspace/executor-next`.
Run `bun run workspace:check` before using the shared preview; use
`bun run workspace:check --task` on an isolated task branch. See
[the workspace lifecycle](AGENTS.md#workspace-lifecycle) for commits and merge handoff.

Executor SDK, app framework and the first local server package. Account/app
persistence, encrypted credentials, deployment and tool execution now work.
The local MCP endpoint runs codemode over app tools and Executor management tools.
The local dashboard shows apps, accounts, live tools and retained source.
Provider OAuth supports supplied clients, DCR, CIMD, and token refresh.
Outbound MCP works over HTTP/SSE on local, self-host and cloud: custom remote
MCP imports and catalog MCP entries deploy, discover live upstream tools, and
call them, verified end to end including a real public server. Local process
(stdio) MCP servers remain local-only. The remote SDK facade
(`createRemoteExecutor`) is not implemented.

Effect is pinned to an upstream snapshot with MCP `2026-07-28` support.
See [the dependency notes](notes/effect-mcp.md) for the revision and checks.

Start with [project orientation](notes/project-orientation.md) and
[account connection and app configuration](notes/account-connections.md).
Repository launch commands load secrets directly from 1Password through `op run`.

For the local/hosted split, start with the [code-sharing map](notes/code-sharing.md).
The first extracted capability is [catalog/import preparation](packages/catalog/README.md).
Local owns installation; cloud and Docker share a separate hosted product.
The hosted product serves a TanStack Router dashboard and
a shared Effect HTTP API on Cloudflare and Docker. Both have organization access
and persistent SDK inventory; cloud alone adds Autumn emulator billing. Alchemy
ships the frontend and Worker in one deployment; Docker bundles the frontend and Node server.

To run your own instance, follow the public [self-host guide](apps/hosted/self-host/README.md).
It uses one Docker container with persistent storage and browser sign-in for MCP clients.

Other references: [domain terms](CONTEXT.md),
[provider authoring](notes/provider-authoring.md),
[OAuth implementation and package choice](notes/oauth.md),
[shared context](notes/shared-app-context.md),
[app schemas](notes/app-schemas.md),
[Axiom with two accounts](notes/axiom-mcp-accounts.md), and
[runtime notes](notes/app-runtime.md).

## Cloud onboarding E2E

`bun run e2e:cloud --test-name 'Cloud onboarding'` starts the real local Cloud
Worker and disposable Postgres with hosted emulators. It needs Docker, Playwright
Chromium and ffmpeg, but no account secrets, saved Alchemy profile or 1Password.
See [recorded E2E tests](e2e/README.md) for the evidence viewer and attached stages.

## Development configuration

Authenticate the 1Password CLI, then use the normal repository launch commands.
The `with:local`, `with:cloud`, `with:cloud:dev`, and `with:self-host` scripts in `package.json`
load 1Password references from ignored files through `op run`:

- `.env.development.op` for local development.
- `.env.production.op` for cloud.
- `.env.cloud-development.op` for the cloud Worker running locally.
- `.env.self-host.op` for Docker and standalone hosted Node.

Use these scripts for other commands too: `bun run with:local node script.ts`.

All `.env*` files are excluded from Git and Docker builds. Keep only references
in these files, never resolved credentials. Vault and item references also stay
out of tracked scripts. Edit values in 1Password, then restart the affected
process. Keep encryption/signing keys stable.

Cloud uses Alchemy's PlanetScale database, role, and Hyperdrive resources.
`bun run hosted:cloud:dev` starts the cloud Worker, local Postgres, migrations,
and frontend through Alchemy. Configure `CLOUD_DEV_DATABASE_PASSWORD` in 1Password
and use `BETTER_AUTH_URL=https://127.0.0.1:5395` for cloud development. Alchemy
derives the local connection URL; no development `DATABASE_URL` is needed.
Self-host uses embedded PGlite with a persistent data volume. Add the required
references to the matching ignored file. Never put literal credentials there.
See [hosted configuration](apps/hosted/README.md#cloudflare) for PlanetScale settings.
Servers only read their process environment; deployed hosts use platform
secret bindings without requiring 1Password at runtime.

## Layout

Every package uses `src/contracts/`, `src/implementation/`, and `src/index.ts`.
Keep contracts flat, one cohesive area per file.

- `packages/sdk/src/contracts/`
  - `provider.ts`: normalized definitions, named auth methods and derived references
  - `account.ts`: reusable accounts, API-key fields, OAuth start/completion and lookups
  - `apps.ts`: configured apps, requirements, saved selections, deploy/add/get/update
  - `deployment.ts`: immutable source versions and retained builds
  - `tools.ts`: existing tool seam, now using saved app accounts
  - `shared.ts`: branded IDs, owners, JSON and secret boundary types
  - `http.ts`: one HTTP contract, composed from accounts/apps/tools
  - `executor.ts`: the Promise SDK projected from that contract
  - `storage.ts`: parsers for persisted accounts, deployments and configured apps
  - `runtime.ts`: pluggable build, inspect and call operations
- `packages/sdk/src/implementation/`: native account/app/tool operations, database
  transactions, runtime adapters, provider identity and HTTP handlers
- `apps/local/server/`: local PGlite, credential encryption, configuration, API and MCP composition
- `apps/local/web/`: React dashboard with shadcn components and Effect Atom HTTP calls, catalog imports and account setup
- `apps/hosted/server/`: shared hosted HTTP contracts and handlers
- `apps/hosted/web/`: shared React pages, components, and Effect Atom API reads
- `apps/hosted/cloud/web/`: cloud dashboard routes, navigation, and browser entry
- `apps/hosted/self-host/web/`: self-host dashboard routes, navigation, and browser entry
- `apps/hosted/cloud/`: Cloudflare entry point and Alchemy v2 deployment
- `apps/hosted/self-host/`: Effect Node HTTP entry point and Docker image
- `packages/fumadb-effect/`: Effect SQL schema, typed query and migration implementation
- `packages/mcp/`: shared execute/skills contracts, codemode and search over product-authorized operations
- `packages/app-templates/`: source generators using the `apps` protocol subpaths for MCP, stdio, OpenAPI and GraphQL
- `packages/apps/`: provider/app authoring, shared context, schema constructors,
  native Effect contracts, an author facade, a portable host handler and fetch decoding
- `playground/demo-apps/`: Vercel, Axiom, Mail, and Issue Mail authoring examples
- `playground/sdk/`: Promise SDK examples using package exports; no I/O at import time

## Try reading these examples

- [Vercel](playground/sdk/vercel.ts): deploy, connect an API-key account, save its
  selection, and call a tool; same program for local and remote Executor
- [Axiom](playground/sdk/axiom.ts): two configured copies of one app and two OAuth sign-ins
- [Account reuse](playground/sdk/accounts.ts): list matching accounts, use one account
  in several apps, and select multiple Gmail accounts
- [Two users](playground/sdk/two-users.ts): separate configured apps and accounts;
  the product applies its own owner checks
- [Deployments](playground/sdk/deployments.ts): retained code and the existing rollback seam

The in-process SDK takes `{ storage, sources, blobs, runtime, credentials }`. The Vercel example
can use those adapters; OAuth and remote examples remain sketches. Source-file
reads use Effect's filesystem service and assume the repository root. See the
[local server](apps/local/server/README.md) for resource ownership and API setup.

## Storage schema

`executorDatabase` declares providers, accounts, deployments, apps, OAuth records
and configured-app documents with fumadb-effect. The caller supplies an Effect SQL
driver Layer, creates `makeExecutorStorage`, runs its `migrate` Effect, and owns
the connection lifetime. The [PGlite example](playground/sdk/storage.ts) initializes the schema
and round-trips a configured app without starting an SDK engine.

Accounts store metadata and opaque encrypted credential bytes. The credential
adapter owns encryption, envelope format and key custody. The local server
uses AES-GCM with an explicitly configured key. Parsed storage
records redact the bytes; public account records contain only metadata.
Deployments retain a Git commit reference, file count, build reference and declared
account requirements. Source reads load files from Git; SQL stores no source bytes. Public app requirements come from the active deployment. No
live tool catalog is stored.

The schema enforces unique app names per owner, account provider references,
and active deployments from the app's code lineage. Owners may differ across
related records. Saved account maps preserve missing slots, scalar IDs and
explicit empty arrays. SDK operations check account existence, provider matching,
cardinality and duplicate selections inside those maps. Deployments are inserted
as immutable rows; selection and activation changes are transactional.

Live queries track storage reads and update after committed writes. The dashboard
uses typed subscriptions; apps can declare async queries and mutations. See
[reactive storage](notes/reactive-storage.md) for the author model and runtime boundaries.

## Node runtime

`nodeRuntime({ workDirectory })` from `@executor-js/sdk/node` supplies the runtime
definition to `createExecutor`. Binary storage is supplied separately as `blobs`.
Standalone runtime callers use `createAppRuntime({ runtime, blobs })` for Promise
`build`, `inspect`, `query`, `mutate`, and `call` operations. Native operations
consume the `BlobStore` Effect service. See [blob storage](notes/blob-storage.md)
for adapter contracts and the explicit conversion of older Node build directories.
The [runtime walkthrough](playground/sdk/runtime.ts) builds a synthetic app,
uses two accounts, changes its upstream catalog and reloads the retained build.
Run it with Node 22.23 or newer from the repository root:

```sh
node --input-type=module -e 'import {runtimeWalkthrough} from "./playground/sdk/runtime.ts"; console.log(await runtimeWalkthrough("./.reference/runtime-builds"))'
```

This runtime executes trusted app code in the host Node process. Apps can use
child processes; the example uses Effect's process service. It provides no
sandbox. Files, paths and npm installation use Effect platform services, with
Node layers supplied at the public adapter boundary. `build` installs optional
`package.json` dependencies with npm lifecycle scripts disabled, bundles the app
and framework handler as ESM, and retains the output, npm packages and lockfile.
It reads declared requirements without running the dynamic factory. Ordinary
inspection and calls load that output without rebuilding or installing packages.

`apps/host` exposes `createAppHandler` and `hostContext` for other hosts. Its
framework-owned Request/Response protocol supports requirements, inspection and
calls. Trusted account bindings arrive separately from the request, are parsed
and redacted, and are decoded through each provider's native method schema.
The handler evaluates the app factory for every inspect/call, validates native
tool input, and returns parsed JSON. Error envelopes contain fixed error tags,
never author exceptions or credentials. It does not add app-authored HTTP routes.

Builds use the host's Effect and platform installations and remain tied to their
location and compatibility. Dependencies that install a second copy of the
host framework or Effect are rejected. Native dependencies or packages needing install
scripts are not covered by this first adapter. JSON Schema metadata preserves
defaults, but Effect v4 can represent optional undefined branches as nullable;
native decoding remains authoritative. Outbound MCP works through this same
handler (apps calling out to remote MCP servers), and Cloudflare hosting is
implemented for cloud; see [hosted apps](notes/hosted-apps.md).

## Model

Providers are declared in app code. Matching normalized definitions yield the
same `ProviderId`; there is no manual provider registry, slug or provider owner.
The host exposes the reference and serialized definition through
`app.requirements.accounts.<slot>`. IDs use SHA-256 of the canonical JSON
definition, with object keys sorted and array order preserved.

An account has its own required owner, provider, method and label. Credentials
stay out of returned metadata. Public SDK calls take plain credential fields;
host contracts redact them at entry. OAuth client configuration, state, PKCE,
refresh tokens and grant storage belong to the trusted host.

An app is a configured copy with saved account selections. `apps.deploy`
creates, builds and activates a new app, keyed by `(owner,name)`.
`apps.copy({ from, owner, name })` copies running source into an independent app
with fresh Git history and deploys it. Unfinished apps copy their working source
and remain undeployed. Copies retain their origin but no accounts or app data.

`apps.update({ app, accounts })` replaces the selected account map. Missing
requirements are allowed during setup; every requirement must be filled before
the app runs. A `.many()` slot accepts an explicit empty array. Requirements
apply to the whole app, including tools that use only part of its context.

`AppCodeId` groups the deployments belonging to one independent app; it has no
separate CRUD API. A deployment retains immutable source, its deploying owner,
and a compiled-build reference. Code activation validates the candidate
requirements against saved selections before changing the app's pointer.
It does not copy accounts, rewrite selections, or migrate app data.

Tool calls identify the configured app; they no longer take a per-call
`connect` map. The host snapshots its deployment and selected IDs for that
invocation, checks product authorization, resolves current credentials, and
evaluates the dynamic app. An explicit deployment pins code only. The local MCP adapter evaluates catalogs for each execute and names tools by
configured app ID. Durable indexing and cross-call revision handling remain deferred.

Each tool can declare its own `approval` callback or use `always()` / `never()`
from `apps/tools/approval`. The framework checks its decision after input validation
and before that tool runs.
See [tool policies](notes/app-policies.md) and [SDK call/resume](notes/sdk-tool-approvals.md).
MCP supports model-mediated resume and native client prompts; browser approval
pages remain separate work. See [MCP approvals](notes/mcp-resume.md).

App authors import schema helpers such as `object`, `string`, and `array`
from `apps`. Effect validation stays internal. The host supplies `apps` to
basic source deployments; extra dependencies can use an optional package.json.

## Boundaries and deferred work

The root `@executor-js/sdk` exports Promise-based `createExecutor` and
`createRemoteExecutor`. `@executor-js/sdk/core` exports the same constructors
and operations as Effects, with typed failures and native Stream subscriptions.
The local server uses `/core`; callers retain their Effect context, cancellation,
transactions, and live-query tracking. Both entry points use the same operations.
See [the Effect example](playground/sdk/effect.ts) and
[the Promise example](playground/sdk/vercel.ts).

Framework and SDK operations use Effect v4 internally. App authors use ordinary async
functions; pure declarations and the schema parsing facade stay synchronous.
App factories, tools, webhooks and response readers have Effect-native internal
contracts. Public callbacks and schema helpers are adapted at the author boundary.
Owners are opaque product references and filters, not core permission rules.
Products enforce access to apps and reusable accounts, including cross-owner use.

Webhooks support durable subscriptions, callback delivery and explicit lifecycle
reconciliation; see [webhooks](notes/webhooks.md). The remote SDK facade is not
implemented. General app
HTTP endpoint authoring, durable discovery indexes, app-to-app calls, rollout
policies, and app data migrations remain deferred. Scheduled work will use the
same saved account context; no scheduler API is introduced. Private local app
UIs and basic persistent app state with live queries are implemented.
See [deferred work](notes/deferred.md) for the current list, including workspaces.

## MCP

Run the [local server](apps/local/server/README.md), then connect a Streamable
HTTP MCP client to `http://127.0.0.1:4312/mcp` using the configured bearer key.
Append `?elicitation_mode=native` to use native client approval prompts. The default
`model` mode returns pending approvals for the agent to answer through `resume`.
It exposes `skills` for app-authoring docs and `execute({ code })` for programs.
Call `skills({})` to list documents or `skills({ name: "app-authoring" })` to read
the guide. Discover callable paths inside execute:

```js
return await tools.search({ query: "Executor" });
```

The bundled Executor app can deploy source, connect API-key accounts, select
accounts and create more configured copies. It runs through the same app runtime
as those copies. Search again in a new execute after changing configuration.

```js
// Substitute the exact paths returned by search.
return await Promise.all([
  tools["app_first"].listProjects({}),
  tools["app_second"].listProjects({}),
]);
```

Each copy uses its own saved account selection. All targets use
`@opencode-ai/codemode` for `execute(code)`. The interpreter has no direct
filesystem, network, Node globals or imports. Its tool calls enter the product's
authorized app runtime. Authored apps run in workerd on Local, self-host and Cloud;
CodeMode's interpreter limits and cancellation remain cooperative.
See [MCP implementation and checks](notes/effect-mcp.md).

## Local dashboard

With the local keys configured as described in the [server setup](apps/local/server/README.md):

```sh
bun run web:build
bun run server
```

Run `bun run executor` to start the server and open an authenticated dashboard.
Use `bun run executor serve` for headless startup, or `bun run executor pair` to
get a fresh one-use connection link for an already running server. Browser
sessions use HttpOnly cookies; no API key is pasted or stored in the browser.
Apps and Accounts show persisted state. Open an app to inspect its live tools, selected
accounts, and retained source. Reads use Effect Atom with the server's typed
HTTP contract. Configuration remains available through MCP and the SDK.

## Check

```sh
bun install
bun run typecheck
node --test apps/local/server/test/mcp.test.ts
```

## Desktop development

Run `bun run desktop:dev` for the Electron app with hot reload, or
`bun run desktop:start` for the built dashboard. Both use the 1Password
configuration described in the desktop setup and a separate `.local/desktop`
data directory. On macOS, the launcher also creates `.local/desktop-runtime/Executor Dev.app`. See the
[desktop setup](apps/local/desktop/README.md) for lifecycle and verification.

## Public export

Development happens in this private repository. The public
`UsefulSoftwareCo/executor` repository receives snapshots on its `v2` branch
through `scripts/export-public.sh`. Paths listed in
`scripts/export-public.exclude`, such as `notes/`, stay private. The export
workflow runs the script on every push to `main`. See `RELEASING.md`.
