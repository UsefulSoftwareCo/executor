# Better Auth OAuth Provider: refresh after the session expires

`@better-auth%2Foauth-provider@1.7.20.patch` changes `handleRefreshTokenGrant`
and `createRefreshToken` in `dist/authorize-D1IhxxSO.mjs`.

Tokens record the browser session that approved the grant. A refresh copied
that session to the new access token, even after the session had expired.
Token validation refuses an access token whose session has expired, so the
refresh answered 200 and the first MCP request with the new token answered
401. A browser session expires after seven days without use, so every
`offline_access` grant it approved stopped working at the same moment. Local
approves consent with an internal operator session, so there every grant
from one server run stopped together
([UsefulSoftwareCo/executor#2550](https://github.com/UsefulSoftwareCo/executor/issues/2550)).

With the patch, a refresh names the session on the new access and ID tokens
only while that session is live. Once it has expired or been deleted, the
refresh still succeeds and the new tokens leave out `sid`, the same way
refresh token introspection already does. The rotated refresh token keeps
its parent's session, so deleting that session still runs back-channel logout
for it. Signing out
already worked this way, so a grant now outlives an expired session as it
outlives a sign-out. Revoking the grant still ends it. An access token issued
before the patch keeps naming the expired session and stays refused until the
client refreshes.

A refresh token without `offline_access` stays bound to its session, as
sign-out already revokes it. Once that session has expired, refreshing it is
refused with `invalid_grant`, and refresh token introspection reports it
inactive. Our clients hold such a token only after asking for fewer scopes on
a refresh. This refusal is not reported to `onRefreshRejected`, like the scope
and resource refusals beside it.

`usableGrants` in `packages/mcp-auth` counts a grant's unexpired, unrevoked
`offline_access` refresh token whatever its session, to match. A refresh token
without `offline_access` counts only while its session is live.

The first change is
[better-auth/better-auth#12723](https://github.com/better-auth/better-auth/pull/12723),
released in `@better-auth/oauth-provider` 1.7.26; drop those hunks when
Executor upgrades to 1.7.26 or later. The refusal for a refresh token without
`offline_access` is from
[better-auth/better-auth#12223](https://github.com/better-auth/better-auth/pull/12223),
which no release holds yet; keep it until one does.
