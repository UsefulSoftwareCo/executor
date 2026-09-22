---
name: app-authoring
description: Build and deploy Executor apps with queries, mutations, provider accounts, storage, UI, webhooks and skills. Read this before creating or changing an app.
---

# Build an Executor app

An app is TypeScript source with a default `defineApp` export from `apps`.
The host supplies that package when you omit it from your dependencies. You can
start with one `index.ts`. To select a published framework, declare an exact
Executor beta version of `apps` in `package.json` and deploy it with the source.
The first beta is being prepared; do not use the unrelated `latest` tag.

`defineApp` declares behavior and does not take a name. Set the package name
in `package.json`, such as `"name": "@team/calendar"` when publishing. The name
you choose when creating or renaming an installed app is its editable display label.

Write normal async TypeScript. App authors do not need to import Effect or the
Executor SDK. The framework validates operation input and supplies selected accounts.

## A runnable first app

Save this as `index.ts`:

```ts
import { query, defineApp, object, string } from "apps";

const Greet = object({ name: string().default("world") });

export default defineApp(
  { accounts: {} },
  {
    queries: {
      greet: query(
        { description: "Greet someone by name", input: Greet },
        async (_ctx, { name }) => ({ message: `Hello, ${name}!` }),
      ),
    },
  },
);
```

Declare `query(options, handler)` or `mutation(options, handler)`. Options include
`description`, `input`, optional `output`, and optional `approval`. Put the result
in the matching `queries` or `mutations` catalog. Both become agent tools.
Queries may fetch external APIs; they cannot write app-owned data. Return JSON-compatible values:
objects, arrays, strings, finite numbers, booleans and null. Do not return a
Response, Date, stream, SDK class instance, undefined or BigInt.

The schema helpers are `object`, `string`, `number`, `boolean`, `array`,
`record`, `json` and `literal`. Use `.optional()` for absent fields and
`.default(value)` for defaults. `Infer<typeof Input>` gives the parsed input
type. `object` strips undeclared properties. `decodeJson(response, schema)`
checks HTTP status and parses a JSON response.

## Ship instructions with your app

Include standard Agent Skills in the same deployment source:

```text
index.ts
skills/triage/SKILL.md
skills/triage/references/examples.md
```

`SKILL.md` starts with YAML frontmatter:

```md
---
name: triage
description: Search cached messages before fetching more history.
---

Read [examples](references/examples.md), then discover this app's queries.
```

The name must match its directory. Names use lowercase letters/numbers and single
hyphens, up to 64 characters. Descriptions are required and at most 1024 characters.
Optional standard fields are `license`, `compatibility` (at most 500 characters),
`metadata` (string values), and `allowed-tools`. These are format constraints.
Invalid skill files fail deployment before building; the active version is kept.
Include the skill documents and references in the deployment's `files` array.

The MCP `skills` tool lists summaries with `{}` or `{app: "installed-slug"}`.
Read with `{app: "installed-slug", name: "triage"}`. The response gives the installed
app namespace, deployment ID and relative file paths. Use that deployment ID for
reference reads: `{app, name, deployment, file: "references/examples.md"}`.
These are arguments to the MCP tool, not calls inside `execute`.
This guide is a skill of the ordinary Executor app. Discover its current slug
with `skills({})`, then read `{app: "executor", name: "app-authoring"}` using
that slug. It follows the same access and deployment rules as every app skill.

Skill reads do not evaluate app code or require connected accounts. This permits
setup instructions. Each read checks current app access. Files, including scripts,
are returned as text; Executor does not run them. Do not include secrets. Skills
and `allowed-tools` never grant access or bypass approvals. A skill may describe
tools that the current grant cannot call. Treat its content as app-authored
instructions, not as system policy. Use the returned `app.slug` when calling tools
so instructions work across configured copies and renamed installations.

## Operation approvals

Declare `approval` in a query or mutation options object:

```ts
import { always, never } from "apps/operations/approval"

// On a tool that needs confirmation:
approval: always(),
// On a tool that can run without confirmation:
approval: never(),
```

