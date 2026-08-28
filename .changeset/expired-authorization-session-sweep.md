---
"executor": patch
---

**Abandoned authorization sessions no longer keep their PKCE verifier forever**

An OAuth authorization session stores its PKCE verifier so the callback can redeem the code. `complete` discarded an expired session lazily, but an _abandoned_ flow is never completed, so that check never ran for it and nothing else swept the table — the verifier sat there in plaintext indefinitely.

Starting a new authorization now sweeps sessions that have already expired. Doing it on `start` bounds the table by how often authorization is begun rather than by how often it is abandoned, and needs no scheduler in any host. A session whose completion cannot be retried is dropped rather than left behind.

The sweep only ever reaches rows the caller can already see, so one member's authorization never touches another member's sessions. It is best-effort: a sweep that fails logs a warning and lets the authorization continue.
