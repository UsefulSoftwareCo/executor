---
"executor": patch
---

Add `connections.refreshOAuthToken` and `POST /connections/:owner/:integration/:name/oauth/refresh`, which run a connection's OAuth refresh grant on demand, even when the access token is not yet due, and return the new expiry with a health verdict. Calling it on a schedule keeps an idle connection's refresh token inside a provider's inactivity window, so it does not die with `invalid_grant`.
