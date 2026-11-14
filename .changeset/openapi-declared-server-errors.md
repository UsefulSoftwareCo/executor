---
"apps": patch
---

An OpenAPI operation that declares an error response for a 5xx, 401 or 429 status
now quotes that response's declared code and message on the provider failure, as
the service's stated error. Before, the status alone decided the failure and the
body was not read, so an API that explains its server errors, such as Executor's
own API through the Executor app, read as a bare "server error". The failure keeps
its reason, status, account recovery and retry policy.
