import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

import { collectTables, type SqliteDataMigrationClient } from "@executor-js/sdk";
import { createSqliteTestFumaDb } from "@executor-js/sdk/testing";

import { runCloudflareDataMigrations } from "./data-migrations";

const now = 1_780_000_000_000;

const makeFakeD1 = (client: SqliteDataMigrationClient): D1Database => {
  const prepare = (sql: string) => {
    const statement = (args: readonly unknown[]): Record<string, unknown> => ({
      bind: (...values: readonly unknown[]) => statement([...args, ...values]),
      all: async () => {
        const result = await client.execute({ sql, args });
        return { success: true, meta: {}, results: result.rows };
      },
      run: async () => {
        await client.execute({ sql, args });
        return { success: true, meta: {}, results: [] };
      },
    });
    return statement([]);
  };

  // oxlint-disable-next-line executor/no-double-cast -- test double: only the D1 methods used by the migration runner are implemented
  return {
    prepare,
    withSession: () => ({ prepare }),
  } as unknown as D1Database;
};

const makeFakeR2 = (): {
  readonly bucket: R2Bucket;
  readonly objects: Map<string, string>;
} => {
  const objects = new Map<string, string>();
  // oxlint-disable-next-line executor/no-double-cast -- test double: only the R2 methods used by the migration are implemented
  const bucket = {
    get: async (key: string) => {
      const value = objects.get(key);
      return value === undefined ? null : { text: async () => value };
    },
    put: async (key: string, value: string) => {
      objects.set(key, value);
    },
    head: async (key: string) => (objects.has(key) ? {} : null),
  } as unknown as R2Bucket;
  return { bucket, objects };
};

