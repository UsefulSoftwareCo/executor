---
"@executor-js/sdk": patch
"@executor-js/execution": patch
---

**Fix: a filtered tools read no longer waits on unrelated integrations' catalog refreshes**

`tools.list` refreshes stale tool catalogs before it answers, and each refresh is a live upstream handshake. That scan ignored the read's own filter, so `GET /api/tools?integration=railway` re-listed every stale connection in the workspace — thirteen sequential handshakes for integrations the caller had not asked for, none of them railway. The scan also applied the remote-catalog freshness TTL globally, so any connection older than the TTL was fetched in full and then discarded by a per-row check.

The refresh now scopes to the same `integration`/`owner`/`connection` filter the read uses, narrows the TTL and config-revision triggers to the integrations they can actually fire for, projects only the four columns it reads, and runs the remaining refreshes concurrently instead of one at a time. A plugin defect raised during a refresh can no longer fail the read. Tool search's empty-query enumeration pushes its namespace into the read for the same reason.
