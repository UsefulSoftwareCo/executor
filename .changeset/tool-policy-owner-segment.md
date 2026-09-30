---
"@executor-js/sdk": patch
---

Tool policy patterns written in the documented `integration.connection.tool` form (no owner segment) now match as intended instead of silently never firing. `policies.create`/`policies.update` backfill the missing owner segment automatically.
