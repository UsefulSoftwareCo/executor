---
"@executor-js/sdk": minor
"@executor-js/api": minor
"@executor-js/plugin-graphql": minor
"@executor-js/plugin-mcp": minor
"@executor-js/plugin-openapi": minor
---

**Workspace-level settings are now admin-only**

The executor binding gains `orgWrites: "allowed" | "denied"`. Hosts derive it
from the acting member's role (cloud: WorkOS membership role; self-host:
Better Auth org membership role), and a plain member's binding refuses every
user-intent workspace-level mutation with the new `OrgWriteDeniedError`
(HTTP 403): Workspace connections, org-owned tool policies, org OAuth apps and
org connect flows, and integration-catalog changes (add, update, remove, health
check). Plain members can still add and manage Personal connections; the
console removes the Workspace choice while retaining the Personal flow.

Using workspace resources is unchanged for members: reads, tool execution over
shared connections, and the operational writes those imply (token refresh,
tool-catalog re-sync, config-rewrite healing) keep working. Hosts with no role
model (local, the CLI, embedded SDK use) default to `"allowed"`.

Successful connection, integration, and OAuth-client create/update/remove
operations now write a tenant-scoped audit event with the acting user, resource
scope, and safe identifiers. Admins can list the newest events through
the Users page's Activity tab or `GET /admin/audit-events`; actor email and
display name are joined from the host directory, while credentials and
free-form configuration are never stored in or returned by the audit surface.