A custom synchronous or async callback receives `toolName`, decoded `toolInput`,
and `signal`. Return `approved`, `denied`, or `user-approval`. The constructors infer the callback input from its schema. Annotate a shared
function with `Approval<Input>` from `apps/operations/approval`.
Assign the same function to several tools to share a policy. Attach approval to
MCP, OpenAPI or GraphQL operations with `withApproval(operation, policy)`.

Only the selected tool's callback runs, after input validation. Omitted approval
permits execution. Invalid decisions and callback failures prevent the tool body
from running. There is no app-level `policy` or `createExecutor` policy option.

In the default model mode, when execute returns `approval-required`, show its `elicitation.message` and reviewed
invocation to the user. This is an MCP form request with an empty `requestedSchema`.
After the user answers, call `resume({ requestId, response: { action: "accept", content: {} } })`,
`resume({ requestId, response: { action: "decline" } })`, or
`resume({ requestId, response: { action: "cancel" } })`. Do not put tool arguments in
response.content; this form only confirms the saved invocation. Resume continues the existing program and can return another
interaction. For `input-required`, show the form and return the user-provided
fields in `response.content`; accept, decline and cancel all return to the running
tool. Invalid form content leaves the request pending. Never execute the original source again to continue it. No native
or browser prompt is opened by this mode; the agent must ask the user.
An `unavailable` response means that continuation cannot resume; report that earlier
calls may have completed. Do not remove the approval policy to bypass it. Discovery does not evaluate
approval callbacks without arguments. Account access and app evaluation remain
separate trust decisions.

With `/mcp?elicitation_mode=native`, the client displays the policy confirmation
through MCP `elicitation/create`. Execute waits for its answer and continues the
same program; `resume` is not exposed. This requires a client with form elicitation
support on a compatible stateful MCP protocol. Keep the tool's approval policy in
either mode. Running tools can ask for structured input with `await ctx.elicit({
mode: "form", message: "Name this result", requestedSchema: { type: "object",
properties: { name: { type: "string" } }, required: ["name"] } })`. This returns
an MCP response with `action` and optional `content`; the framework validates
accepted content against the form. Handle decline/cancel in tool code. The same
tool continues with its local state intact. This works in native or model mode, or with an SDK
host that supplies a delivery handler. The capability is unavailable during
factory evaluation/discovery and after the invocation closes. An earlier tool
policy approval never auto-answers these requests. Upstream MCP form elicitation uses this same path automatically for HTTP and
stdio tools. URL-mode input is not yet supported.

With `/mcp?elicitation_mode=browser`, pending requests include `approvalUrl`. Show
that link to the user, then call `resume({ requestId })` with no response. The user
signs in and answers in the browser. Do not submit an answer on their behalf.
Resume waits briefly; if it returns the same pending request, wait and collect
again. If it returns a new link, show that link too. The original program and
running tool continue without replay. An unavailable request may have expired,
been consumed, or been lost on restart; do not rerun the source automatically.

## Deploy through MCP

MCP exposes `skills` for these docs and `execute` for programs. Model and browser modes also
expose `resume` for pending approvals and tool input.
Both local and hosted expose an Executor management app. First discover its
exact signatures with `execute`:

```js
return await tools.search({ query: "Executor" });
```

Search returns `items` with exact callable `path`, `description` and TypeScript
`signature`. It also returns `remaining` and `next: { offset } | null` for paging.
Hosted exposes tools generated from its OpenAPI spec under `tools.executor`.
Their descriptions include the organization ID approved for this MCP connection.
Use that ID explicitly; changing it does not grant access to another organization.

```js
return await tools.executor.mutations.apps_deploy({
  path: { organization: "<approved-organization-id>" },
  body: {
    name: "Hello",
    files: [{ path: "index.ts", content: "<contents of index.ts>" }],
  },
});
```

For an app you will edit, use the draft workflow. Local and hosted management
apps generate `mutations.appManagement_create`, `queries.appManagement_source`,
`mutations.appManagement_commit`, `mutations.appManagement_deploy`, and
`mutations.appManagement_copy` from the serving OpenAPI contracts. Discover
their exact signatures first. They use ordinary app IDs, with route parameters
under `path` and request payloads under `body`.

