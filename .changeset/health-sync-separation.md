---
"executor": patch
---

Separate catalog-sync status from connection health: a failed tool sync no longer writes a degraded health verdict, and is instead tracked per connection with a consecutive-failure count surfaced as a muted stale-catalog hint.
