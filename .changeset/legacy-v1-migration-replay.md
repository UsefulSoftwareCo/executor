---
"executor": patch
---

Fix `executor web` crashing with `no such table: plugin_storage` when upgrading from an older v1 release. The v1 → v2 data migration now replays the bundled legacy schema migrations first, so databases last touched by any pre-1.5 version are brought up to the final v1 schema before their data is migrated.
