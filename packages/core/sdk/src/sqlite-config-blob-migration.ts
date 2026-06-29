// ---------------------------------------------------------------------------
// Data migration: move an oversized inline `integration.config` field into
// the blob table. The shape both protocol plugins need is identical — only
// the field names differ — so the body lives here and each plugin exports a
// ledger entry that binds its constants (openapi: spec → specHash under
// `spec/<hash>`; graphql: introspectionJson → introspectionHash under
// `introspection/<hash>`).
//
// Blob rows are written with the EXACT naming `makeFumaBlobStore` +
// `pluginBlobStore` read back at runtime: namespace `o:<tenant>/<pluginId>`
// (the org partition — integration configs are catalog-level), key
// `<prefix>/<sha256>`, id `JSON.stringify([namespace, key])`. That makes it
// correct ONLY for hosts whose runtime blob backend is the FumaDB store
// (local, selfhost) — a host that reads blobs elsewhere (the D1 host reads
// R2) must not register it, or the rewritten pointers would dangle.
//
// Idempotent: pointer-shaped configs (no inline field) plan zero updates,
// and blob writes are content-addressed upserts.
// ---------------------------------------------------------------------------

import { Effect, Option, Schema } from "effect";

import { sha256Hex } from "./blob";
import { DataMigrationError, type SqliteDataMigrationClient } from "./sqlite-data-migrations";

export interface SqliteConfigBlobMigrationOptions {
  /** The ledger entry name, for error attribution. */
  readonly migrationName: string;
  /** Rows whose `plugin_id` equals this are candidates. */
  readonly pluginId: string;
  /** The config field holding the inline text to move (e.g. `spec`). */
  readonly inlineField: string;
  /** The config field that will carry the content hash (e.g. `specHash`). */
  readonly hashField: string;
  /** Blob key prefix; the key is `<prefix>/<sha256>` (e.g. `spec`). */
  readonly blobKeyPrefix: string;
}

const decodeJsonOption = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Move every inline `options.inlineField` in this plugin's integration
 * configs into the blob table and rewrite the config to carry
 * `options.hashField`. Returns the number of rows rewritten. The
 * `integration` table may not exist yet on a fresh database — that counts
 * as nothing to migrate.
 */
export const runSqliteConfigBlobMigration = (
  client: SqliteDataMigrationClient,
  options: SqliteConfigBlobMigrationOptions,
): Effect.Effect<number, DataMigrationError> =>
  Effect.gen(function* () {
    const execute = (stmt: string | { readonly sql: string; readonly args: readonly unknown[] }) =>
      Effect.tryPromise({
        try: () => client.execute(stmt),
        catch: (cause) => new DataMigrationError({ migration: options.migrationName, cause }),
      });

    const exists = yield* execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'integration'",
    );
    if (exists.rows.length === 0) return 0;

    const result = yield* execute({
      sql: "SELECT row_id, tenant, config FROM integration WHERE plugin_id = ? AND config IS NOT NULL",
      args: [options.pluginId],
    });

    interface PlannedMove {
      readonly rowId: string;
      readonly namespace: string;
      readonly key: string;
      readonly blobId: string;
      readonly inlineText: string;
      readonly nextConfig: string;
    }
    const moves: PlannedMove[] = [];
    for (const row of result.rows) {
      if (typeof row.row_id !== "string" || typeof row.tenant !== "string") continue;
      if (typeof row.config !== "string") continue;
      const decoded = decodeJsonOption(row.config);
      if (Option.isNone(decoded) || !isRecord(decoded.value)) continue;
      const inline = decoded.value[options.inlineField];
      if (typeof inline !== "string") continue;

      const hash = yield* sha256Hex(inline);
      const namespace = `o:${row.tenant}/${options.pluginId}`;
      const key = `${options.blobKeyPrefix}/${hash}`;
      const { [options.inlineField]: _removed, ...rest } = decoded.value;
      moves.push({
        rowId: row.row_id,
        namespace,
        key,
        blobId: JSON.stringify([namespace, key]),
        inlineText: inline,
        nextConfig: JSON.stringify({ ...rest, [options.hashField]: hash }),
      });
    }
    if (moves.length === 0) return 0;

    const applyAll = Effect.gen(function* () {
      for (const move of moves) {
        const existing = yield* execute({
          sql: "SELECT row_id FROM blob WHERE id = ?",
          args: [move.blobId],
        });
        if (existing.rows.length === 0) {
          yield* execute({
            sql: "INSERT INTO blob (namespace, key, value, row_id, id) VALUES (?, ?, ?, ?, ?)",
            args: [move.namespace, move.key, move.inlineText, crypto.randomUUID(), move.blobId],
          });
        } else {
          yield* execute({
            sql: "UPDATE blob SET value = ? WHERE id = ?",
            args: [move.inlineText, move.blobId],
          });
        }
        yield* execute({
          sql: "UPDATE integration SET config = ? WHERE row_id = ?",
          args: [move.nextConfig, move.rowId],
        });
      }
      yield* execute("COMMIT");
    });

    yield* execute("BEGIN");
    yield* applyAll.pipe(Effect.tapError(() => execute("ROLLBACK").pipe(Effect.ignore)));
    return moves.length;
  });
