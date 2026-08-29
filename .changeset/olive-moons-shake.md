---
"executor": patch
---

Stop exporting credential-bearing URLs in telemetry. Every query parameter
value, URL fragment, and userinfo component is stripped from exported span
URLs — no parameter name is trusted — on every exporter path: the cloud span
processors, the self-host OTLP exporter, the browser client's OTLP exporter,
and the forwarded browser trace batches. User-supplied MCP endpoints are
sanitized before being stamped onto spans.
