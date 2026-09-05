---
"@executor-js/sdk": patch
"@executor-js/api": patch
"@executor-js/plugin-graphql": patch
"@executor-js/plugin-mcp": patch
"@executor-js/plugin-openapi": patch
---

**Workspace writes now require an administrator**

Executor bindings accept `orgWrites: "allowed" | "denied" | "request"`.
Request-aware hosts use `"request"` and bind `CurrentOrgWriteAccess` from the
authenticated principal for each request. An approval, decline, cancellation,
or form response also rebinds the paused execution to the resumer's current
access. Browser approvals derive access from the authenticated browser user's
live organization membership when that user posts the decision, rather than
from the earlier MCP request waiting for it or the user's global role. Self-host
uses the same Better Auth membership lookup for ordinary requests and browser
decisions. A demotion before either kind of resume therefore takes effect
before the paused execution can reach a workspace-write sink.

`Principal` now declares its role model explicitly: organization-backed hosts
carry `orgRoleModel: "organization"` and an optional normalized admin/member
role, while hosts without roles carry `orgRoleModel: "none"` and cannot also
carry an organization role. Missing role data under the organization model
fails closed, including legacy persisted MCP session metadata. Cloud derives
roles from WorkOS memberships and self-host derives them from Better Auth.

Members may still read and execute shared workspace resources and perform
operational maintenance such as token refresh and tool-catalog synchronization.
User-requested workspace mutations now return `OrgWriteDeniedError` (HTTP 403):
workspace connections and reconnects, organization OAuth clients and connect
flows, tool policies, and integration add/update/replace/remove/health-check
operations. Personal connection management remains available.

Pasted connection credentials, OAuth client secrets, OAuth connection tokens,
and dependent tool discovery run only after the outermost transaction commits
their row, including when a plugin wraps creation in `ctx.transaction`. Each
committed row records unique provider item references owned by that write
attempt. Reads resolve only those recorded references, so the post-commit
window fails closed with a retryable incomplete-write error and can never
resolve a predecessor's credential. A process crash leaves detectable missing
references; a later executor incarnation can atomically replace and retry a
stranded pasted connection, while OAuth client and connection retries replace
their rows through their existing update paths.

If credential persistence fails while the process remains alive, row and
provider compensation restore the prior state where possible and surface
incomplete cleanup explicitly. Best-effort cleanup can leave inert orphaned
attempt items, but an attempt never shares an item reference with a successor,
eliminating the former successor-clobber interval without requiring provider
compare-and-set support.
