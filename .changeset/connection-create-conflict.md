---
"@executor-js/sdk": patch
---

Creating a connection over an existing one is now rejected instead of silently overwriting it. `connections.create` fails with `ConnectionAlreadyExistsError` (HTTP 409) when the (owner, integration, name) is already taken, and `oauth.start` / `oauth.complete` reject a fresh OAuth connect that targets an existing connection name. Reconnect flows pass `reconnect: true` and keep re-minting the same connection for re-consent and token refresh.
