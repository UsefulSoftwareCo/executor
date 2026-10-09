---
name: app-authoring
description: Build and deploy Executor apps with tools, storage, UI, accounts and background work. Read before creating or changing an app.
---

# Build an Executor app

An app is TypeScript source with a default `defineApp` export from `apps`.
Its `package.json` declares the exact `apps` version it uses, which
`framework.release` returns. App authors use ordinary async functions; Effect stays inside
the framework. An app's installed name is separate from its source definition.

## Choose how to work

With a shell, prefer the **local CLI path** in [deploy.md](deploy.md): keep the
source in a directory, edit it with your file tools, and deploy with
`executor apps` (npm `executor@beta`). The pinned `apps` package from npm
supplies types and `framework-reference.json`, so writing code needs no MCP.
Use MCP only to connect accounts and call the deployed app. Without a shell,
build through `execute`; source then travels as data inside tool calls.

## Read only the topics needed

| Task                                                         | Reference                                              |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| Start a new UI with storage from a checked example           | [starter.md](starter.md)                               |
| Declare queries, mutations, schemas, approvals or app skills | [tools.md](tools.md)                                   |
| Create, save, deploy, update or select dependencies          | [deploy.md](deploy.md)                                 |
| Build a React UI and subscribe to data                       | [ui.md](ui.md)                                         |
| Store, query or modify app data                              | [storage.md](storage.md)                               |
| Connect provider accounts and check they work                | [accounts.md](accounts.md)                             |
| Add a service: MCP, OpenAPI, GraphQL or another API          | [integrations.md](integrations.md)                     |
| Handle webhooks                                              | [webhooks.md](webhooks.md)                             |
| Emit events that MCP clients such as ChatGPT subscribe to    | [events.md](events.md)                                 |
| Run workflows or scheduled mutations                         | [workflows.md](workflows.md)                           |
| Upgrade an app to a newer `apps` version                     | [upgrades/0.0.1-beta.38.md](upgrades/0.0.1-beta.38.md) |

For a new UI with storage, start with `starter.md`. It links to the topics
needed to adapt the example. For an existing app, read its current source and
the reference for the part being changed.
Load files through the MCP `skills` tool using the returned app slug, profile,
deployment and content revision, for example
`{ app: "executor", name: "app-authoring", file: "ui.md", deployment, profile, revision }`.

The management app's `skills.list` and `skills.read` take the profile as
`query.profile` and need it for any app that requires accounts.

## Discover exact contracts

Use `tools.search` inside `execute` to find callable app tools. It returns their
exact paths, one-line descriptions and input types. Read a tool's output type
and whole description with `tools.search.describe({ paths })`. Discover
`framework.search` and `framework.describe`
on this Executor app to inspect library functions and methods. These queries
return generated signatures, related types, examples and documentation links.
Framework functions are imports or methods used in app source, not MCP tools.

Call `framework.search({ query: { text } })`, then `framework.describe({ query: { symbol, version, digest } })`
with a symbol it returns. Start with `apps.defineApp`, `apps.query`, `DatabaseTable.insert`, or `apps/react.useAppQuery`.
Both take their input under `query`, unlike `tools.search({ query: "send email" })`,
whose `query` is a plain string.
The reference identifies its exact framework version and content digest. Keep
that identity on subsequent reads. Do not assume a host reference describes a
different pinned `apps` package; that package ships `framework-reference.json`.

Hosted management calls require an explicit organization. Discover and call
`context.get({})` first. Local management calls have no organization parameter.
Read each discovered signature; do not guess route arguments.

## Build and verify

Use output schemas for typed results. Import server declarations as types only
in browser code. Put shared schemas in a separate file. Read the relevant
reference for return shapes and behavior instead of deploying probe apps.

Deployment compiles TypeScript but does not replace a type check or prove that
the page renders. Verify the requested behavior on the authenticated app page.
If browser access is unavailable, report exactly what remains unverified.
Never put credentials in source, browser code or tool arguments. Use the secure
account connection flow described in `accounts.md`.

## Send feedback

Before your final reply, send feedback with the Executor app's `feedback.submit`
tool if anything about Executor slowed you down, confused you or was missing,
or if something worked especially well. Skip it if there is nothing worth
reporting. The executor skill's `feedback.md` says what to write.
