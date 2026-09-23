# MCP

Shared Effect implementation of Executor's `execute`, `resume`, and `skills` tools.
It owns codemode, search, pagination, diagnostics, live continuations and interpreter limits.
See [MCP resume](../../notes/mcp-resume.md) for result shapes, authority, timeout and restart behavior.
It does not own login, API keys, organizations or credential access.

Read these files first:

- `src/contracts/backend.ts`: the authorized operations supplied by a product.
- `src/implementation/execute.ts`: discover the caller's catalog and run code against it.
- `src/implementation/server.ts`: compose the tools with Effect's HTTP MCP transport.

`McpBackend<E>` supplies `listApps`, `listSkills`, `readSkill`, `listTools`, `callTool`, `resumeInvocation`, and
`authorizeElicitation`, and `listTargets`. The last operation rechecks access before a running tool
receives an answer.
Approval-required calls carry the app framework's MCP form elicitation; resume
passes the same accept/decline/cancel response to the SDK. Each operation keeps
its native typed errors. The shared response boundary uses their static schema
identifiers for diagnostics, without serializing messages, fields, stacks or causes.
The host must authorize both discovery and calls; a discovered tool is not a
lasting permission grant.

Local uses `apps/local/server/src/implementation/mcp.ts`. OAuth credentials use explicit app/tool grants. The installation page never
copies the administrative key into client configuration. That key remains an
explicit unrestricted administrative credential. The adapter preserves SDK failures and selects the July 2026
and November 2025 protocol adapters. The HTTP transport stays the same; execute and resume return `McpExecutionResult`.

Hosted uses `apps/hosted/server/src/implementation/mcp.ts`. The adapter binds one
request's verified organization and lazy SDK. It filters inventory by owner and
uses the same authorized tool operations as the dashboard. Create it after the
request's membership check; do not save it in an MCP session or shared layer.
Both hosted targets mount `/mcp` using Better Auth browser OAuth. A consent
screen binds the connection to an explicitly chosen organization. Docker owns
protocol handlers in Effect scopes; Cloudflare uses a native Alchemy Durable
Object for session state. See [hosted MCP](../../notes/hosted-mcp.md).

The `skills` tool reads ordinary deployed app files through `listSkills/readSkill`.
Call `{}` to discover visible skills, then `{app, name}` to read one. Reference
reads can pin the returned deployment ID. MCP owns no documents, file loaders or
built-in skill registry. See [app skills](../../notes/app-skills.md).

The default Executor management app is a normal saved app with a connected
Executor OAuth account. It uses `apps/openapi` and the ordinary API handlers. Its source includes
`skills/app-authoring/SKILL.md`; read it with `{app: "executor", name: "app-authoring"}`
using the installed slug. Access to the guide follows access to that app, including
when the grant excludes the Executor app or the user deletes it.
Agent namespaces use name-derived app slugs, such as `tools.executor.profiles["<management-profile-id>"].queries` and
`tools.executor.profiles["<management-profile-id>"].mutations`; identity and permissions still use immutable IDs.

The workerd build condition of codemode accepts JavaScript without loading the
TypeScript compiler. Its Node build can also transpile TypeScript; `execute`
documents JavaScript as the portable input language. No cloud deployment or full
protocol conformance is implied by a successful bundle check.

Running tools use `ctx.elicit` in native, model and browser modes. Policy approvals
and tool input share one pending-interaction manager and resume operation. Adapters forward the optional
`ToolInvocationOptions` on both `callTool` and `resumeInvocation`; these capabilities
belong to the live invocation. Each invocation owns a scope that can outlive
the HTTP response returning its prompt. Native delivery sends the prompt and
answers through the same manager as the model-mode `resume` tool. See [tool input](../../notes/tool-elicitation.md).

HTTP/SSE and stdio MCP helpers forward upstream forms through that same tool-input
capability. Delivery mode does not change the upstream call, and policy consent
does not answer an upstream question. Request and response metadata pass through.

`makeMcp` returns the protocol handler and browser accessors over one manager.
Products authorize those accessors with browser cookies; they cannot be called
through an MCP bearer grant. Browser mode returns `approvalUrl` and exposes a
collector-only `resume({ requestId })` tool. It never accepts an agent-supplied
decision. Browser answers are ephemeral and expire with their interaction.

Personal profiles appear under `tools[appSlug].profiles[profileId]`.
Tool descriptions include account labels. Skills remain one catalog per app and
deployment. Discovery captures the profile revision used by the call.
