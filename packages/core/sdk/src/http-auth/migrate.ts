/* oxlint-disable executor/no-try-catch-or-throw, executor/no-json-parse -- boundary: one-shot config migration drives a raw SQL client (JSON text columns, transaction + rollback) */
// ---------------------------------------------------------------------------
// One-off auth-config migration planner — the driver-agnostic core every app
// wires its own SQL around. Each protocol plugin exports a pure
// `migrate<Plugin>AuthConfig(config) → config | null` (null = leave the row
// untouched); this plans which integration rows to rewrite. Idempotent by
// construction: re-running over migrated rows plans zero updates.
// ---------------------------------------------------------------------------

export type AuthConfigTransform = (config: unknown) => unknown | null;

export interface AuthConfigMigrationRow {
  /** The integration row's primary key (`row_id`). */
  readonly rowId: string;
  readonly pluginId: string;
  readonly config: unknown;
}

export interface AuthConfigMigrationUpdate {
  readonly rowId: string;
  readonly config: unknown;
}

/** Plan the config rewrites for a set of integration rows. `transforms` maps
 *  plugin ids (`mcp` / `graphql` / `openapi`) to their migration functions;
 *  rows of other plugins, and rows whose transform returns null, are left
 *  untouched. */
export const planAuthConfigMigration = (
  rows: readonly AuthConfigMigrationRow[],
  transforms: Record<string, AuthConfigTransform>,
): readonly AuthConfigMigrationUpdate[] => {
  const updates: AuthConfigMigrationUpdate[] = [];
  for (const row of rows) {
    const transform = transforms[row.pluginId];
    if (!transform) continue;
    const migrated = transform(row.config);
    if (migrated !== null) updates.push({ rowId: row.rowId, config: migrated });
  }
  return updates;
};

// ---------------------------------------------------------------------------
// SQLite runner — shared by the libSQL-backed apps (local boot, selfhost
// boot). Structural client interface so this package stays dependency-free;
// `@libsql/client` satisfies it. Postgres apps (cloud) wire their own SQL
// around `planAuthConfigMigration`.
// ---------------------------------------------------------------------------

export interface SqliteAuthConfigClient {
  execute(
    stmt: string | { readonly sql: string; readonly args: readonly unknown[] },
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

/** Rewrite pre-canonical integration `config` blobs in a SQLite database.
 *  Idempotent (canonical rows plan no updates); returns the number of rows
 *  rewritten. The `integration` table may not exist yet on a fresh database —
 *  that counts as nothing to migrate. */
export const runSqliteAuthConfigMigration = async (
  client: SqliteAuthConfigClient,
  transforms: Record<string, AuthConfigTransform>,
): Promise<number> => {
  const exists = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'integration'",
  );
  if (exists.rows.length === 0) return 0;

  const result = await client.execute("SELECT row_id, plugin_id, config FROM integration");
  const rows: AuthConfigMigrationRow[] = [];
  for (const row of result.rows) {
    if (typeof row.row_id !== "string" || typeof row.plugin_id !== "string") continue;
    if (typeof row.config !== "string") continue;
    let config: unknown;
    try {
      config = JSON.parse(row.config);
    } catch {
      continue;
    }
    rows.push({ rowId: row.row_id, pluginId: row.plugin_id, config });
  }

  const updates = planAuthConfigMigration(rows, transforms);
  if (updates.length === 0) return 0;

  await client.execute("BEGIN");
  try {
    for (const update of updates) {
      await client.execute({
        sql: "UPDATE integration SET config = ? WHERE row_id = ?",
        args: [JSON.stringify(update.config), update.rowId],
      });
    }
    await client.execute("COMMIT");
  } catch (cause) {
    await client.execute("ROLLBACK");
    throw cause;
  }
  return updates.length;
};
