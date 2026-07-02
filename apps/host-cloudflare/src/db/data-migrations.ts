import { Effect } from "effect";
import type { D1Database, D1DatabaseSession, R2Bucket } from "@cloudflare/workers-types";

import {
  DataMigrationError,
  runSqliteDataMigrations,
  type SqliteDataMigration,
  type SqliteDataMigrationClient,
} from "@executor-js/sdk";
import { googleOpenApiOwnershipDataMigration } from "@executor-js/plugin-google";

const TX_CONTROL = new Set(["BEGIN", "BEGIN TRANSACTION", "COMMIT", "ROLLBACK"]);

const firstWord = (sql: string): string => sql.trimStart().split(/\s+/, 1)[0]?.toUpperCase() ?? "";

const queryRows = <T extends Record<string, unknown>>(
  session: D1DatabaseSession,
  stmt: string | { readonly sql: string; readonly args: readonly unknown[] },
): Promise<readonly T[]> => {
  const sql = typeof stmt === "string" ? stmt : stmt.sql;
  const args = typeof stmt === "string" ? [] : stmt.args;
  const prepared = session.prepare(sql).bind(...args);
  if (firstWord(sql) === "SELECT" || firstWord(sql) === "PRAGMA") {
    return prepared.all<T>().then((result) => result.results);
  }
  return prepared.run<T>().then(() => []);
};

export const d1DataMigrationClient = (db: D1Database): SqliteDataMigrationClient => {
  const session = db.withSession("first-primary");
  return {
    execute: (stmt) => {
      const sql =
        typeof stmt === "string" ? stmt.trim().toUpperCase() : stmt.sql.trim().toUpperCase();
      if (TX_CONTROL.has(sql)) return Promise.resolve({ rows: [] });
      return queryRows(session, stmt).then((rows) => ({ rows }));
    },
  };
};

const tableColumns = async (db: D1Database, table: string): Promise<ReadonlySet<string>> => {
  const session = db.withSession("first-primary");
  const result = await session.prepare(`PRAGMA table_info('${table}')`).all<{
    readonly name?: unknown;
  }>();
  return new Set(
    result.results
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string"),
  );
};

const rebuildLegacyConnectionTable = async (db: D1Database): Promise<void> => {
  const statements = [
    `DROP TABLE IF EXISTS connection_next`,
    `DROP TABLE IF EXISTS connection_legacy_item_id`,
    `CREATE TABLE connection_next (
      integration text NOT NULL,
      name text NOT NULL,
      template text NOT NULL,
      provider text NOT NULL,
      item_ids json NOT NULL,
      identity_label text,
      description text,
      tools_synced_at integer,
      oauth_client text,
      oauth_client_owner text,
      refresh_item_id text,
      expires_at integer,
      oauth_scope text,
      oauth_token_url text,
      provider_state text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      row_id text PRIMARY KEY NOT NULL,
      tenant text NOT NULL,
      owner text NOT NULL,
      subject text NOT NULL
    )`,
    `INSERT INTO connection_next
      (integration, name, template, provider, item_ids, identity_label,
       description, tools_synced_at, oauth_client, oauth_client_owner,
       refresh_item_id, expires_at, oauth_scope, oauth_token_url,
       provider_state, created_at, updated_at, row_id, tenant, owner, subject)
     SELECT integration, name, template, provider,
       CASE
         WHEN item_ids IS NOT NULL AND item_ids <> '{}' THEN item_ids
         ELSE json_object('token', item_id)
       END,
       identity_label, description, tools_synced_at, oauth_client,
       oauth_client_owner, refresh_item_id, expires_at, oauth_scope,
       oauth_token_url, provider_state, created_at, updated_at, row_id,
       tenant, owner, subject
     FROM connection`,
    `ALTER TABLE connection RENAME TO connection_legacy_item_id`,
    `ALTER TABLE connection_next RENAME TO connection`,
    `DROP TABLE connection_legacy_item_id`,
  ];
  for (const statement of statements) {
    await db.prepare(statement).run();
  }
};

export const ensureCloudflareD1SchemaCompatibility = async (db: D1Database): Promise<void> => {
  const integrationColumns = await tableColumns(db, "integration");
  if (integrationColumns.has("config")) {
    await db
      .prepare(
        `UPDATE integration
         SET config = NULL
         WHERE config IS NOT NULL
           AND NOT json_valid(config)`,
      )
      .run();
  }

  const connectionColumns = await tableColumns(db, "connection");
  if (connectionColumns.size === 0) return;
  if (!connectionColumns.has("item_ids")) {
    await db.prepare(`ALTER TABLE connection ADD COLUMN item_ids json NOT NULL DEFAULT '{}'`).run();
  }
  const updatedConnectionColumns = await tableColumns(db, "connection");
  if (updatedConnectionColumns.has("item_id")) {
    await rebuildLegacyConnectionTable(db);
  }
};

const r2ObjectName = (tenant: string, pluginId: string, key: string): string =>
  `o:${tenant}/${pluginId}/${key}`;

const copyGoogleOpenApiSpecBlobsToR2 = (
  client: SqliteDataMigrationClient,
  bucket: R2Bucket,
): Effect.Effect<void, DataMigrationError> =>
  Effect.tryPromise({
    try: async () => {
      const result = await client.execute(
        `SELECT tenant, json_extract(config, '$.specHash') AS spec_hash
         FROM integration
         WHERE plugin_id = 'openapi'
           AND config IS NOT NULL
           AND json_valid(config)
           AND json_type(config, '$.googleDiscoveryUrls') = 'array'
           AND json_extract(config, '$.specHash') IS NOT NULL
           AND json_extract(config, '$.specHash') <> ''`,
      );
      for (const row of result.rows) {
        if (typeof row.tenant !== "string" || typeof row.spec_hash !== "string") continue;
        const key = `spec/${row.spec_hash}`;
        const target = r2ObjectName(row.tenant, "google", key);
        if ((await bucket.head(target)) != null) continue;
        const source = await bucket.get(r2ObjectName(row.tenant, "openapi", key));
        if (source == null) continue;
        await bucket.put(target, await source.text());
      }
    },
    catch: (cause) =>
      new DataMigrationError({
        migration: googleOpenApiOwnershipDataMigration.name,
        cause,
      }),
  });

const cloudflareDataMigrations = (bucket: R2Bucket | undefined): readonly SqliteDataMigration[] => [
  {
    name: googleOpenApiOwnershipDataMigration.name,
    run: (client) =>
      Effect.gen(function* () {
        if (bucket) yield* copyGoogleOpenApiSpecBlobsToR2(client, bucket);
        yield* googleOpenApiOwnershipDataMigration.run(client);
      }),
  },
];

export const runCloudflareDataMigrations = (
  db: D1Database,
  bucket: R2Bucket | undefined,
): Promise<readonly string[]> =>
  Effect.runPromise(
    Effect.promise(() => ensureCloudflareD1SchemaCompatibility(db)).pipe(
      Effect.flatMap(() =>
        runSqliteDataMigrations(d1DataMigrationClient(db), cloudflareDataMigrations(bucket)),
      ),
    ),
  );
