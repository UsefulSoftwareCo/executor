---
"@executor-js/plugin-graphql": patch
---

A GraphQL liveness probe no longer reads a transport failure's prose as a dead credential. Classification matched any upstream message containing "permission", which an operating-system refusal also carries — `connect EACCES: permission denied` on a socket reported the connection as `expired` and asked the user to re-enter a secret that was never the problem. Prose is now consulted only when the failure is not a transport failure; an HTTP 401 or 403 still classifies on its status.