const insertIntegration = (
  client: SqliteDataMigrationClient,
  row: {
    readonly rowId: string;
    readonly tenant: string;
    readonly slug: string;
    readonly pluginId: string;
    readonly config: unknown;
  },
) =>
  client.execute({
    sql: `INSERT INTO integration
      (row_id, tenant, slug, plugin_id, name, description, config, can_remove, can_refresh, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
    args: [
      row.rowId,
      row.tenant,
      row.slug,
      row.pluginId,
      row.slug,
      row.slug,
      JSON.stringify(row.config),
      now,
      now,
    ],
  });

const insertIntegrationRawConfig = (
  client: SqliteDataMigrationClient,
  row: {
    readonly rowId: string;
    readonly tenant: string;
    readonly slug: string;
    readonly pluginId: string;
    readonly config: string;
  },
) =>
  client.execute({
    sql: `INSERT INTO integration
      (row_id, tenant, slug, plugin_id, name, description, config, can_remove, can_refresh, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
    args: [row.rowId, row.tenant, row.slug, row.pluginId, row.slug, row.slug, row.config, now, now],
  });

const insertOperationStorage = (
  client: SqliteDataMigrationClient,
  row: {
    readonly tenant: string;
    readonly pluginId: string;
    readonly integration: string;
  },
) =>
  client.execute({
    sql: `INSERT INTO plugin_storage
      (tenant, owner, subject, plugin_id, collection, key, data, created_at, updated_at, row_id)
      VALUES (?, 'org', '', ?, 'operation', ?, ?, ?, ?, ?)`,
    args: [
      row.tenant,
      row.pluginId,
      `${row.integration}.items.list`,
      JSON.stringify({
        integration: row.integration,
        toolName: "items.list",
        binding: { method: "get", pathTemplate: "/items" },
      }),
      now,
      now,
      `storage-${row.pluginId}-${row.integration}`,
    ],
  });

describe("runCloudflareDataMigrations", () => {
  it.effect("rebuilds legacy connection tables from item_id to item_ids", () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() }));
      const { bucket } = makeFakeR2();

      yield* Effect.promise(() => db.client.execute("DROP TABLE connection"));
      yield* Effect.promise(() =>
        db.client.execute(`
          CREATE TABLE connection (
            integration text NOT NULL,
            name text NOT NULL,
            template text NOT NULL,
            provider text NOT NULL,
            item_id text NOT NULL,
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
          )
        `),
      );
      yield* Effect.promise(() =>
        db.client.execute({
          sql: `INSERT INTO connection
            (integration, name, template, provider, item_id, created_at, updated_at, row_id, tenant, owner, subject)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            "legacy",
            "main",
            "apiKey",
            "encrypted",
            "legacy-item",
            now,
            now,
            "legacy-connection-row",
            "default",
            "org",
            "",
          ],
        }),
      );

      const d1 = makeFakeD1(db.client);
      expect(yield* Effect.promise(() => runCloudflareDataMigrations(d1, bucket))).toContain(
        "2026-06-20-google-openapi-ownership",
      );

      const columns = yield* Effect.promise(() =>
        db.client.execute("PRAGMA table_info('connection')"),
      );
      expect(columns.rows.map((row) => row.name)).toContain("item_ids");
      expect(columns.rows.map((row) => row.name)).not.toContain("item_id");

      yield* Effect.promise(() =>
        db.client.execute({
          sql: `INSERT INTO connection
            (integration, name, template, provider, item_ids, created_at, updated_at, row_id, tenant, owner, subject)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            "probe",
            "selected",
            "apiKey",
            "encrypted",
            JSON.stringify({ token: "item" }),
            now,
            now,
            "connection-row",
            "default",
            "org",
            "",
          ],
        }),
      );

      const rows = yield* Effect.promise(() =>
        db.client.execute("SELECT name, item_ids FROM connection ORDER BY name"),
      );
      expect(rows.rows).toEqual([
        { name: "main", item_ids: JSON.stringify({ token: "legacy-item" }) },
        { name: "selected", item_ids: JSON.stringify({ token: "item" }) },
      ]);

      yield* Effect.promise(() => db.close());
    }),
  );

  it.effect("clears malformed legacy OpenAPI integration config rows", () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() }));
      const { bucket } = makeFakeR2();

      yield* Effect.promise(() =>
        insertIntegrationRawConfig(db.client, {
          rowId: "malformed-row",
          tenant: "org_1",
          slug: "broken",
          pluginId: "openapi",
          config: "",
        }),
      );

      const d1 = makeFakeD1(db.client);
      expect(yield* Effect.promise(() => runCloudflareDataMigrations(d1, bucket))).toEqual([
        "2026-06-20-google-openapi-ownership",
      ]);
      expect(yield* Effect.promise(() => runCloudflareDataMigrations(d1, bucket))).toEqual([]);

      const integrations = yield* Effect.promise(() =>
        db.client.execute("SELECT slug, plugin_id, config FROM integration"),
      );
      expect(integrations.rows).toEqual([{ slug: "broken", plugin_id: "openapi", config: null }]);

      yield* Effect.promise(() => db.close());
    }),
  );

  it.effect("moves Google OpenAPI ownership and copies the R2 spec object", () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() }));
      const { bucket, objects } = makeFakeR2();

      yield* Effect.promise(() =>
        insertIntegration(db.client, {
          rowId: "google-row",
          tenant: "org_1",
          slug: "google",
          pluginId: "openapi",
          config: {
            specHash: "googlehash",
            googleDiscoveryUrls: ["https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest"],
          },
        }),
      );
      yield* Effect.promise(() =>
        insertOperationStorage(db.client, {
          tenant: "org_1",
          pluginId: "openapi",
          integration: "google",
        }),
      );
      objects.set("o:org_1/openapi/spec/googlehash", "google spec");

      const d1 = makeFakeD1(db.client);
      expect(yield* Effect.promise(() => runCloudflareDataMigrations(d1, bucket))).toEqual([
        "2026-06-20-google-openapi-ownership",
      ]);
      expect(yield* Effect.promise(() => runCloudflareDataMigrations(d1, bucket))).toEqual([]);

      expect(objects.get("o:org_1/google/spec/googlehash")).toBe("google spec");

      const integrations = yield* Effect.promise(() =>
        db.client.execute("SELECT slug, plugin_id FROM integration ORDER BY slug"),
      );
      expect(integrations.rows).toEqual([{ slug: "google", plugin_id: "google" }]);

      const storage = yield* Effect.promise(() =>
        db.client.execute("SELECT plugin_id, key FROM plugin_storage ORDER BY plugin_id, key"),
      );
      expect(storage.rows).toEqual([{ plugin_id: "google", key: "google.items.list" }]);

      yield* Effect.promise(() => db.close());
    }),
  );
});
