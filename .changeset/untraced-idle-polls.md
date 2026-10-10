---
"@executor-js/sdk": patch
"@executor-js/hosted-server": patch
---

The scheduler's check for due runs, every second on self-host and local, and
self-host's check for queued provisioning jobs, every second, no longer record
traces when they find nothing to do. Each scheduled operation a check finds is
still traced, in its own `schedule.dispatch` trace, and so is each provisioning
job. An idle self-host instance no longer fills the bundled Motel store with
polling spans.
