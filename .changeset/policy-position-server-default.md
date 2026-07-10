---
"executor": patch
---

Policy create now defaults a new rule's position below any more-specific existing rule on the server, so a broad rule written without an explicit position (stale UI, API, agent tool) cannot shadow an existing narrower rule.
