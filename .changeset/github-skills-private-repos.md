---
"apps": patch
"@executor-js/sdk": patch
---

`githubSkills` reads private repositories. Pass the selected GitHub `account`
and its `token`. Declare hosts `github.com` and `raw.githubusercontent.com` on
the provider, so app code holds a handle and Executor sends the token with
every request of the read. The catalog is cached in that account's scope. A
token GitHub rejects is reported against its account: skill reads now return
`AppProviderFailed` for a loader's provider errors.
