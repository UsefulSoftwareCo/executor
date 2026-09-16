---
"@executor-js/sdk": patch
---

Treat an explicit dynamic-client redirect URI as authoritative when selecting a reusable OAuth client. Legacy clients with no recorded redirect now remain available to existing connections while a new client is registered for the explicit callback; callers that rely on Executor's configured default retain the previous compatibility behavior.
