---
"executor": patch
---

**A credential-store outage no longer costs an OAuth connection its grant**

Refreshing an OAuth token spends the stored refresh token: the authorization server rotates it, so the copy we sent stops working the moment the grant succeeds and the rotated one is the only thing that can mint again. Persisting the rotated token first bounds what a partial write can lose, but it cannot help when the store is refusing writes outright — the grant has already run, there is nowhere to put the successor, and every later refresh replays a token the server has revoked. The connection then reports `invalid_grant` and demands a re-auth over what was only a storage blip.

The refresh is now gated on a store that is proven writable. Before the grant runs, it writes a fixed value to an item of its own that holds no credential and sits in the same partition as the connection's tokens. A store that cannot take that write fails the resolve while the stored refresh token is still valid, so the connection recovers on its own once the store does.

The probe deliberately does not test the store by rewriting the refresh token with the value it just read. That is a read-then-write with no compare-and-set, and two instances refreshing one connection would lose the newer token to it: one reads the stored token, the other spends that same token and stores its rotated replacement, and the first then writes the spent one back over the replacement. The connection would die exactly the way the gate is meant to prevent.

The probe also removes a write rather than adding one in the common case. Authorization servers that do not rotate hand back the same refresh token, and that value is no longer re-persisted when it has not changed — a rotated token never matches, so the write that matters still happens.
