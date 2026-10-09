---
"@executor-js/sdk": patch
---

`createExecutor` takes an optional `webhookOrigin`: new webhook subscriptions
register their callbacks there instead of on `origin`. Existing subscriptions
keep the callback URL they stored.
