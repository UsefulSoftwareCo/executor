---
"@executor-js/sdk": patch
---

fix: make tool-policy writes transactional

`policiesCreate` and `policiesUpdate` previously ran their read-decide-write
(existing-row scan → position computation → create, or existence check →
update → re-read) as unsequenced statements. Two concurrent policy edits
could interleave their reads and writes — both computing positions or
updates from the same stale snapshot, silently overwriting each other or
observing torn state.

Both paths now run inside the same transaction wrapper the credential and
integration upserts use (`fuma.transaction`, real BEGIN/COMMIT on
libSQL/Postgres). Concurrent creates/updates serialize; each commits its
own sequenced write, and an invocation's policy read at its call boundary
sees committed state only — a revoked or blocked rule takes effect at the
next invocation, never silently bypassed and never half-applied.
