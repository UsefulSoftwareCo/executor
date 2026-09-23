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

Deploy the source, create a profile, then request a connection for its account requirement.
Discover the management profile path with `tools.search` before calling it:

```js
const executor = tools.executor.profiles["<management-profile-id>"];
const app = await executor.queries.apps_get({ path: { app: "<vercel-app-id>" } });
const profile = await executor.mutations.appProfiles_create({
  path: { app: app.id },
  body: { owner: "alice", subject: "alice", accounts: {}, idempotencyKey: "vercel-setup" },
});
return await executor.mutations.accountConnect_issue({
  body: { owner: "alice", target: { app: app.id, profile: profile.id, requirement: "vercel" } },
});
```

Give the returned URL to the user. Executor renders the provider's credential
form or OAuth sign-in. Never ask users to paste secrets into chat, inspect their
files for tokens, or put credentials in app source or execute code.
After the user finishes, check the request in a new execute call:

```js
const executor = tools.executor.profiles["<management-profile-id>"];
const connection = await executor.queries.accountConnections_get({
  path: { connection: "<connection-id>" },
});
return connection.state; // Completed means the account is saved and selected for the profile.
```

Completing a targeted request saves the account and selects it for the named profile in
one transaction. A `.many()` target appends without duplicates. Other selections
are kept. If a single-account selection or the requirement changed during sign-in,
completion returns `AccountConnectionTargetChanged` without saving credentials;
inspect the profile and request a new link.

To save an account without selecting it for any app, pass `provider` instead:

```js
return await tools.executor.profiles["<management-profile-id>"].mutations.accountConnect_issue({
  body: { owner: "alice", provider: "<provider-reference>" },
});
```

Supply exactly one of `target` or `provider`. Requests expire after thirty
minutes. Cancelled or expired requests need a new link. Do not wait or busy-poll
inside execute.

Use `accounts_list({ query: { provider } })` to find compatible saved accounts first when
appropriate. `appProfiles_update({ path: { app, profile }, body: { expectedRevision, accounts } })`
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
return await executor.mutations.appProfiles_create({
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
