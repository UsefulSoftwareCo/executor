---
"@executor-js/sdk": patch
"@executor-js/hosted-server": patch
"@executor-js/hosted-self-host": patch
---

A `Credentials` store may add `renew` and `revoke`. When it does, OAuth renewal and the
revocation that follows account deletion run inside the store, and the host never reads the
refresh token or client secret. Self-host takes `EXECUTOR_CREDENTIAL_ADAPTER_URL` to use such a
store over HTTP; every sealed record then goes through it, and `EXECUTOR_ENCRYPTION_KEY` seals
nothing.
