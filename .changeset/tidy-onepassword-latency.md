---
"@executor-js/plugin-onepassword": patch
---

**1Password-backed connections no longer pay a 1Password read on every tool call**

Each tool call resolves its connection's credential, and for 1Password-backed connections every resolution shelled out to the `op` CLI — roughly a second per call under desktop-app auth, multiplying the latency of every call several times over. The spawn was also synchronous, so one slow resolution (for example `op` waiting on a 1Password approval prompt) blocked the whole local server for every other request, with no timeout on that path.

Three changes:

- Successful resolutions are now served from memory for a short TTL (default 60s, `secretCacheTtlMs`). The cache keys by a fingerprint of the provider config, so editing or removing an account drops all cached secrets at once; not-found, ambiguity, and failure outcomes are never retained. Concurrent resolutions of the same ref share one backend read even with the TTL set to `0`.
- The `op` CLI now runs as an asynchronous spawn with a hard deadline (the plugin's existing `timeoutMs`), so a stuck `op` fails with the troubleshooting message instead of freezing the server. Auth reaches the child per spawn (service-account token via the environment, desktop account via `--account`) instead of through the previous backend's process-global token state.
- Services are memoized per auth identity, so the SDK fallback reuses one authenticated client instead of re-authenticating per resolution.
