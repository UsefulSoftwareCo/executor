# Fork migration numbering

Migration IDs already issued by the fork are immutable. Never reuse an ID for a different migration, rename an applied journal entry, or relabel the database to bypass an upgrade. During upstream sync, compare both migration journals before appending new steps.

PR #92 keeps Cloud `14_v1_import_failed_keeps_id` unchanged. Upstream's IDs 14–16 are appended on this fork as:

| Upstream ID | Fork ID | Name                          |
| ----------- | ------- | ----------------------------- |
| 14          | 15      | `v1_import_into_integrations` |
| 15          | 16      | `v1_legacy_urls`              |
| 16          | 17      | `v1_captured_api_keys`        |

The mapping lives in `apps/hosted/cloud/src/implementation/migrations.ts` (`private_cloud_migrations`). Future syncs must retain it and append after the highest issued fork ID, not copy upstream numbering over existing entries. Cloud migrations run before server replacement: keep the running server online and compatible, including after deployment failure.
