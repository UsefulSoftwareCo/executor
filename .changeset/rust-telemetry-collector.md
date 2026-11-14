---
"@executor-js/telemetry": patch
"@executor-js/hosted-self-host": patch
---

The bundled telemetry collector is now `executor-collector`, written in Rust,
in place of Motel. Local, desktop and self-host builds start it where they
started Motel, with the same bounds: seven days and 1 GiB of telemetry, and
exports of at most 16 MiB, four at a time. Measured, it holds 7 to 18 MiB at rest and 27 to 38 MiB under the
product's load, and keeps up at its bound, where Motel fell behind. Locally it serves the trace
viewer at the address in `diagnostics/collector.json`; it stores telemetry in
`diagnostics/collector`. Self-host keeps `EXECUTOR_MOTEL_DATA_DIR`, whose name
is historical, and `executor-host telemetry`. Telemetry Motel stored, up to
about 1 GiB, is neither read nor removed: delete `diagnostics/motel` in the
data directory (by default `~/.executor/v2/cli/diagnostics/motel`), or on a
self-hosted volume run `docker exec <container> rm -rf /app/motel-data/motel`.
