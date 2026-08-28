// ---------------------------------------------------------------------------
// Data migration: rebuild tool catalogs whose operations return NDJSON.
//
// Extraction used to persist an NDJSON operation's PER-LINE response schema as
// the tool's output schema, while the invoke path returns an ARRAY of parsed
// lines, so describe previews promised a single object that invocations never
// returned. The producer now wraps those schemas in an array; the per-line
// shape can't be recognized from a persisted `tool` row alone (it's just a
// JSON schema), but the stored operation bindings kept the response content
// type, so the affected connections are findable and the catalog machinery
// already knows how to rebuild them: stale-mark `tools_synced_at` and the next
// read re-produces the rows through the fixed producer. Mirrors the cloud
// drizzle migration (apps/cloud/drizzle/0010_ndjson_output_arrays.sql).
//
// Effectively idempotent: re-running re-marks the same connections, and a
// rebuild from unchanged bindings writes identical rows.
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import { DataMigrationError, type SqliteDataMigrationClient } from "@executor-js/sdk/core";

const MIGRATION_NAME = "2026-07-09-openapi-ndjson-output-arrays";

// Substring probes for the NDJSON media types (NDJSON_MEDIA_TYPES in
// openapi-utils.ts). The binding JSON inside `plugin_storage.data` may be a
// nested object or a re-encoded string, so a LIKE over the raw row text is the
// shape-agnostic match; false positives only cause a harmless extra rebuild.
const NDJSON_TYPE_PROBES = [
  "application/stream+json",
  "application/x-ndjson",
  "application/jsonl",
] as const;

const execute = (
  client: SqliteDataMigrationClient,
  stmt: string | { readonly sql: string; readonly args: readonly unknown[] },
) =>
  Effect.tryPromise({
    try: () => client.execute(stmt),
    catch: (cause) => new DataMigrationError({ migration: MIGRATION_NAME, cause }),
  });

const tableExists = (client: SqliteDataMigrationClient, table: string) =>
  Effect.map(
    execute(client, {
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      args: [table],
    }),
    (result) => result.rows.length > 0,
  );

/** Stale-mark every connection whose integration has at least one stored
 *  operation binding with an NDJSON response, so the next read rebuilds its
 *  tool rows (with array-wrapped output schemas). Returns the number of
 *  connections marked. Fresh databases may lack either table; nothing to
 *  migrate. */
export const runSqliteNdjsonOutputMigration = (
  client: SqliteDataMigrationClient,
): Effect.Effect<number, DataMigrationError> =>
  Effect.gen(function* () {
    for (const table of ["connection", "plugin_storage"]) {
      if (!(yield* tableExists(client, table))) return 0;
    }

    const probes = NDJSON_TYPE_PROBES.map(() => "ps.data LIKE ?").join(" OR ");
    const affected = yield* execute(client, {
      sql: `SELECT DISTINCT ps.tenant AS tenant, json_extract(ps.data, '$.integration') AS integration
            FROM plugin_storage ps
            WHERE ps.collection = 'operation' AND (${probes})`,
      args: NDJSON_TYPE_PROBES.map((probe) => `%${probe}%`),
    });

    let marked = 0;
    for (const row of affected.rows) {
      if (typeof row.tenant !== "string" || typeof row.integration !== "string") continue;
      yield* execute(client, {
        sql: "UPDATE connection SET tools_synced_at = NULL WHERE tenant = ? AND integration = ?",
        args: [row.tenant, row.integration],
      });
      marked += 1;
    }
    return marked;
  });

/** Registry entry for the boot-time data-migration ledger. */
export const openApiNdjsonOutputDataMigration = {
  name: MIGRATION_NAME,
  run: (client: SqliteDataMigrationClient) =>
    runSqliteNdjsonOutputMigration(client).pipe(Effect.asVoid),
};
