---
"executor": patch
---

**A credential-store outage no longer costs an OAuth connection its grant**

Refreshing an OAuth token spends the stored refresh token: the authorization server rotates it, so the copy we sent stops working the moment the grant succeeds and the rotated one is the only thing that can mint again. Persisting the rotated token first bounds what a partial write can lose, but it cannot help when the store is refusing writes outright — the grant has already run, there is nowhere to put the successor, and every later refresh replays a token the server has revoked. The connection then reports `invalid_grant` and demands a re-auth over what was only a storage blip.

The refresh is now gated on a store that is proven writable. Before the grant runs, the refresh token just read is written back to its own item; a store that cannot take that write fails the resolve while the stored token is still valid, so the connection recovers on its own once the store does.

The probe also removes a write rather than adding one in the common case. Authorization servers that do not rotate hand back the same refresh token, and that value is no longer re-persisted when it has not changed — a rotated token never matches, so the write that matters still happens.
