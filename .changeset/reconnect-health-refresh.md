---
"executor": patch
---

**Fix: reconnecting an OAuth connection now refreshes its health status in place — no page reload needed**

Completing a reconnect previously left the stale "Expired" verdict on the connection row (and the integrations-list summary) until a hard refresh. Re-minting now clears the persisted verdict, and the UI re-probes as soon as the refreshed connection arrives.
