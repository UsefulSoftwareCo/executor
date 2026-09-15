---
"@executor-js/cloud": patch
"@executor-js/api": patch
"@executor-js/host-selfhost": patch
---

Cloud now authorizes every protected request against the local membership mirror through the shared `MemberDirectory` seam: the per-request org membership check, the admin gates on the account and admin planes, the org switcher's organization list, and the free-organization limit all read the mirror instead of calling WorkOS. WorkOS is now a write target and an event source only. The seam gains `membershipsOf(accountId)` and `membershipById(organizationId, membershipId)` on both hosts.

**Deploy prerequisite (cloud):** the mirror backfill (`db:backfill-workos-mirror:prod`) must have completed and the Events reconciler must be running before this build is deployed; a member missing from the mirror is denied access until their next sign-in or the reconciler lands their membership.
