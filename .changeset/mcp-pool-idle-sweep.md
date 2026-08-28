---
"executor": patch
---

**Idle MCP connections age out on the pool's next acquire, even when their identity is never dialled again**

The pool's five-minute idle window was only consulted against the entry being requested, so an identity that was never asked for a second time was never examined a second time. Its session stayed open and authenticated for as long as the pool lived, holding the bearer token or API key it was dialled with. The advertised bound applied only to connections that happened to be reused.

`acquire` now sweeps every entry past the window, closing each one, rather than just the entry matching the key. This stays lazy in the sense the pool intends — activity drives it, there is no timer and no background fiber — and the map holds at most one entry per identity, so the scan is trivial.

Because the sweep is paid for by whichever invocation acquires next, it cannot be allowed to stall that caller. The expired entries leave the pool synchronously, before any close is awaited, and the closes then run concurrently with each one bounded by a two-second timeout — so a server that accepts a close and goes quiet is abandoned rather than waited on, and cannot hold up an unrelated request or the connections queued behind it.

Reuse is unchanged: an entry still inside the window is left alone, and a second call for the same identity still gets the parked session rather than a fresh dial.
