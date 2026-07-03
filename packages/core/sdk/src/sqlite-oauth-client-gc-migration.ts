// ---------------------------------------------------------------------------
// libSQL boot migration: GC dead DCR `oauth_client` rows + backfill the
// surviving ones' `origin_issuer` (issue #1120, Part C).
//
// This is the local/self-host arm of the cleanup (the cloud arm is a numbered
// Drizzle SQL migration). It runs once through the stamped `data_migration`
// ledger (see sqlite-data-migrations.ts). The decision matrix is NOT re-encoded
// as SQL — it reads the rows and applies the shared `classifyOAuthClientGc` /
// `isDcrClassifiedRow` predicates in-process, then issues targeted DELETE/UPDATE
// by primary key. Rewriting the DCR heuristic as SQLite LIKE/GLOB would be a
// second, drift-prone source of truth for a query that DELETES user data; the
// oauth_client table is tiny (a handful of rows per install), so reading it in
// full at boot is cheap. Every surviving row is left with an explicit
// `origin_kind` (DCR survivors → `dynamic_client_registration`, everything else
// → `manual`) so no row keeps a NULL classification. Idempotent: a second run
// finds no orphaned DCR rows, no null-issuer DCR survivors, and no NULL
// origin_kind rows, so it is a no-op (and the ledger skips it anyway once
// stamped).
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import {
  DataMigrationError,
  type SqliteDataMigration,
  type SqliteDataMigrationClient,
} from "./sqlite-data-migrations";
import { classifyOAuthClientGc, isDcrClassifiedRow, registrableOriginOfUrl } from "./oauth-gc";

const MIGRATION_NAME = "2026-07-02-gc-dead-dcr-oauth-clients";

const execute = (
  client: SqliteDataMigrationClient,
  stmt: string | { readonly sql: string; readonly args: readonly unknown[] },
) =>
  Effect.tryPromise({
    try: () => client.execute(stmt),
    catch: (cause) => new DataMigrationError({ migration: MIGRATION_NAME, cause }),
  });

const tableExists = (
  client: SqliteDataMigrationClient,
  table: string,
): Effect.Effect<boolean, DataMigrationError> =>
  execute(client, {
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    args: [table],
  }).pipe(Effect.map((result) => result.rows.length > 0));

/**
 * GC + backfill the `oauth_client` table on a libSQL/SQLite database.
 *
 * Returns the number of rows deleted and backfilled. Transactionally wrapped
 * (BEGIN … COMMIT, ROLLBACK on error) so a mid-run failure leaves the table
 * untouched and the (unstamped) migration re-runs cleanly next boot.
 *
 * Deletion predicate (conjunctive, fail-safe): a row is deleted iff it is
 * classified DCR AND zero `connection` rows reference its (owner, slug). The
 * connection reference is `(oauth_client_owner, oauth_client)` within the same
 * tenant. Manual apps and still-referenced DCR apps are always kept.
 */
export const runSqliteOAuthClientGcMigration = (
  client: SqliteDataMigrationClient,
): Effect.Effect<
  {
    readonly deleted: number;
    readonly backfilled: number;
    readonly stampedDcr: number;
    readonly stampedManual: number;
  },
  DataMigrationError
