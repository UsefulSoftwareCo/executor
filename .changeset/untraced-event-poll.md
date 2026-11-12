---
"@executor-js/sdk": patch
---

Self-host and local check for due event deliveries every two seconds. That
check no longer records traces when it finds nothing to deliver; each delivery
attempt and each subscription it expires is still traced. An idle self-host
instance no longer fills the bundled Motel store with polling spans.
