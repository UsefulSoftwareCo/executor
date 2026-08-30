---
"@executor-js/sdk": patch
---

**Faster dynamic tool calls: independent storage reads run concurrently**

Every dynamic tool call paid for its bookkeeping reads one at a time: first the tool row, then the active policy rules, then the connection row, and later the credential resolution followed by the integration row. Each read is a separate storage round-trip, so the serial chain added tens of milliseconds per call locally and more against a remote database. The reads are mutually independent, so they now run concurrently: the tool, policy, and connection reads overlap before approval, and credential resolution overlaps the integration read after approval. Approval enforcement still completes before credential resolution starts — a declined call never triggers a token refresh — and each read's failure still surfaces at the same point with the same error as before.