> =>
  Effect.gen(function* () {
    // A pre-oauth database (or a partial baseline) simply has nothing to do.
    if (!(yield* tableExists(client, "oauth_client")))
      return { deleted: 0, backfilled: 0, stampedDcr: 0, stampedManual: 0 };
    const hasConnections = yield* tableExists(client, "connection");

    const rowsResult = yield* execute(
      client,
      "SELECT tenant, owner, slug, grant, resource, origin_kind, origin_issuer, token_url FROM oauth_client",
    );
    const rows = rowsResult.rows;

    // Count connections that reference each (tenant, owner, slug) in ONE grouped
    // pass (not a COUNT per oauth_client row), so the GC decision is conjunctive
    // without an N+1. When the connection table is absent (impossible in
    // practice, but keeps this total) every DCR row counts as orphaned.
    const referenceKey = (tenant: unknown, owner: unknown, slug: unknown): string =>
      `${String(tenant ?? "")} ${String(owner ?? "")} ${String(slug ?? "")}`;
    const referenceCounts = new Map<string, number>();
    if (hasConnections) {
      const countsResult = yield* execute(
        client,
        "SELECT tenant, oauth_client_owner, oauth_client, COUNT(*) AS count FROM connection WHERE oauth_client IS NOT NULL GROUP BY tenant, oauth_client_owner, oauth_client",
      );
      for (const countRow of countsResult.rows) {
        referenceCounts.set(
          referenceKey(countRow.tenant, countRow.oauth_client_owner, countRow.oauth_client),
          Number(countRow.count ?? 0),
        );
      }
    }

    const applyAll = Effect.gen(function* () {
      let deleted = 0;
      let backfilled = 0;
      let stampedDcr = 0;
      let stampedManual = 0;

      for (const row of rows) {
        const isDcr = isDcrClassifiedRow(row);

        // Manual apps are never deleted or issuer-backfilled, but a legacy
        // (null origin_kind) manual row still gets an explicit `manual` stamp so
        // every surviving row ends this migration with a concrete classification.
        if (!isDcr) {
          if (row.origin_kind == null) {
            yield* execute(client, {
              sql: "UPDATE oauth_client SET origin_kind = 'manual' WHERE tenant = ? AND owner = ? AND slug = ?",
              args: [row.tenant ?? null, row.owner ?? null, row.slug ?? null],
            });
            stampedManual += 1;
          }
          continue;
        }

        const count = referenceCounts.get(referenceKey(row.tenant, row.owner, row.slug)) ?? 0;
        const decision = classifyOAuthClientGc(row, count);

        if (decision.action === "delete") {
          yield* execute(client, {
            sql: "DELETE FROM oauth_client WHERE tenant = ? AND owner = ? AND slug = ?",
            args: [row.tenant ?? null, row.owner ?? null, row.slug ?? null],
          });
          deleted += 1;
          continue;
        }

        // Surviving DCR row. Stamp a legacy (null origin_kind) survivor as DCR,
        // and backfill its `origin_issuer` from the registrable origin of
        // token_url when it has none, so the per-AS reuse lookup keys on it and
        // mints no new duplicate. Both live in one UPDATE per row.
        const setClauses: string[] = [];
        const setArgs: unknown[] = [];
        if (row.origin_kind == null) {
          setClauses.push("origin_kind = 'dynamic_client_registration'");
          stampedDcr += 1;
        }
        if (row.origin_issuer == null) {
          const issuer =
            row.token_url == null ? null : registrableOriginOfUrl(String(row.token_url));
          if (issuer !== null) {
            setClauses.push("origin_issuer = ?");
            setArgs.push(issuer);
            backfilled += 1;
          }
        }
        if (setClauses.length > 0) {
          yield* execute(client, {
            sql: `UPDATE oauth_client SET ${setClauses.join(", ")} WHERE tenant = ? AND owner = ? AND slug = ?`,
            args: [...setArgs, row.tenant ?? null, row.owner ?? null, row.slug ?? null],
          });
        }
      }

      yield* execute(client, "COMMIT");
      return { deleted, backfilled, stampedDcr, stampedManual };
    });

    yield* execute(client, "BEGIN");
    return yield* applyAll.pipe(
      Effect.tapError(() => execute(client, "ROLLBACK").pipe(Effect.ignore)),
      // `tapError` only fires on a typed failure, not on fiber interruption
      // (e.g. the boot sequence timing out or the process shutting down
      // mid-migration) — so without this, an interrupted run can leave the
      // transaction open. Roll back explicitly on interrupt too; never on
      // success (COMMIT already ran by then, so this is a no-op there).
      Effect.onInterrupt(() => execute(client, "ROLLBACK").pipe(Effect.ignore)),
    );
  });

/** Ledger entry for the local/self-host boot data-migration registry. */
export const oauthClientGcSqliteMigration: SqliteDataMigration = {
  name: MIGRATION_NAME,
  run: (client) => runSqliteOAuthClientGcMigration(client).pipe(Effect.asVoid),
};
