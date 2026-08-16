---
"executor": patch
---

**Fix: `oauth.clients.remove` reported success for clients it never removed**

The tool returned `{ removed: true }` unconditionally. `oauth.removeClient` is idempotent by design at the storage layer — `deleteMany` on a missing row is a no-op, which is the right behaviour for a delete — but the tool mapped that silence to success, so a typo'd slug, an already-deleted client, and the wrong owner were all indistinguishable from a real deletion.

This bites hardest because clients are keyed by BOTH owner and slug, so the same slug can exist separately under `org` and `user`. An agent sweeping a list of slugs under one hardcoded owner would delete only half of them and report every call as a success, leaving org-owned OAuth apps registered after everything they authorized was gone.

The tool now checks the caller-visible client set first and returns `removed: false` when nothing matched that `(owner, slug)` pair. The service-level `removeClient` is unchanged and stays idempotent.
