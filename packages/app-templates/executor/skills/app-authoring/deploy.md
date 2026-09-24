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
`expected: source.revision.commit` and a commit message. Deploy the returned
`revision.commit` with `body: { commit }`, or deploy a complete file list with
`body: { files }`. Supply exactly one. `appManagement_deploy` does not accept
`expected` or `expectedDeployment`. Commits and Git pushes do not change the running version. A copy is another normal app with fresh Git history and no accounts or app data.
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
The host derives its owner and subject from the caller. Pass the returned ID to
the connection request:

```js
const executor = tools.executor.profiles["<management-profile-id>"];
const path = { organization: "<approved-organization-id>", app: "<app-id>" };
const profile = await executor.mutations.profiles_create({
  path,
  body: { accounts: {}, idempotencyKey: "vercel-setup" },
});
return await executor.mutations.accounts_connect({
  path,
  body: { profile: profile.id, requirement: "vercel" },
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

The response contains `app` and `deployment`. Creating an app with the same
`owner` and `name` again fails with `AppNameTaken`. To deploy an existing app,
use `body: { owner, app: app.id, files }` or `body: { owner, app: app.id, commit }`.
Deployment activates the new build after it succeeds and does not save working
source. Use relative file paths such as `index.ts` and `lib/client.ts`.

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

Use the shared draft workflow to edit an existing app. `appManagement_source`
reads working Git source; `apps_source` reads immutable deployed source. Saving
one does not change the other. Read both when you need to compare pending edits
with the running app.

```js
const executor = tools.executor.profiles["<management-profile-id>"];
const path = { organization: "<approved-organization-id>", app: "<app-id>" };
const source = await executor.queries.appManagement_source({ path });
const entry = source.files.find((file) => file.path === "index.ts");
if (!entry || entry.content.split("<exact old text>").length !== 2) {
  throw new Error("Expected one match in index.ts; review the edit.");
}
const files = source.files.map((file) =>
  file.path === entry.path
    ? { ...file, content: file.content.replace("<exact old text>", "<replacement text>") }
    : file,
);
const saved = await executor.mutations.appManagement_commit({
  path,
  body: { expected: source.revision.commit, files, message: "Update app" },
});
return await executor.mutations.appManagement_deploy({
  path,
  body: { commit: saved.revision.commit },
});
```

Commit sends the complete file list; omitted files are deleted. A stale
`expected` returns `SourceError` with `reason: "conflict"`. Read working source
again and reconcile the edits before retrying. Deployment returns `{ app,
deployment }`, preserves the app ID and data, and never updates the Git branch.
It has no expected-active-deployment argument. Check profiles after changing
account requirements; saved selections can become incompatible with new code.

`apps_deployments` lists retained versions. `apps_source` accepts an optional
`query.deployment` to read a specific version. `apps_activate` requires
`body: { deployment, expectedDeployment }`, where `expectedDeployment` is the
app's current active deployment. A stale value returns `AppDeploymentChanged`.
Activation only changes which code runs; it does not reverse app data or changes
made in external services. Source reads and deployment writes follow the
hosted product’s access rules. Discover tools again in a new execute after changing code.

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
