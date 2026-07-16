---
"@executor-js/sdk": patch
"@executor-js/execution": patch
---

A token refresh the authorization server definitively rejects (any RFC 6749 error code, not just `invalid_grant`) now surfaces to the sandbox as an `oauth_refresh_failed` auth failure carrying the server's error code and description, instead of being scrubbed to "Internal tool error". `invalid_grant` still classifies as `oauth_reauth_required`. Code-less failures (transport blips) keep retrying as before.
