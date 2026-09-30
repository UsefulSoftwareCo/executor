---
"executor": patch
---

Use the hosted loopback OAuth client metadata document only when Executor is opened on a loopback origin. A local Executor reached through a public reverse proxy now publishes its own client metadata document, so providers that support Client ID Metadata Documents no longer reject its callback as an invalid redirect URI.