Create the draft, read its working source, and save the complete file list with
that source's expected Git commit. Deploy with both the expected source commit
and current active deployment; use null for a draft's first deployment. Commits
and Git pushes do not change the running version. A copy is another normal app with fresh Git history and no accounts or app data.
Running apps copy their deployed source and deploy the copy. Unfinished apps copy
their working files and remain undeployed.

Publishing reads a scoped `name` and optional `description` from `package.json`.
The public listing points to the selected Git commit. Normal npm `dependencies`
are supported; `version` is optional author metadata and does not select an
Executor release. Executor app dependencies are deferred. Include the app source
it needs directly; do not add `executor.dependencies` or an Executor lockfile.

Copy a public app with `appManagement_copy`, using `from: { package, commit }`
and a new `name`. Owned apps use the same operation with `from: { app }`. This creates an independent app and Git repository with empty
account selections. Republishing or unpublishing the original does not change
installed copies. A changed listing must be reviewed again before installation.
Local and self-host consume the public registry; publish on the cloud host after
pushing the source there. Agents edit their owned copy through normal app tools.

Hosted deployment currently creates a new named app and returns the app directly.
It rejects an existing name. Use source commits and deployment by app ID for edits.
After deployment, start a new execute to discover and call its tools.
Other hosted operations include `organization_inventory`, `organization_catalog`,
`apps_install`, `apps_importCustom`, `apps_get`, `appUi_location`, `apps_selectAccounts`, and
`apps_remove`. Always read their discovered signatures before calling them.

For hosted account setup:

```js
return await tools.executor.mutations.accounts_connect({
  path: { organization: "<approved-organization-id>", app: "<app-id>" },
  body: { requirement: "vercel" },
});
```

Give the returned `url` to the user. It opens Executor's signed-in browser form;
credentials and OAuth are completed there. Check progress with
`accounts_connection`, passing `path.organization` and `path.connection`.
Members can read inventory; administrators can deploy, connect, and run app tools.
The server rechecks the caller's grant and current membership on every API call.
The management app's caller credential is never saved as a shared account.

**The remaining management examples use the local product's API.**
Both management apps derive operations from their product OpenAPI contracts.
Operation names use `<group>_<operation>`; inputs use `path`, `query`, and `body`.
Read discovered signatures because the two products have different routes.
Use the returned app ID for API arguments and its name-derived slug for the agent namespace.
Send the actual source string in `files[].content`.

```js
const executor = tools.executor;
return await executor.mutations.apps_deploy({
  body: {
    owner: "my-project",
    name: "Hello",
    files: [{ path: "index.ts", content: "<contents of index.ts>" }],
  },
});
```

The response contains `app` and `deployment`. Deploying again with the same
`owner` and `name` creates a new deployment and activates it after a successful
build. Use relative file paths such as `index.ts` and `lib/client.ts`.

Discovery is prepared at the start of each `execute`. In a **new** execution,
call the deployed app using its returned `app.slug`:

```js
return await tools["<app-slug>"].queries.greet({ name: "Ada" });
```

App source and `execute` code run in different environments. App source can
import packages and use fetch. An `execute` program can call exposed tools and
transform data, but has no direct imports, fetch, filesystem or process APIs.
Do not place `defineApp` declarations directly in execute code; deploy them as
source strings through `apps_deploy`.

## Use a provider account

Declare the provider's credential shape in source. The host derives its provider
ID, stores account credentials and supplies a selected account on each call.
Never put real tokens into source files or return them from tools.

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

