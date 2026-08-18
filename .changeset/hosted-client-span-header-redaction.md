---
"@executor-js/sdk": patch
---

Redact every span header attribute outside a safe allowlist on the hosted HTTP client. The tracer's default four-name blocklist let provider-specific credential headers reach the trace backend verbatim; the hosted client now inverts the model and masks everything except structurally safe negotiation, caching, and tracing headers.
