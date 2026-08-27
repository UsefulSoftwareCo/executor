---
"@executor-js/sdk": patch
"@executor-js/api": patch
---

Build `StorageError.message` from the call-site label plus the driver's error code instead of the driver's raw text. The driver text is drizzle's `Failed query: <sql>\nparams: <bound values>`, so error reporting grouped one storage defect by statement shape and printed bound parameters into issue titles. The full driver error stays on `cause`.

Add `StorageConnectionError`, a `StorageFailure` variant for postgres.js connection faults (`CONNECTION_ENDED`, `CONNECTION_CLOSED`, `CONNECTION_DESTROYED`, `CONNECT_TIMEOUT`, `ECONNREFUSED`, `ECONNRESET`) and workerd's cross-request I/O rejection. It carries the fault `code` and a `retryable` flag so a lost socket can be told apart from a pool-lifetime bug.