export default defineApp(requirements, { queries: { listProjects } });
```

Deploy the source, then request a connection for its account requirement:

```js
const executor = tools.executor;
const app = await executor.queries.apps_get({ path: { app: "<vercel-app-id>" } });
return await executor.mutations.accountConnect_issue({
  body: { owner: "alice", target: { app: app.id, requirement: "vercel" } },
});
```

Give the returned URL to the user. Executor renders the provider's credential
form or OAuth sign-in. Never ask users to paste secrets into chat, inspect their
files for tokens, or put credentials in app source or execute code.
After the user finishes, check the request in a new execute call:

```js
const executor = tools.executor;
const connection = await executor.queries.accountConnections_get({
  path: { connection: "<connection-id>" },
});
return connection.state; // Completed means the account is saved and selected for the app.
```

Completing a targeted request saves the account and selects it for the app in
one transaction. A `.many()` target appends without duplicates. Other selections
are kept. If a single-account selection or the requirement changed during sign-in,
completion returns `AccountConnectionTargetChanged` without saving credentials;
inspect the app and request a new link.

To save an account without selecting it for any app, pass `provider` instead:

```js
return await tools.executor.mutations.accountConnect_issue({
  body: { owner: "alice", provider: "<provider-reference>" },
});
```

Supply exactly one of `target` or `provider`. Requests expire after thirty
minutes. Cancelled or expired requests need a new link. Do not wait or busy-poll
inside execute.

Use `accounts_list({ query: { provider } })` to find compatible saved accounts first when
appropriate. `apps_update({ path: { app }, body: { accounts } })` replaces the whole selection map. Include every
slot you want to keep. A missing required slot prevents tool discovery and calls;
`execute` reports that app under `unavailableApps` with `AccountRequired`.
Connect the account, then start a new execution to discover or call the app.

An account has `id`, `method`, and typed `fields` inside app code. It exists
independently of the app and can be selected by several apps with the same
normalized provider definition. Changing that definition can change its provider
ID and account compatibility. Account owners and app owners can differ. Owner
values are lookup metadata, not access control; the current local bearer key
allows access to the entire local instance.

## Two accounts and multiple tools

To use the same app with a second account, call:

```js
const executor = tools.executor;
const second = await executor.mutations.appManagement_copy({
  body: { from: { app: "<vercel-app-id>" }, name: "Personal Vercel" },
});
return await executor.mutations.apps_update({
  path: { app: second.id },
  body: { accounts: { vercel: "<second-compatible-account-id>" } },
});
```

The new copy has its own code, deployment, Git history, and app data. It starts with no accounts selected. Each copy has an app ID
and exposes tools under its name-derived slug. In a new execute, use `Promise.all` to call both.

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

## Dependencies and current boundaries

An optional `package.json` can declare normal npm dependencies, including `apps`.
When declared, that package supplies the server and browser framework. An exact
version keeps rebuilds on the same framework; ranges or tags can advance during
a rebuild. The host retains the compiled version with each deployment. Missing
or unsupported packages fail the build without replacing the active app.
Installation disables lifecycle scripts. Do not depend on the Executor SDK in
app code. Without a declared `apps` package, the Node SDK adapter reserves `apps`
and Effect for the host. Native dependencies that need scripts are unsupported.

App code runs as trusted code in the host Node process. It receives usable
credentials for selected accounts. Forward `context.signal` to fetch or other
interruptible operations. Cancellation and execution limits are cooperative;
completed writes are not rolled back. App-owned storage persists across calls. Durable background jobs remain deferred.

Working: custom tools, API-key and OAuth providers, saved account selection,
retained builds, configured copies, live discovery and tool calls. The local
catalog imports OpenAPI and remote MCP apps. Custom Add also generates GraphQL
and local stdio MCP apps. OAuth clients can be supplied or resolved through
DCR/CIMD; the host stores and refreshes grants. Private local/self-host app UI,
app data, webhook lifecycle and scheduled mutations are implemented. App-to-app
calls and `executor dev` remain deferred.

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

For an authenticated server, declare a provider and pass headers derived from
the selected account. OAuth uses `oauth2({ discover: "https://example.com/mcp" })`
and `Authorization: "Bearer " + accounts.service.fields.access_token`.
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
their values as an account and passes `accounts.service.fields` to the child.
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

Use `openapiOperations` from `apps/openapi` with the generated `operations.json`,
authentication metadata, and selected account. Custom Add generates these
files from a specification. The runtime helper accepts normalized operations,
not a raw specification, and needs no extra dependency.

Helpers are separate subpath imports. Importing `apps` alone does not load
MCP or GraphQL. Optional dependencies must appear in the app's manifest and
resolve from its own installation. A missing peer fails the deployment with
the package to add. A declared `apps` version owns its framework dependencies;
otherwise the host supplies them.

## Private app UI

Author app UIs as React SPAs. React is the only supported UI framework for now.
Add `ui/index.html`, a module script such as `ui/main.tsx`, and styles. The host
compiles browser assets alongside the server build. Declare `react` and
`react-dom` in the deployment's package dependencies. The local product opens
each configured app on its own localhost subdomain.

Use local React components or browser-compatible npm component libraries.
Declare library dependencies and include their required styles and assets.
Do not assume that the host runs custom build plugins required by a library.

Tailwind CSS v4 compilation is built in. Import `./style.css` from `ui/main.tsx`
and start the stylesheet with `@import "tailwindcss";`. No Tailwind dependency,
config file or build script is needed. Use complete class names in React code;
the build scans the browser bundle, including imported components and lazy
chunks. Customize tokens with CSS `@theme`. Use `@source inline("...")` for
classes supplied only at runtime. Do not use filesystem `@source` paths or
JavaScript `@config` and `@plugin` files. Plain CSS and library styles still work.

For hosted apps, discover and call `appUi_location` after deployment:

```js
return await tools.executor.queries.appUi_location({
  path: { organization: "<approved-organization-id>", app: "<app-id>" },
});
```

The response is `{ url: "https://<app-slug>.<org-slug>.executor.website" }`
on Executor Cloud. Self-host uses its configured app domain. Use the returned
URL rather than constructing one. `url: null` means the app has no UI or the
host has no app domain configured. Deployment builds and activates the UI;
there is no separate publish step. Give the URL to the user to open in a
browser. The browser completes sign-in using their Executor session. MCP
credentials do not grant a browser session. A `403` response alone does not
prove the URL is correct or that the UI renders; invalid hosts also return it.
Verify the actual page before claiming that the UI works.

Import `createAppClient`, `queryReference`, and `mutationReference` from
`apps/client`. Import server operation **types only** from `index.ts`; put shared
schemas in a separate file. Use `client.queryAtom(reference, input, outputSchema)`
with `useAppQuery` from `apps/react`, and `client.mutate(reference, input,
outputSchema)` for explicit writes. `client.query(reference, input, outputSchema)`
reads once. Both operation types may fetch external APIs. External changes do
not invalidate subscriptions, and a database rollback cannot undo external
effects. All callbacks use Promises; the framework runs Effect internally.

Do not include an app ID or credentials in browser code. The host binds both
identity and authentication. Keep asset URLs relative to the document's base;
compiled imports and `ui/public/` files are retained with the deployment. Each
activation automatically reloads open pages. SSR, React Server Components and
public sharing are not part of this version.

## Updating a hosted app

Search the Executor management app for its source, deployments, update and
activate operations. Read the app's current source before editing. Submit the
complete file set to the update operation with the same app ID and
`expectedDeployment` set to the source version you read. Do not use the
create-only deploy operation to replace an installed app.

A successful update retains a new immutable deployment and activates it for
that configured app. The name, app ID and selected accounts stay intact.
Concurrent edits return `deployment_changed`; reread the current source and
reconcile the edits before retrying. Incompatible account requirements fail
without changing the active deployment or silently clearing saved selections.

The deployments operation lists retained versions, and source can read a
specific version. Activation requires the current `expectedDeployment` too.
It only changes which code runs; it does not reverse app data or changes made
in external services. Hosted source and deployment operations require an
organization admin. Discover tools again in a new execute after changing code.

## App data

Use the same author schemas for scalar database columns. Declare requirements once, derive `QueryContext<typeof requirements>` and
`MutationContext<typeof requirements>`, and use the standalone `query` and
`mutation` functions. External handlers annotate their context; inline handlers
infer it from `defineApp`. Input and output types remain inferred from schemas.

```ts
import {
  query,
  mutation,
  type QueryContext,
  type MutationContext,
  defineApp,
  defineDatabase,
  json,
  object,
  string,
  table,
} from "apps";

