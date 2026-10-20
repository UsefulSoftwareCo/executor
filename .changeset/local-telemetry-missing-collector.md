---
"@executor-js/local-server": patch
---

A local server whose bundled telemetry collector is not built (or whose `EXECUTOR_MOTEL_BUNDLE`
path is wrong) now logs one warning that names the path and runs without it. It used to log
"Local telemetry collector failed" with a stack trace every 3 seconds.
