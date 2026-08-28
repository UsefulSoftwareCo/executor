---
"executor": patch
---

**Stale tool catalogs refresh together instead of one after another, and self-host can set the freshness window**

A tools read rebuilds every connection whose catalog has gone stale. Those rebuilds each dial their own upstream, but ran strictly one after another, so a host with several stale remote catalogs paid the sum of every server's latency on the read that tripped the TTL. The upstream listings now run concurrently, bounded so a large stale set cannot open an unbounded number of listings from one read.

Only the listings overlap. Each rebuild's catalog write stays single-file, because a self-host database is one connection issuing raw `BEGIN`/`COMMIT` and a second transaction opened while one is live fails outright. A rebuild that fails now also logs a warning naming the connection and the reason, instead of disappearing: the read still succeeds on the stale-but-working catalog and the other connections still finish, but a permanently broken connection no longer re-fails silently on every read.

Self-host also exposes the freshness window as `EXECUTOR_TOOLS_SYNC_TTL_MS`. Leave it unset for the 15-minute default, or set `off` (equivalently `null` or `false`, in any case) to disable time-based re-sync and leave stale-marking and config revision as the only refresh triggers. The value forwards to the SDK verbatim, so `0` keeps its SDK meaning: every catalog is expired on every read. A malformed, negative, or too-large-to-represent value is refused at boot rather than silently falling back to the default.
