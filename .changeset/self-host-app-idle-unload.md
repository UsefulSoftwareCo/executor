---
"@executor-js/sdk": patch
---

Self-host and local unload an app Worker or data Worker that has not been
called for five minutes, even when fewer than `EXECUTOR_APP_WORKERS` are
loaded, so an app called once no longer keeps its memory. Set
`EXECUTOR_APP_WORKER_IDLE_SECONDS` to change the idle time, or to `0` to keep
idle Workers loaded until the limit unloads them.
