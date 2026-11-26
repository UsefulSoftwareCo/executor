---
"@executor-js/sdk": patch
"@executor-js/app-management": patch
"@executor-js/ui": patch
"@executor-js/hosted-web": patch
"@executor-js/hosted-server": patch
"@executor-js/hosted-cloud": patch
---

Operators can turn off app publishing with `EXECUTOR_APP_PUBLISHING=off`
(default `on`). The catalog stays readable; publish and unpublish are refused
for people and agents alike. `GET /app-publications/status` reports whether the
host publishes, and the app page shows no Publish control when it does not.
`RegistryOptions` takes `publishing: false` to keep a stored catalog read-only.
