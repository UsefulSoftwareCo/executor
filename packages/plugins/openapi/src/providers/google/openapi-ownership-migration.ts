import { Effect } from "effect";
import { DataMigrationError, type SqliteDataMigrationClient } from "@executor-js/sdk/core";

const MIGRATION_NAME = "2026-06-20-google-openapi-ownership";
const googleOpenApiCandidate = (alias?: string): string => {
  const column = (name: string) => (alias ? `${alias}.${name}` : name);
  return `${column("plugin_id")} = 'openapi' AND ${column("config")} IS NOT NULL AND json_valid(${column("config")}) AND json_type(${column("config")}, '$.googleDiscoveryUrls') = 'array'`;
};

const execute = (
  client: SqliteDataMigrationClient,
  stmt: string | { readonly sql: string; readonly args: readonly unknown[] },
) =>
  Effect.tryPromise({
    try: () => client.execute(stmt),
    catch: (cause) => new DataMigrationError({ migration: MIGRATION_NAME, cause }),
  });

export const runSqliteGoogleOpenApiOwnershipMigration = (
  client: SqliteDataMigrationClient,
): Effect.Effect<number, DataMigrationError> =>
  Effect.gen(function* () {
    const exists = yield* execute(
      client,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'integration'",
    );
    if (exists.rows.length === 0) return 0;

    const count = yield* execute(
      client,
      `SELECT COUNT(*) AS count FROM integration WHERE ${googleOpenApiCandidate()}`,
    );
    const moved = Number(count.rows[0]?.count ?? 0);
    if (moved === 0) return 0;

    const applyAll = Effect.gen(function* () {
      yield* execute(
        client,
        `INSERT OR IGNORE INTO blob (namespace, key, value, row_id, id)
         SELECT
           'o:' || g.tenant || '/google',
           b.key,
           b.value,
           lower(hex(randomblob(16))),
           json_array('o:' || g.tenant || '/google', b.key)
         FROM integration g
         JOIN blob b
           ON b.namespace = 'o:' || g.tenant || '/openapi'
          AND b.key = 'spec/' || json_extract(g.config, '$.specHash')
         WHERE ${googleOpenApiCandidate("g")}
           AND json_extract(g.config, '$.specHash') IS NOT NULL
           AND json_extract(g.config, '$.specHash') <> ''`,
      );

      yield* execute(
        client,
        `INSERT OR IGNORE INTO plugin_storage
           (tenant, owner, subject, plugin_id, collection, key, data, created_at, updated_at, row_id)
         SELECT
           ps.tenant,
           ps.owner,
           ps.subject,
           'google',
           ps.collection,
           ps.key,
           ps.data,
           ps.created_at,
           ps.updated_at,
           lower(hex(randomblob(16)))
         FROM plugin_storage ps
         JOIN integration g
           ON g.tenant = ps.tenant
         WHERE ps.plugin_id = 'openapi'
           AND ${googleOpenApiCandidate("g")}
           AND ps.collection = 'operation'
           AND (
             json_extract(ps.data, '$.integration') = g.slug
             OR ps.key LIKE g.slug || '.%'
           )`,
      );

      yield* execute(
        client,
        `DELETE FROM plugin_storage
         WHERE plugin_id = 'openapi'
           AND collection = 'operation'
           AND EXISTS (
             SELECT 1
             FROM integration g
             WHERE g.tenant = plugin_storage.tenant
               AND ${googleOpenApiCandidate("g")}
               AND (
                 json_extract(plugin_storage.data, '$.integration') = g.slug
                 OR plugin_storage.key LIKE g.slug || '.%'
               )
           )`,
      );

      yield* execute(
        client,
        `UPDATE tool
         SET plugin_id = 'google'
         WHERE plugin_id = 'openapi'
           AND EXISTS (
             SELECT 1
             FROM integration g
             WHERE g.tenant = tool.tenant
               AND ${googleOpenApiCandidate("g")}
               AND g.slug = tool.integration
           )`,
      );

      yield* execute(
        client,
        `UPDATE definition
         SET plugin_id = 'google'
         WHERE plugin_id = 'openapi'
           AND EXISTS (
             SELECT 1
             FROM integration g
             WHERE g.tenant = definition.tenant
               AND ${googleOpenApiCandidate("g")}
               AND g.slug = definition.integration
           )`,
      );

      yield* execute(
        client,
        `UPDATE integration
         SET plugin_id = 'google'
         WHERE ${googleOpenApiCandidate()}`,
      );

      yield* execute(client, "COMMIT");
      return moved;
    });

    yield* execute(client, "BEGIN");
    return yield* applyAll.pipe(
      Effect.tapError(() => execute(client, "ROLLBACK").pipe(Effect.ignore)),
    );
  });

export const googleOpenApiOwnershipDataMigration = {
  name: MIGRATION_NAME,
  run: (client: SqliteDataMigrationClient) =>
    runSqliteGoogleOpenApiOwnershipMigration(client).pipe(Effect.asVoid),
};
