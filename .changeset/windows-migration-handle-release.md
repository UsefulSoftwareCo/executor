---
"executor": patch
---

Fix the desktop and CLI daemon crashing on first launch on Windows when a v1 local database is present. The v1 to v2 data migration performed file operations (fsync, rename, remove) on libSQL SQLite files whose native OS handles linger after close() on Windows, surfacing as a fatal "Unknown error" (EPERM on fsync of a read-only handle, EBUSY on rename/remove of just-closed files). POSIX is unaffected, so this only reproduced on Windows. The migration now opens files read-write for fsync (treating it as best-effort), retries removes the same way renames were already retried, and forces a GC pass on each retry so libSQL's native finalizer releases the handle before the next attempt. Fixes the v1.5.23 Windows startup regression.
