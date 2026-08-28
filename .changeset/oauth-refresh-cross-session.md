---
"@executor-js/sdk": patch
---

Share the OAuth refresh gate across execution stacks so a rotating refresh token is redeemed once.

The in-flight refresh gate was built inside `createExecutor`, so it only covered one execution stack. A host builds a fresh stack per MCP session, and now per request, so two sessions resolving the same connection each read the same stored refresh token and each believed they were the refresh winner. Against a provider that rotates refresh tokens, the loser redeems a token the winner already spent, and a provider that detects reuse revokes the whole token family: the connection dies and the user has to reauthorize. The first refresh always succeeds, so the fault stayed invisible until a later expiry.

The gate now hangs off the root database handle, which is the object hosts already share across sessions and requests, so every stack over one handle converges on one gate. Its key includes the tenant, because a gate that spans tenants would otherwise let two tenants collide on one entry.

The grant also runs on its own detached fiber that callers await, rather than on whichever caller registered it. Sharing an entry across stacks would otherwise share the first caller's cancellation: a disconnected MCP client or an execution deadline would fail every peer waiting on that entry, and would abandon a refresh token the authorization server had already rotated, which is itself a dead connection. A cancelled peer now detaches without touching the grant, and a grant nobody is left waiting on still settles and still persists the rotated token.

Deduplication covers one database handle in one process. A host that builds a fresh handle per request or per session, and any multi-instance or multi-replica deployment, is out of scope here and still needs database-backed coordination, such as a compare-and-swap on the stored refresh token.
