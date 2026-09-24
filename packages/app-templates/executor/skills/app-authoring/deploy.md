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
Discover and call `queries.context_get({})` to read the organization approved
for this MCP connection. Its result has `organization`, `slug` and `role`.
Use `organization` explicitly in management calls. Never guess `me` or `default`,
and do not search local files for an organization or credentials.

```js
return await tools.executor.profiles["<management-profile-id>"].mutations.apps_deploy({
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
`apps_install`, `apps_importCustom`, `apps_get`, `appUi_location`, profile operations, and
`apps_remove`. Always read their discovered signatures before calling them.

For hosted account setup, create a profile with `profiles_create` first.
Pass its ID to the connection request:

```js
return await tools.executor.profiles["<management-profile-id>"].mutations.accounts_connect({
  path: { organization: "<approved-organization-id>", app: "<app-id>" },
  body: { profile: "<profile-id>", requirement: "vercel" },
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
const executor = tools.executor.profiles["<management-profile-id>"];
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

### Carry source as data

When source comes from `framework_describe` or `appManagement_source`, transform
its `files` in the same execution and pass them to create or commit. For a small
edit, replace only the affected file content and retain the other files. Check
that the expected text exists before applying a text replacement. Do not print
the entire app and retype it to change one style or operation.

For locally authored files, generate the `{ path, content }` array with a local
script and JSON serialization. Insert that serialized value as JavaScript data
in the `execute` payload; keep it out of shell interpolation. JSON handles
quotes, backticks, newlines and literal `${...}` without changing the source.
Do not wrap arbitrary source in a manually constructed template literal.
The local script can prepare the payload, but remote `execute` cannot read a
local path. Submit the actual contents through the available tool interface.

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

## Dependencies and current boundaries

An optional `package.json` can declare normal npm dependencies, including `apps`.
When declared, that package supplies the server and browser framework. An exact
version keeps rebuilds on the same framework; ranges or tags can advance during
a rebuild. The host retains the compiled version with each deployment. Missing
or unsupported packages fail the build without replacing the active app.
Installation disables lifecycle scripts. Do not depend on the Executor SDK in
app code. Without a declared `apps` package, the Node SDK adapter reserves `apps`
and Effect for the host. Native dependencies that need scripts are unsupported.

Hosted builds currently run with limited memory. A build with very large
dependencies can fail with `BuildMemoryExceeded`; no new deployment is activated.
This limit is planned to increase. Report the failure to the user instead of
changing the app. Executor errors include `recovery.action` for the user and
`recovery.instructions` for agents; follow those instructions.

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
