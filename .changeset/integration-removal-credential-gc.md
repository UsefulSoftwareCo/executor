---
"executor": patch
---

**Removing an integration now removes the credentials its connections minted**

`integrations.remove` deletes every connection row belonging to the integration. It left the credentials those connections had minted in the store — the same orphan `connections.remove` was fixed to prevent, reachable through a different path and stranding many secrets at once rather than one.

An orphaned refresh token is the worst case: long-lived by design, no longer referenced by anything, and invisible in the product, so nobody can see it to revoke it.

The rows are read before they are deleted, because once they are gone nothing names the items they minted. Only minted ids are removed — an item the connection merely referenced is left alone, exactly as on the single-connection path. The deletion is deferred until the removal commits, so a rolled-back removal leaves the credentials intact rather than restoring connections that point at secrets which no longer exist.
