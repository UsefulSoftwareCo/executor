---
title: Tools and approvals
description: "An app's queries and mutations become tools automatically. A tool can declare an approval rule."
---

Tools and per-tool approvals work on **Local**, **Self-host**, and **Cloud**. A tool's approval rule governs how an already-authorized call proceeds: the caller must already be entitled to use the app and tool (via role, app audience, required accounts, and connection scope).

## Tools

A **tool** is one operation an app exposes. Apps author two kinds, and both become tools automatically:

- **Queries** read. They get a read-only view of the app's stored data (`SqlReader`, executed in a transaction that always rolls back; a query that modifies rows fails). They may still call an external service.
- **Mutations** write. Outside `ctx.sql.transaction(...)`, each SQL statement commits on its own; wrap multi-statement writes in synchronous `ctx.sql.transaction((tx) => ...)` so throwing rolls those writes back together. External effects cannot be rolled back.

Queries and mutations live in the app's `tools` router. Writing one there is what publishes the tool. Nested routers group related tools, like folders: `router({ issues: router({ list, close }, { description: "Issue triage" }) })` publishes `issues.list` and `issues.close`. A router's description is shown to agents beside its tools, and its instructions become a skill. Imported MCP servers and OpenAPI documents are routers too. Remote MCP servers and live OpenAPI documents are described by their own metadata.

An agent reaches a tool by its path:

```js
await tools.vercel.listProjects({});
await tools["support-inbox"].archive({ id: "msg_1" });
await tools.acme.issues.close({ id: "123" });
```

`tools.search` returns that exact expression along with the input type, and `tools.search.describe` returns the whole signature with the output type, so an agent does not have to guess.

Which tools are available can depend on the app's configuration. A tool needing an unfilled requirement is not usable, and an imported app only exposes what the upstream service currently offers.

## Approvals

A query or mutation can declare an **approval** rule. Without a rule, Executor still checks access and validates input. Read-only hints and query classification do not select an approval policy.

```ts
import { always, never } from "apps/operations/approval";

// Request user approval before this runs.
approval: always(),
// Run without requesting approval.
approval: never(),
```

For a conditional rule, write a function. It receives the tool name, the decoded input, and an abort signal, and returns one of three values:

| Value | Effect |
| --- | --- |
| `approved` | The tool runs. |
| `denied` | The tool is blocked in every mode, and the program is told so. |
| `user-approval` | The tool requests user approval, handled according to the connection's delivery mode. |

Because the function sees the input, the decision can depend on it. A refund under a threshold can run; a larger one can request approval. Annotate a shared function with `Approval<Input>` and assign it to several tools to reuse one rule.

Attach an approval to one shared operation with `withApproval(operation, policy)`. For an imported MCP, OpenAPI, or GraphQL router, `withApprovals(router, policy)` picks a policy for each of its tools. The rule stays in the app's own code:

```ts
import { toolAnnotations, withApprovals } from "apps";
import { always } from "apps/operations/approval";

// Request approval before every write to an OpenAPI or GraphQL API.
withApprovals(api, (tool) => (tool.kind === "mutation" ? always() : undefined));
// Request approval before MCP tools the server marks destructive.
withApprovals(server, (tool) =>
  toolAnnotations(tool)?.destructiveHint === true ? always() : undefined,
);
```

MCP servers added from the dashboard are generated with the second rule. Edit the app's source to change it. Apps added earlier keep the source they were generated with.

## What happens when a tool requests approval

An explicit `denied` result always blocks the call. When a tool's approval function returns `user-approval`, what happens next depends on the connection's [elicitation mode](/docs/mcp-clients#choosing-where-approvals-appear):

- **Automatic** (preselected on browser OAuth consent for the default URL, and default for bare hosted PAT requests): accepts app approval requests without a separate Executor prompt.
- **Through your agent** (`model`, default for bare Local server keys): pauses the call and returns the request to the client. Executor accepts the client’s decision when it calls `resume`.
- **Native** (`native`): native `execute` sends approval forms to a compatible MCP client; native direct `call` uses the client-approved path and advertises risk hints (Executor cannot verify whether the client prompted you).
- **In your browser** (`browser`): pauses the call and returns a link to a signed-in Executor approval page (requiring the credential owner's hosted browser session or a paired Local browser), then resumes in the originating MCP session.

MCP approval requests expire after 15 minutes. A paused call can resume on its saved, retained version even after a new version is deployed; Executor rechecks the saved invocation and applicable access.

When you run a tool yourself from an app's **Tools** tab, the dashboard uses its own approval flow: it shows the saved call (the tool and its arguments) and resumes it only after you approve, and only you can answer a run you started there. Per-user schedules default to **Skip approvals**, which accepts approval requests while preserving explicit denials.

A tool can also request input using a form. In Automatic mode, the client still receives input requests and supplies the answers.

Declining or cancelling fails that tool call. It does not undo tool calls that already ran. An agent must not run the program again to get past a refusal.

## What approval does not cover

Executor may evaluate an app and resolve its linked accounts before checking a tool's approval. Approval governs the selected tool call, not your trust in the app's code — install and deploy apps you trust.

Skill text and `allowed-tools` metadata grant no permissions. Tool calls still require the connection's authorization and pass through any tool approval rule.

## What is coming later

- Remembering a decision, so the same action is not asked twice.
- Browser approval for a tool called from an app's own web page. Today such a call fails instead of asking.

## Related

- [Add an MCP client](/docs/mcp-clients)
- [Apps and versions](/docs/concepts/apps-and-versions)
- [Activity and tool call log](/docs/activity)
- [How Executor protects credentials](/docs/security/credentials)
