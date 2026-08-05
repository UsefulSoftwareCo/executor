import { Effect } from "effect";
import { DataMigrationError, type SqliteDataMigrationClient } from "@executor-js/sdk/core";

const MIGRATION_NAME = "2026-08-05-microsoft-openapi-ownership";

/**
 * Microsoft integrations created after the provider-service split can retain
 * the retired `microsoft` owner when an older host and a newer migration
 * ledger overlap. The default `microsoft` monolith still belongs to the broad
 * service-split migration; already-scoped integrations keep their slug and are
 * adopted in place by OpenAPI.
 */
export const microsoftOpenApiOwnershipCandidate = (alias?: string): string => {
  const column = (name: string) => (alias ? `${alias}.${name}` : name);
  return `${column("plugin_id")} = 'microsoft'
    AND ${column("slug")} <> 'microsoft'
    AND ${column("config")} IS NOT NULL
    AND json_valid(${column("config")})
    AND json_type(${column("config")}, '$.microsoftGraphPresetIds') = 'array'
    AND json_type(${column("config")}, '$.authenticationTemplate') = 'array'
    AND json_extract(${column("config")}, '$.specHash') IS NOT NULL
    AND json_extract(${column("config")}, '$.specHash') <> ''`;
};

const execute = (
  client: SqliteDataMigrationClient,
  stmt: string | { readonly sql: string; readonly args: readonly unknown[] },
) =>
  Effect.tryPromise({
    try: () => client.execute(stmt),
    catch: (cause) => new DataMigrationError({ migration: MIGRATION_NAME, cause }),
  });

const migrationFailure = (message: string): DataMigrationError =>
  new DataMigrationError({ migration: MIGRATION_NAME, cause: message });

export interface MicrosoftOpenApiOwnershipMigrationOptions {
  /** Cloudflare stores specs in R2 and verifies/copies them before this D1 step. */
  readonly blobBackend?: "database" | "external";
}

export const runSqliteMicrosoftOpenApiOwnershipMigration = (
  client: SqliteDataMigrationClient,
  options: MicrosoftOpenApiOwnershipMigrationOptions = {},
): Effect.Effect<number, DataMigrationError> =>
  Effect.gen(function* () {
    const exists = yield* execute(
      client,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'integration'",
    );
    if (exists.rows.length === 0) return 0;

    const count = yield* execute(
      client,
      `SELECT COUNT(*) AS count FROM integration WHERE ${microsoftOpenApiOwnershipCandidate()}`,
    );
    const moved = Number(count.rows[0]?.count ?? 0);
    if (moved === 0) return 0;

    if ((options.blobBackend ?? "database") === "database") {
      const missingBlobs = yield* execute(
        client,
        `SELECT COUNT(*) AS count
         FROM integration m
         WHERE ${microsoftOpenApiOwnershipCandidate("m")}
           AND (
             NOT EXISTS (
               SELECT 1 FROM blob b
               WHERE b.namespace = 'o:' || m.tenant || '/microsoft'
                 AND b.key = 'spec/' || json_extract(m.config, '$.specHash')
             )
             OR NOT EXISTS (
               SELECT 1 FROM blob b
               WHERE b.namespace = 'o:' || m.tenant || '/microsoft'
                 AND b.key = 'defs/' || json_extract(m.config, '$.specHash')
             )
           )`,
      );
      if (Number(missingBlobs.rows[0]?.count ?? 0) > 0) {
        return yield* migrationFailure(
          "Microsoft OpenAPI ownership source spec/defs blobs are incomplete",
        );
      }
    }

    const conflictingOperations = yield* execute(
      client,
      `SELECT COUNT(*) AS count
       FROM plugin_storage source
       JOIN integration m
         ON m.tenant = source.tenant
       JOIN plugin_storage target
         ON target.tenant = source.tenant
        AND target.owner = source.owner
        AND target.subject = source.subject
        AND target.plugin_id = 'openapi'
        AND target.collection = source.collection
        AND target.key = source.key
       WHERE source.plugin_id = 'microsoft'
         AND source.collection = 'operation'
         AND ${microsoftOpenApiOwnershipCandidate("m")}
         AND json_extract(source.data, '$.integration') = m.slug
         AND target.data <> source.data`,
    );
    if (Number(conflictingOperations.rows[0]?.count ?? 0) > 0) {
      return yield* migrationFailure(
        "Microsoft OpenAPI ownership found conflicting target operation rows",
      );
    }

    const applyAll = Effect.gen(function* () {
      if ((options.blobBackend ?? "database") === "database") {
        yield* execute(
          client,
          `INSERT OR IGNORE INTO blob (namespace, key, value, row_id, id)
           SELECT
             'o:' || m.tenant || '/openapi',
             b.key,
             b.value,
             lower(hex(randomblob(16))),
             json_array('o:' || m.tenant || '/openapi', b.key)
           FROM integration m
           JOIN blob b
             ON b.namespace = 'o:' || m.tenant || '/microsoft'
            AND b.key IN (
              'spec/' || json_extract(m.config, '$.specHash'),
              'defs/' || json_extract(m.config, '$.specHash')
            )
           WHERE ${microsoftOpenApiOwnershipCandidate("m")}`,
        );
      }

      yield* execute(
        client,
        `INSERT OR IGNORE INTO plugin_storage
           (tenant, owner, subject, plugin_id, collection, key, data, created_at, updated_at, row_id)
         SELECT
           source.tenant,
           source.owner,
           source.subject,
           'openapi',
           source.collection,
           source.key,
           source.data,
           source.created_at,
           source.updated_at,
           lower(hex(randomblob(16)))
         FROM plugin_storage source
         JOIN integration m
           ON m.tenant = source.tenant
         WHERE source.plugin_id = 'microsoft'
           AND source.collection = 'operation'
           AND ${microsoftOpenApiOwnershipCandidate("m")}
           AND json_extract(source.data, '$.integration') = m.slug`,
      );

      yield* execute(
        client,
        `DELETE FROM plugin_storage
         WHERE plugin_id = 'microsoft'
           AND collection = 'operation'
           AND EXISTS (
             SELECT 1
             FROM integration m
             WHERE m.tenant = plugin_storage.tenant
               AND ${microsoftOpenApiOwnershipCandidate("m")}
               AND json_extract(plugin_storage.data, '$.integration') = m.slug
           )`,
      );

      for (const table of ["tool", "definition"] as const) {
        yield* execute(
          client,
          `UPDATE ${table}
           SET plugin_id = 'openapi'
           WHERE plugin_id = 'microsoft'
             AND EXISTS (
               SELECT 1
               FROM integration m
               WHERE m.tenant = ${table}.tenant
                 AND m.slug = ${table}.integration
                 AND ${microsoftOpenApiOwnershipCandidate("m")}
             )`,
        );
      }

      yield* execute(
        client,
        `UPDATE integration
         SET plugin_id = 'openapi'
         WHERE ${microsoftOpenApiOwnershipCandidate()}`,
      );

      yield* execute(client, "COMMIT");
      return moved;
    });

    yield* execute(client, "BEGIN");
    return yield* applyAll.pipe(
      Effect.tapError(() => execute(client, "ROLLBACK").pipe(Effect.ignore)),
    );
  });

export const microsoftOpenApiOwnershipDataMigration = {
  name: MIGRATION_NAME,
  run: (client: SqliteDataMigrationClient) =>
    runSqliteMicrosoftOpenApiOwnershipMigration(client).pipe(Effect.asVoid),
};
