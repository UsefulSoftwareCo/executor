---
"@executor-js/cloud": patch
"@executor-js/api": patch
"@executor-js/host-selfhost": patch
---

Cloud now authorizes every protected request against the local membership mirror through the shared `MemberDirectory` seam: the per-request org membership check, the admin gates on the account and admin planes, the org switcher's organization list, and the free-organization limit all read the mirror instead of calling WorkOS. WorkOS is now a write target and an event source only. The seam gains `membershipsOf(accountId)` and `membershipById(organizationId, membershipId)` on both hosts.

The mirror is trusted only while it is **ready**: the backfill has written every organization and the Events reconciler has drained the stream within the last ten minutes (both recorded on the `workos_sync` row). Until then the membership check falls back to WorkOS, exactly as before, so a member the backfill has not written yet is not locked out and a member revoked while the reconciler was down is not let in. The deploy runs `scripts/ensure-workos-mirror-ready.ts` after the migrations: it runs the backfill if needed, drains the events stream itself if the reconciler has not recently (so the gate never waits on a cron this same deploy ships), and fails the deploy if the mirror is still not ready. An organization the mirror does not hold at all (one that predates the mirror and nobody has signed in to since) is resolved from WorkOS on demand for a caller WorkOS confirms as its member, so CLI and MCP tokens naming such an organization are not refused. Deleting an organization now cancels billing before deleting the WorkOS organization, and a retry after a partial deletion is admitted from the mirror even while the mirror is not ready.

**Ops step (cloud):** add the `WORKOS_API_KEY` secret to the `production` GitHub environment so the deploy gate can run the backfill.
