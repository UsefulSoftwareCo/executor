---
"@executor-js/sdk": patch
---

Allow registered OAuth clients to use interoperable `client_secret_basic` at the token endpoint. Basic credentials preserve the literal client ID and secret expected by common providers. The selected client-auth method is persisted and reused for authorization-code exchanges, client-credentials mints, token refreshes, and client-credentials re-mints; existing clients continue to default to `client_secret_post`.
