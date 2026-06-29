import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { collectTables } from "./executor";
import { createSqliteTestFumaDb } from "./sqlite-test-db";
import { runSqliteConfigBlobMigration } from "./sqlite-config-blob-migration";
import { runSqliteDataMigrations, type SqliteDataMigrationClient } from "./sqlite-data-migrations";

const OPENAPI_OPTIONS = {
  migrationName: "test-spec-to-blob",
  pluginId: "openapi",
  inlineField: "spec",
  hashField: "specHash",
  blobKeyPrefix: "spec",
} as const;

const decodeConfigJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const insertIntegration = async (
  client: SqliteDataMigrationClient,
  row: { rowId: string; tenant: string; slug: string; pluginId: string; config: unknown },
) => {
  await client.execute({
    sql: `INSERT INTO integration (row_id, tenant, slug, plugin_id, description, config, can_remove, can_refresh, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    args: [
      row.rowId,
      row.tenant,
      row.slug,
      row.pluginId,
      row.slug,
      JSON.stringify(row.config),
      Date.now(),
      Date.now(),
    ],
  });
};

describe("runSqliteConfigBlobMigration", () => {
  it.effect("moves inline spec text to a blob row and rewrites the config pointer", () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() }));
      const spec = JSON.stringify({ openapi: "3.0.0", info: { title: "T", version: "1" } });
      yield* Effect.promise(() =>
        insertIntegration(db.client, {
          rowId: "r1",
          tenant: "t1",
          slug: "legacy_api",
          pluginId: "openapi",
          config: { spec, sourceUrl: "https://example.com/spec.json" },
        }),
      );

      const moved = yield* runSqliteConfigBlobMigration(db.client, OPENAPI_OPTIONS);
      expect(moved).toBe(1);

      const integration = yield* Effect.promise(() =>
        db.client.execute("SELECT config FROM integration WHERE row_id = 'r1'"),
      );
      const config = decodeConfigJson(String(integration.rows[0]!.config));
      expect(config.spec).toBeUndefined();
      expect(typeof config.specHash).toBe("string");
      // Untouched fields survive the rewrite.
      expect(config.sourceUrl).toBe("https://example.com/spec.json");

      // The blob row uses the runtime's exact naming: namespace
      // `o:<tenant>/<pluginId>`, key `spec/<hash>`, id JSON.stringify pair.
      const blob = yield* Effect.promise(() =>
        db.client.execute({
          sql: "SELECT namespace, key, value FROM blob WHERE id = ?",
          args: [JSON.stringify([`o:t1/openapi`, `spec/${config.specHash}`])],
        }),
      );
      expect(blob.rows).toHaveLength(1);
      expect(blob.rows[0]!.value).toBe(spec);

      yield* Effect.promise(() => db.close());
    }),
  );

  it.effect("is idempotent and leaves pointer-shaped and foreign rows alone", () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() }));
      yield* Effect.promise(() =>
        insertIntegration(db.client, {
          rowId: "r1",
          tenant: "t1",
          slug: "already_migrated",
          pluginId: "openapi",
          config: { specHash: "abc123" },
        }),
      );
      yield* Effect.promise(() =>
        insertIntegration(db.client, {
          rowId: "r2",
          tenant: "t1",
          slug: "mcp_thing",
          pluginId: "mcp",
          config: { endpoint: "https://mcp.example.com" },
        }),
      );
      yield* Effect.promise(() =>
        insertIntegration(db.client, {
          rowId: "r3",
          tenant: "t1",
          slug: "legacy_api",
          pluginId: "openapi",
          config: { spec: "{}" },
        }),
      );

      expect(yield* runSqliteConfigBlobMigration(db.client, OPENAPI_OPTIONS)).toBe(1);
      // Second run: everything is pointer-shaped now.
      expect(yield* runSqliteConfigBlobMigration(db.client, OPENAPI_OPTIONS)).toBe(0);

      const mcpRow = yield* Effect.promise(() =>
        db.client.execute("SELECT config FROM integration WHERE row_id = 'r2'"),
      );
      expect(decodeConfigJson(String(mcpRow.rows[0]!.config))).toEqual({
        endpoint: "https://mcp.example.com",
      });

      yield* Effect.promise(() => db.close());
    }),
  );

  it.effect("identical specs across integrations share one blob per tenant", () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() }));
      const spec = JSON.stringify({ openapi: "3.0.0", info: { title: "Shared", version: "1" } });
      for (const [rowId, slug] of [
        ["r1", "api_a"],
        ["r2", "api_b"],
      ] as const) {
        yield* Effect.promise(() =>
          insertIntegration(db.client, {
            rowId,
            tenant: "t1",
            slug,
            pluginId: "openapi",
            config: { spec },
          }),
        );
      }

      expect(yield* runSqliteConfigBlobMigration(db.client, OPENAPI_OPTIONS)).toBe(2);
      const blobs = yield* Effect.promise(() => db.client.execute("SELECT id FROM blob"));
      expect(blobs.rows).toHaveLength(1);

      yield* Effect.promise(() => db.close());
    }),
  );

  it.effect("returns 0 when the integration table does not exist yet", () =>
    Effect.gen(function* () {
      // The ledger may run against a brand-new database before any schema
      // bring-up; an absent table is "nothing to migrate", not an error.
      const db = yield* Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() }));
      yield* Effect.promise(() => db.client.execute("DROP TABLE integration"));
      expect(yield* runSqliteConfigBlobMigration(db.client, OPENAPI_OPTIONS)).toBe(0);
      yield* Effect.promise(() => db.close());
    }),
  );

  it.effect("runs once under the ledger and is stamped", () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() }));
      yield* Effect.promise(() =>
        insertIntegration(db.client, {
          rowId: "r1",
          tenant: "t1",
          slug: "legacy_api",
          pluginId: "openapi",
          config: { spec: "{}" },
        }),
      );
      const entry = {
        name: "test-spec-to-blob",
        run: (client: SqliteDataMigrationClient) =>
          runSqliteConfigBlobMigration(client, OPENAPI_OPTIONS).pipe(Effect.asVoid),
      };

      expect(yield* runSqliteDataMigrations(db.client, [entry])).toEqual(["test-spec-to-blob"]);
      // Stamped: the second boot doesn't re-run it.
      expect(yield* runSqliteDataMigrations(db.client, [entry])).toEqual([]);

      yield* Effect.promise(() => db.close());
    }),
  );
});