const database = defineDatabase({
  messages: table({ mailbox: string(), subject: string() }).index("by_mailbox", ["mailbox"]),
});
const requirements = { accounts: {}, database };
const list = query(
  { input: object({ mailbox: string() }), output: json() },
  async ({ db }: QueryContext<typeof requirements>, { mailbox }) =>
    db.messages
      .withIndex("by_mailbox", (q) => q.eq("mailbox", mailbox))
      .order("desc")
      .take(50),
);
const add = mutation(
  { input: object({ mailbox: string(), subject: string() }), output: json() },
  async ({ db }: MutationContext<typeof requirements>, message) => db.messages.insert(message),
);
export default defineApp(requirements, {
  queries: { list },
  mutations: { add },
});
```

Queries and mutations are automatically available to the agent as `queries.<name>`
and `mutations.<name>` in the app's tool catalog. Use `tools.search` to get their
exact callable expressions; do not write another tool wrapper. Calls preserve
read-only query capability, atomic mutation commit, output validation and live
updates. Add `description` and optionally `title` to an operation's options to
improve discovery. Agent paths nest these categories under the name-derived app slug,
for example `tools.inbox.queries.list(...)`.

`defineDatabase` supplies only the schema; `database.query` and `database.mutation`
are removed. Declaring a database gives every query a read session and every
mutation a write transaction. Interactive elicitation is unavailable during those
transactions. Browser clients can subscribe with query references/live atoms.

Use a concrete output schema instead of `json()` when you want inferred client
result fields. Each configured app has its own database, retained across code
updates. Never supply row metadata on writes: the host creates `id`, `createdAt`
and `updatedAt`. Tables also provide `get`, `update` and `delete`. Queries have
read methods only. Optional fields support `null` to clear them; defaults apply
when values are omitted. An undefined patch property leaves the value unchanged.

Index queries support prefix `eq` terms, then `gt`/`gte`/`lt`/`lte` bounds on the
next field. Use `by_creation` without declaring an index. Terminals include
`first`, `take`, `collect`, `count` and `paginate({ cursor, numItems })`. A page
returns `page`, `continueCursor`, and `isDone`. Pass the returned cursor unchanged.

Reads are bounded: 5,000 rows scanned, 1,000 rows returned, and 4 MiB per
invocation. `collect` and `count` fail instead of truncating. Mutations allow
1,000 writes and commit only after output validation. External fetch is allowed in queries and mutations, but network waits inside
database callbacks keep their transaction open. Schema changes currently fail
closed; an explicit migration flow is not implemented yet. Rebuild old prototype
apps using `defineTable`/`db.set` for this API; no legacy-data migration is included.

## Webhook subscriptions

Apps may return a `webhooks` catalog. Define an `account` slot, `config` and
`state` schemas, and async `register`, `handle`, and `unregister` callbacks.
Keep these callbacks together. The host supplies a stable `subscriptionId`,
`callbackUrl`, signing `secret`, and the selected source `account`; other saved
accounts are available in context. Use `WebhookContext<typeof requirements>` for
external lifecycle handlers. It exposes writable `ctx.db` when the app declares
a database, and excludes `elicit` in both the type and runtime object. Registration,
delivery and cleanup each own their storage transaction. Registration and cleanup must
be idempotent. A callback must verify the provider signature over raw bytes
before parsing the body or performing side effects.

Discover definitions/config schemas through the Executor app's webhook
operations. Create with a stable `key`, handler `name`, `config`, and an explicit
`sourceAccount` for a collection requirement. Check the returned `status` and
`failure`. Retry failed or interrupted registration/cleanup with `reconcile`.
Remove a subscription before deleting its app or connected accounts.
Subscriptions pin their original deployment/account IDs; recreate to upgrade.
Providers retry deliveries; Executor does not deduplicate or replay them.
`state` can be null during provider validation or cleanup after a lost
registration response. Local providers need a publicly reachable callback origin.

For providers without a registration API, replace `register` and `unregister`
with `setup: { instructions: "...", signingSecret: "executor" }`.
Keep `handle` and both schemas. `state` describes the private setup fields;
use `object({})` if only a signing secret is needed. `executor` means the operator
copies a generated secret into the provider; `provider` means they paste the
provider's secret into Executor's secure page.

When creation returns `setup-required`, request `webhookLinks_link({ path: { app, subscription } })` (local) or
the hosted `setupLink` operation and show the URL to the user. Do not ask for
signing secrets in chat or include them in tool arguments. Read status with
`webhooks_get`. Manual removal returns `disabled`; after removing it
in the provider, use `webhooks_confirmRemoval`. This confirms the
operator's action; Executor cannot verify external deletion without a provider API.

## Workflows

Register `workflow({ input, output?, description? }, async (ctx, input) => result)`
in `defineApp(requirements, { ..., workflows: { name: declaration } })`.
Import `WorkflowContext<typeof requirements>` for handlers in separate files.
The body has `runId` and `step`; it has no database, accounts or `elicit`.

Use `step.do("name", async (ctx) => value)` for external work. Its context has fresh
accounts, fetch, signal and a stable `idempotencyKey`. Retry options can precede
the callback: `{ retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
timeout: "30 seconds" }`. Throw `NonRetryableError` for permanent failure.
Return bounded JSON, or `null` when no result is needed.

Use `step.runQuery("name", registeredQuery, input)` and
`step.runMutation("name", registeredMutation, input)` for app storage. Register
those declarations in the normal query/mutation catalogs too. A mutation's
receipt commits atomically with its database writes, so lost checkpoints do not
repeat a committed database mutation. External API writes still need idempotency.

Use `step.sleep("name", "1 minute")` or `step.sleepUntil("name", timestamp)` for
waiting. Put time reads, randomness and I/O inside steps; use their results for
branches and loops. `Promise.all` works for independent steps. Runs pin deployed
code and account IDs, but each executing step resolves current credentials.

App mutations/webhooks can call `ctx.workflows.start({ workflow, input, key? })`
and `terminate({ run })`. Queries also have `get({ run })` and `list(options?)`.
Controls cannot target another app. Use stable start keys when retrying a caller;
starting a workflow is not part of the calling app database transaction.
The SDK namespace is `executor.apps.workflowRuns`, with discovery through
`executor.apps.workflows.list`. Do not invent `executor.workflowRuns`.

V1 has no webhook/event wait, durable human-input request, or restart helper.
Background operations retain approval rules and fail if they require live input.

## Scheduled mutations

Declare schedules against the same mutation objects registered on the app:

```ts
import { defineApp, mutation, interval, cron, object, string } from "apps";

