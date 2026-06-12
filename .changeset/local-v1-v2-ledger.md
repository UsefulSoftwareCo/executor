---
"executor": patch
---

**Hardened the local v1→v2 database upgrade**

Upgrading a local database created by an older (v1) release is now resilient to
interrupted or partially-written upgrade state:

- The one-time upgrade is recorded in the migration ledger, so it is never
  re-attempted on later boots. Databases that have already upgraded are detected
  from the ledger and skip the upgrade path entirely.
- Replaying the legacy schema now tolerates a missing or truncated migration
  journal instead of failing to start, so a database left in a half-written
  state from a previous crash boots cleanly.
