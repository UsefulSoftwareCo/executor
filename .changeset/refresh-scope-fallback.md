---
"@executor-js/sdk": patch
---

Retry a refresh-token grant without `scope` when the authorization server refuses the echoed grant with `invalid_scope`. Railway answers a scope-bearing refresh with "refresh token missing requested scope" even though echoing the granted scope is legal under RFC 6749 §6, so a connection whose refresh token was still live failed every call as `oauth_refresh_failed` and only a hand re-authorization recovered it.
