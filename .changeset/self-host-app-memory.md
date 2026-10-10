---
"@executor-js/sdk": patch
"@executor-js/app-data": patch
"@executor-js/telemetry": patch
"apps": patch
---

Self-host and local hold much less memory while apps are called. Each app
isolate collects its garbage after a call. Data Workers now count against
`EXECUTOR_APP_WORKERS`, whose default rises from 32 to 64 so that as many apps
stay loaded as before. The app telemetry relay exports every queued batch
together instead of one at a time, so a burst of scheduled runs no longer
overflows it.
