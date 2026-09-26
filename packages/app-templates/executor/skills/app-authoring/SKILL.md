---
name: app-authoring
description: Build and deploy Executor apps with tools, storage, UI, accounts and background work. Read before creating or changing an app.
---

# Build an Executor app

An app is TypeScript source with a default `defineApp` export from `apps`.
The host supplies the framework unless `package.json` selects an exact Executor
`apps` version. App authors use ordinary async functions; Effect stays inside
the framework. An app's installed name is separate from its source definition.

## Read only the topics needed

| Task                                                         | Reference                          |
| ------------------------------------------------------------ | ---------------------------------- |
| Start a new UI with storage from a checked example           | [starter.md](starter.md)           |
| Declare queries, mutations, schemas, approvals or app skills | [tools.md](tools.md)               |
| Create, save, deploy, update or select dependencies          | [deploy.md](deploy.md)             |
| Build a React UI and subscribe to data                       | [ui.md](ui.md)                     |
| Store, query or modify app data                              | [storage.md](storage.md)           |
| Connect provider accounts                                    | [accounts.md](accounts.md)         |
| Add a service: MCP, OpenAPI, GraphQL or another API          | [integrations.md](integrations.md) |
| Handle webhooks                                              | [webhooks.md](webhooks.md)         |
| Run workflows or scheduled mutations                         | [workflows.md](workflows.md)       |

For a new UI with storage, start with `starter.md`. It links to the topics
needed to adapt the example. For an existing app, read its current source and
the reference for the part being changed.
Load files through the MCP `skills` tool using the returned app slug, profile, deployment and content revision:

```json
{
  "app": "executor",
  "name": "app-authoring",
  "deployment": "<returned deployment>",
  "profile": "<returned profile>",
  "revision": "<returned revision>",
  "file": "ui.md"
}
```

## Discover exact contracts

Use `tools.search` inside `execute` to find callable app tools and their input
and output signatures. Discover `framework_search` and `framework_describe`
on this Executor app to inspect library functions and methods. These queries
return generated signatures, related types, examples and documentation links.
Framework functions are imports or methods used in app source, not MCP tools.

Search by task or name, then describe the selected symbol. Start with
`apps.defineApp`, `apps.query`, `DatabaseTable.insert`, or `apps/react.useAppQuery`.
The reference identifies its exact framework version and content digest. Keep
that identity on subsequent reads. Do not assume a host reference describes a
different pinned `apps` package; that package ships `framework-reference.json`.

Hosted management calls require an explicit organization. Discover and call
`context_get({})` first. Local management calls have no organization parameter.
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