const record = mutation({ input: object({ message: string() }) }, async (_ctx, { message }) => ({
  message,
}));

export default defineApp({ accounts: {} }, async () => ({
  mutations: { record },
  schedules: {
    heartbeat: interval({ minutes: 5 }, record, { message: "Heartbeat" }),
    morning: cron({ expression: "0 9 * * MON-FRI", timezone: "America/Los_Angeles" }, record, {
      message: "Morning",
    }),
  },
}));
```

Intervals accept one positive integer unit: `seconds`, `minutes` or `hours`,
and must resolve to at least 60 seconds. A shorter interval fails when the app
is evaluated. Use Run now to try a schedule without waiting for its next tick.
Calendar schedules accept five-field cron expressions and default to UTC.
The mutation must appear once in the app's mutation catalog. Its input is
checked during app evaluation. External handlers use
`MutationContext<typeof requirements>`, exactly as ordinary mutations do. Read
selected providers through `ctx.accounts` and declared storage through `ctx.db`;
`interval` and `cron` retain that handler context type. No account-binding factory
or database-specific mutation constructor is needed.

Schedules start paused. Use the app's Schedules tab or the Executor management
app's schedule definitions/configure operations to enable them. The management
API also lists saved settings and runs, pauses schedules and requests a run now.
Each run uses the current deployment and selected accounts. Only one run is
active per schedule; overdue ticks coalesce into one run after downtime.

The default `automatic` approval mode accepts approval prompts using the saved
schedule authorization. Explicit denials still block execution. Select `browser`
to review requests on the Approvals page. These requests expire after 15 minutes
and occupy the active slot while waiting. Browser review requires the normal
signed-in user; an agent cannot answer through the management app.
Background input requests (`elicit`) are unsupported. No automatic retries,
workflow checkpoints or replay of uncertain side effects are provided.
