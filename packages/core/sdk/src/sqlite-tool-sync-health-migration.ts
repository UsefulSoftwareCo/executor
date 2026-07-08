// ---------------------------------------------------------------------------
// libSQL boot migration: clear tool-sync verdicts out of `last_health`.
//
// Before catalog-sync status got its own column (`tools_sync_error`), a failed
// tool sync wrote a degraded HealthCheckResult onto `last_health` with a
// "Tool sync failing: …" detail. Those rows were never credential-health
// verdicts, so they are cleared rather than translated: the next sync failure
// (if the trouble is real and persistent) re-records itself on the new column
// with an honest consecutive-failure count. The cloud arm is drizzle 0010.
// Idempotent: the predicate matches nothing after the first run.
// ---------------------------------------------------------------------------

import { sqliteDataMigration, type SqliteDataMigration } from "./sqlite-data-migrations";

export const toolSyncHealthCleanupDataMigration: SqliteDataMigration = sqliteDataMigration(
  "2026-07-07-clear-tool-sync-health-verdicts",
  async (client) => {
    // Legacy databases can predate the `last_health` column entirely (it is
    // boot-ensured later in startup, after data migrations run) — nothing to
    // clean there.
    const columns = await client.execute(`PRAGMA table_info('connection')`);
    if (!columns.rows.some((row) => row.name === "last_health")) return;
    await client.execute(
      `UPDATE connection
       SET last_health = NULL
       WHERE last_health IS NOT NULL
         AND json_valid(last_health)
         AND json_extract(last_health, '$.detail') LIKE 'Tool sync failing%'`,
    );
  },
);
