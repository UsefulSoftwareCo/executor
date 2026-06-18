---
"executor": patch
---

Windows installs now repair stale Executor service listeners and only report success after the background daemon publishes the sign-in manifest used by `executor web`. The desktop app also attaches to a reachable supervised daemon before trusting Windows PID probes, so it no longer starts a competing sidecar when the background service already owns the port.
