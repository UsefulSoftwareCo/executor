---
"executor": patch
---

Self-hosted instances no longer lose data on restart. Better Auth now shares
the same libSQL connection as the rest of the instance instead of opening its
own. Previously the two connections each managed their own write-ahead log on
the shared database file, and the second one to open could orphan the first —
so integrations, connections, and tools written after startup landed in a
discarded log and disappeared on the next restart, while sign-in data survived.
This is the "reconnected my account but it has zero tools" failure; a single
shared connection removes the split entirely.
