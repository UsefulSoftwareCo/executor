---
"@executor-js/sdk": patch
"@executor-js/hosted-server": patch
"@executor-js/telemetry": patch
---

A check for due runs, queued provisioning jobs or event deliveries that fails is
traced again, though a check that finds nothing is not. Each failure is
exported as its own root span with the error it recorded, as are a failed
claim of a due event delivery and failed event retention.
