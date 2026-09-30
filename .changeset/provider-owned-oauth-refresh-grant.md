---
"@executor-js/sdk": minor
---

`CredentialProvider` gains an optional `refreshGrant`. When a provider implements it, Executor asks it to perform the OAuth refresh exchange instead of asking it for the refresh token: the provider spends the token, seals the newly minted access token (and a rotated refresh token, if the authorization server sent one) under the same item ids, and reports only the granted lifetime and scope. Executor re-validates that metadata, reads the access token back through `get` like any other credential, and never resolves the refresh token or the client secret on that path.

A refused grant comes back as `RefreshGrantRejected` carrying a closed standards-defined token-endpoint code, so a delegated refusal classifies re-authentication, surfaces `invalid_grant` to the caller, and arms the known-dead gate exactly as a host-side refusal does. Providers that do not implement `refreshGrant` are unaffected, and so are the grants that have no refresh token to delegate.
