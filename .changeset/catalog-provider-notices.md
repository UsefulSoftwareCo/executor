---
"@executor-js/hosted-server": patch
"@executor-js/hosted-web": patch
"@executor-js/ui": patch
---

Hosted catalog feeds can provide optional provider-specific connection notices, shown before a
person connects. Cloud deployments now honor an explicit `EXECUTOR_CATALOG_URL` and keep the
official feed as the default. The official GitHub REST app can use a separately configured
`github-oauth` client with only the scopes it declares and a token placement limited to
`api.github.com`.
