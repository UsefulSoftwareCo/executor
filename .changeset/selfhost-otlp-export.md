---
"@executor-js/host-selfhost": patch
---

Export self-host traces to an OpenTelemetry collector when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so a slow request can be read as a waterfall rather than a wall-clock number. Off by default; logs are a separate opt-in via `EXECUTOR_OTEL_EXPORT_LOGS`.
