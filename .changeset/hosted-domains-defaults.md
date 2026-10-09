---
"@executor-js/sdk": patch
"@executor-js/app-management": patch
"@executor-js/app-templates": patch
"@executor-js/ui": patch
"executor": patch
---

Hosted Executor's defaults move to its permanent hosts. The SDK's
`hostedExecutorOrigin`, the default public registry, is `https://api.executor.sh`.
`executor apps login` discovers the authorization server from the API host
(RFC 9728 and RFC 8414), so `--host https://api.executor.sh` works although
sign-in runs on `app.executor.sh`. Documentation links go to
`https://executor.sh/docs/`, and the CLI's homepage is `https://executor.sh`.

`executor apps git` and the dashboard's clone URL use the Git origin the host
names (`https://executor.sh/git/...` for hosted Executor) instead of the host
they called. The Git credential helper uses the session saved by
`executor apps login` at the API host for remotes on that host's Git origins,
and `v2.executor.sh` remotes keep working.
