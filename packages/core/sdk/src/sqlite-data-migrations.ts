// ---------------------------------------------------------------------------
// Stamped data-migration ledger for the libSQL-backed apps (local boot,
// selfhost boot). Cloud runs schema + data migrations through its drizzle
// chain out-of-band; the local apps have no operator, so their migrations
// run at boot — and before this ledger existed, each one re-scanned its
// tables on every startup to decide "did I already run?" by data shape.
// That accumulates (N migrations = N full-table scans per boot, forever)
// and makes idempotence a per-migration proof obligation.
//
// This is the rail instead: a `data_migration` table (name → completion
// time), an ordered registry the app composes, and a runner that executes
// each pending migration once and stamps it. Stamped names are skipped
// without touching the data.
//
// Write migrations idempotently anyway (defense in depth — the support
// remedy for a half-applied state is deleting the stamp row and
// rebooting). One deliberate semantics change from the scan-every-boot
// era: after a migration is stamped, rows written later by an OLDER binary
// (downgrade, then re-upgrade) are NOT re-healed. That matches the cloud
// chain's semantics; the stamp row, not the data shape, is the source of
// truth.
// ---------------------------------------------------------------------------

import { Data, Effect } from "effect";

/** Structural client interface so this module stays dependency-free;
 *  `@libsql/client` satisfies it. */
export interface SqliteDataMigrationClient {
  execute(
    stmt: string | { readonly sql: string; readonly args: readonly unknown[] },
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

export class DataMigrationError extends Data.TaggedError("DataMigrationError")<{
  /** The migration that failed, or null when the ledger itself did. */
  readonly migration: string | null;
  readonly cause: unknown;
}> {}

export class DuplicateDataMigrationError extends Data.TaggedError("DuplicateDataMigrationError")<{
  readonly name: string;
}> {}

export interface SqliteDataMigration {
  /** Stable unique id, date-prefixed so the registry reads in order
   *  (e.g. "2026-06-05-auth-config-placements"). Renaming an applied
   *  migration re-runs it — never rename. */
  readonly name: string;
  readonly run: (client: SqliteDataMigrationClient) => Effect.Effect<void, DataMigrationError>;
}

const LEDGER_TABLE = "data_migration";

const execute = (
  client: SqliteDataMigrationClient,
  stmt: string | { readonly sql: string; readonly args: readonly unknown[] },
  migration: string | null,
) =>
  Effect.tryPromise({
    try: () => client.execute(stmt),
    catch: (cause) => new DataMigrationError({ migration, cause }),
  });

/** Wrap a promise-shaped migration body as a registry entry. */
export const sqliteDataMigration = (
  name: string,
  run: (client: SqliteDataMigrationClient) => Promise<unknown>,
): SqliteDataMigration => ({
  name,
  run: (client) =>
    Effect.tryPromise({
      try: () => run(client),
      catch: (cause) => new DataMigrationError({ migration: name, cause }),
    }).pipe(Effect.asVoid),
});

/**
 * Run every registry entry whose name has no stamp row, in registry order,
 * stamping each on success. Returns the applied names.
 *
 * Atomicity is the migration's own job (the existing migrations run their
 * rewrites inside BEGIN…COMMIT), so the runner does not wrap them — SQLite
 * has no nested transactions. The stamp is written after the migration
 * succeeds; a crash between the two re-runs the (idempotent) migration on
 * the next boot, which is a no-op. A failed migration leaves no stamp and
 * fails the boot.
 */
export const runSqliteDataMigrations = (
  client: SqliteDataMigrationClient,
  migrations: readonly SqliteDataMigration[],
): Effect.Effect<readonly string[], DataMigrationError | DuplicateDataMigrationError> =>
  Effect.gen(function* () {
    const names = new Set<string>();
    for (const migration of migrations) {
      if (names.has(migration.name)) {
        return yield* new DuplicateDataMigrationError({ name: migration.name });
      }
      names.add(migration.name);
    }

    yield* execute(
      client,
      `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (name TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
      null,
    );
    const stamped = yield* execute(client, `SELECT name FROM ${LEDGER_TABLE}`, null);
    const completed = new Set(
      stamped.rows.map((row) => row.name).filter((name) => typeof name === "string"),
    );

    const applied: string[] = [];
    for (const migration of migrations) {
      if (completed.has(migration.name)) continue;
      yield* migration.run(client);
      yield* execute(
        client,
        {
          sql: `INSERT INTO ${LEDGER_TABLE} (name, time_completed) VALUES (?, ?)`,
          args: [migration.name, Date.now()],
        },
        migration.name,
      );
      applied.push(migration.name);
    }
    return applied;
  });
