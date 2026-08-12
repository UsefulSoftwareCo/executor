---
"@executor-js/sdk": minor
"@executor-js/plugin-graphql": minor
"@executor-js/plugin-mcp": minor
"@executor-js/plugin-openapi": minor
---

**Workspace-level settings are now admin-only**

The executor binding gains `orgWrites: "allowed" | "denied"`. Hosts derive it
from the acting member's role (cloud: WorkOS membership role; self-host:
Better Auth org membership role), and a plain member's binding refuses every
user-intent workspace-level mutation with the new `OrgWriteDeniedError`
(HTTP 403): org-owned tool policies, workspace-shared connections, org OAuth
apps and org connect flows, and integration-catalog changes (add, update,
remove, health check).

Using workspace resources is unchanged for members: reads, tool execution over
shared connections, and the operational writes those imply (token refresh,
tool-catalog re-sync, config-rewrite healing) keep working. Hosts with no role
model (local, the CLI, embedded SDK use) default to `"allowed"`.
