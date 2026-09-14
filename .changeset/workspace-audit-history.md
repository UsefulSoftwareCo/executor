---
"@executor-js/sdk": minor
"@executor-js/api": minor
---

**Workspace audit history**

Connection, integration, OAuth-client, and tool-policy mutations now append
tenant-scoped audit events containing only actor and safe resource identifiers.
Admins can inspect the history in the Users page Activity tab or through
`GET /admin/audit-events`.

The history records `created`, `updated`, and `removed` row intent. When
post-commit credential persistence fails, successful row compensation appends
`rolled_back`; a later provider-cleanup failure appends `rollback_failed`, so
the history never claims complete compensation when credential restoration was
incomplete.
