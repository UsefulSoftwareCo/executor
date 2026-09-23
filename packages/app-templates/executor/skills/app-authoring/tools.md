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
