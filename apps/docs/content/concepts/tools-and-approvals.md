---
title: Tools and approvals
description: "An app's queries and mutations become tools automatically. Each one declares its own approval, and nothing is inferred from an operation looking read-only."
---

## Tools

A **tool** is one operation an app exposes. Apps author two kinds, and both
become tools automatically:

- **Queries** read. They get a read-only view of the app's stored data. They may
  still call an external service.
- **Mutations** write. Their stored-data writes run in a transaction and roll
  back if the operation fails. External effects cannot be rolled back.

Queries and mutations live in the app's `tools` router. Writing one there is
what publishes the tool. Nested routers group related tools, like folders:
`router({ issues: router({ list, close }, { description: "Issue triage" }) })`
publishes `issues.list` and `issues.close`. A router's description is shown to
agents beside its tools, and its instructions become a skill. Imported MCP
servers and OpenAPI documents are routers too. Remote MCP servers and live
OpenAPI documents are described by their own metadata.

An agent reaches a tool by its path:

```js
await tools.vercel.listProjects({});
await tools["support-inbox"].archive({ id: "msg_1" });
await tools.acme.issues.close({ id: "123" });
```

`tools.search` returns that exact expression along with the input type, and
`tools.search.describe` returns the whole signature with the output type, so an
agent does not have to guess.

Which tools are available can depend on the app's configuration. A tool needing
an unfilled requirement is not usable, and an imported app only exposes what the
upstream service currently offers.

## Approvals

An **approval** is declared on the individual query or mutation. There is no
app-wide setting, and nothing is inferred from whether an operation looks
read-only.

```ts
import { always, never } from "apps/operations/approval";

// Ask the person before this runs.
approval: always(),
// Run without asking.
approval: never(),
```

For a real decision, write a function. It receives the tool name, the decoded
input and an abort signal, and returns one of three values:

| Value           | Effect                                           |
| --------------- | ------------------------------------------------ |
| `approved`      | The tool runs.                                   |
| `denied`        | The tool is blocked, and the program is told so. |
| `user-approval` | The tool waits for a person to decide.           |

Because the function sees the input, the decision can depend on it. A refund
under a threshold can run; a larger one can ask. Annotate a shared function with
`Approval<Input>` and assign it to several tools to reuse one rule.

Attach an approval to one shared operation with `withApproval(operation, policy)`.
For an imported MCP, OpenAPI or GraphQL router, `withApprovals(router, policy)`
picks a policy for each of its tools. The rule stays in the app's own code:

```ts
import { toolAnnotations, withApprovals } from "apps";
import { always } from "apps/operations/approval";

// Ask before every write to an OpenAPI or GraphQL API.
withApprovals(api, (tool) => (tool.kind === "mutation" ? always() : undefined));
// Ask before MCP tools the server marks destructive.
withApprovals(server, (tool) =>
  toolAnnotations(tool)?.destructiveHint === true ? always() : undefined,
);
```

MCP servers added from the dashboard are generated with the second rule. Edit
the app's source to change it. Apps added earlier keep the source they were
generated with.

## What happens when a tool asks

The call pauses. What you see next depends on the
[elicitation mode](/mcp) of the connection:

- **Model**: the agent shows you the request and calls `resume` with your
  answer.
- **Native**: your MCP client prompts you, and the same program continues.
- **Browser**: you get a link to a signed-in page and decide there.

When you run a tool yourself from an app's **Tools** tab, the dashboard shows
the saved call (the tool and its arguments) and resumes it only after you approve.
Only you can answer a run you started there. Approvals from an MCP client or a
schedule are answered where they were requested.

A tool can also ask for input rather than permission, using a form. The
mechanism is the same.

Declining or cancelling fails that tool call. It does not undo tool calls that
already ran. An agent must not run the program again to get past a refusal.

## What approval does not cover

The app's own setup has already run, with its credentials, before any tool
approval is evaluated. Approval governs the selected tool, not your trust in the
app's code. Decide that when you deploy or install it.

Skill text and its metadata never grant permission either. A skill can describe
a tool; only the approval decides whether it runs.

## What is coming later

- Remembering a decision, so the same action is not asked twice.
- Browser approval for a tool called from an app's own web page. Today such a
  call fails instead of asking.
