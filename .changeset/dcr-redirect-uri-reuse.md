---
"@executor-js/sdk": patch
---

Re-register a dynamically registered OAuth client when the configured callback URL changes instead of reusing the stale registration. DCR clients now persist the redirect URI they registered with the authorization server (`oauth_client.origin_redirect_uri`), and the per-issuer reuse lookup compares it against the current flow callback — a mismatch (for example after a sandbox recreation moved the callback origin) mints a fresh client rather than pairing the old registration with the new callback, which strict providers reject with `invalid_redirect_uri`. The stale client row is left in place so existing connections keep refreshing through it; clients persisted before this release have no stored redirect URI and continue to be reused as before.
