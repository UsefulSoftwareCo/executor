---
"@executor-js/cloud": patch
---

An admin who resumes a paused execution from a different MCP session (for example after the client reconnects) keeps workspace-write access. The forwarded resume now carries the requester's access to the session that owns the execution, so a pending `addServer`, `addSpec`, or similar write no longer fails with `org_write_denied`.
