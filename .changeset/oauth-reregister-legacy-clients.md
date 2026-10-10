---
"@executor-js/sdk": patch
---

A client Executor registered at one of `previousRedirectUris` is registered again at the current
callback. Only entered clients, and clients for servers that neither register clients nor read a
metadata document, keep sending the previous callback.
