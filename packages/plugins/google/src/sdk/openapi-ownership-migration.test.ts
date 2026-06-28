import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { collectTables } from "@executor-js/sdk";
import { createSqliteTestFumaDb } from "@executor-js/sdk/testing";
import type { SqliteDataMigrationClient } from "@executor-js/sdk/core";

import { runSqliteGoogleOpenApiOwnershipMigration } from "./openapi-ownership-migration";

const now = 1_780_000_000_000;

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

const insertBlob = (
  client: SqliteDataMigrationClient,
  row: {
    readonly namespace: string;
    readonly key: string;
    readonly value: string;
  },
) =>
  client.execute({
    sql: "INSERT INTO blob (namespace, key, value, row_id, id) VALUES (?, ?, ?, ?, ?)",
    args: [
      row.namespace,
      row.key,
      row.value,
      `blob-${row.namespace}-${row.key}`,
      JSON.stringify([row.namespace, row.key]),
    ],
  });

const insertOperationStorage = (
  client: SqliteDataMigrationClient,
  row: {
    readonly tenant: string;
    readonly pluginId: string;
    readonly integration: string;
    readonly toolName: string;
  },
) =>
  client.execute({
    sql: `INSERT INTO plugin_storage
      (tenant, owner, subject, plugin_id, collection, key, data, created_at, updated_at, row_id)
      VALUES (?, 'org', '', ?, 'operation', ?, ?, ?, ?, ?)`,
    args: [
      row.tenant,
      row.pluginId,
      `${row.integration}.${row.toolName}`,
      JSON.stringify({
        integration: row.integration,
        toolName: row.toolName,
        binding: { method: "get", pathTemplate: "/items" },
      }),
      now,
      now,
      `storage-${row.pluginId}-${row.integration}-${row.toolName}`,
    ],
  });

const insertTool = (
  client: SqliteDataMigrationClient,
  row: {
    readonly tenant: string;
    readonly pluginId: string;
    readonly integration: string;
  },
) =>
  client.execute({
    sql: `INSERT INTO tool
      (tenant, owner, subject, integration, connection, plugin_id, name, description, input_schema, output_schema, annotations, created_at, updated_at, row_id)
      VALUES (?, 'org', '', ?, 'default', ?, 'items.list', 'List items', NULL, NULL, NULL, ?, ?, ?)`,
    args: [row.tenant, row.integration, row.pluginId, now, now, `tool-${row.integration}`],
  });

const insertDefinition = (
  client: SqliteDataMigrationClient,
  row: {
    readonly tenant: string;
    readonly pluginId: string;
    readonly integration: string;
  },
) =>
  client.execute({
    sql: `INSERT INTO definition
      (tenant, owner, subject, integration, connection, plugin_id, name, schema, created_at, row_id)
      VALUES (?, 'org', '', ?, 'default', ?, 'Item', '{}', ?, ?)`,
    args: [row.tenant, row.integration, row.pluginId, now, `definition-${row.integration}`],
  });

describe("runSqliteGoogleOpenApiOwnershipMigration", () => {
  it.effect("skips malformed legacy integration config rows", () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() }));

      yield* Effect.promise(() =>
        insertIntegrationRawConfig(db.client, {
          rowId: "malformed-row",
          tenant: "org_1",
          slug: "broken",
          pluginId: "openapi",
          config: "",
        }),
      );

      expect(yield* runSqliteGoogleOpenApiOwnershipMigration(db.client)).toBe(0);

      const integrations = yield* Effect.promise(() =>
        db.client.execute("SELECT slug, plugin_id, config FROM integration"),
      );
      expect(integrations.rows).toEqual([{ slug: "broken", plugin_id: "openapi", config: "" }]);

      yield* Effect.promise(() => db.close());
    }),
  );

  it.effect("moves OpenAPI-owned Google bundle rows to the Google plugin", () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() }));
      const client = db.client;

      yield* Effect.promise(() =>
        insertIntegration(client, {
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
        insertIntegration(client, {
          rowId: "stripe-row",
          tenant: "org_1",
          slug: "stripe",
          pluginId: "openapi",
          config: {
            specHash: "stripehash",
            sourceUrl: "https://stripe.example/openapi.json",
          },
        }),
      );
      yield* Effect.promise(() =>
        insertBlob(client, {
          namespace: "o:org_1/openapi",
          key: "spec/googlehash",
          value: "google spec",
        }),
      );
      yield* Effect.promise(() =>
        insertBlob(client, {
          namespace: "o:org_1/openapi",
          key: "spec/stripehash",
          value: "stripe spec",
        }),
      );

      for (const integration of ["google", "stripe"] as const) {
        yield* Effect.promise(() =>
          insertOperationStorage(client, {
            tenant: "org_1",
            pluginId: "openapi",
            integration,
            toolName: "items.list",
          }),
        );
        yield* Effect.promise(() =>
          insertTool(client, {
            tenant: "org_1",
            pluginId: "openapi",
            integration,
          }),
        );
        yield* Effect.promise(() =>
          insertDefinition(client, {
            tenant: "org_1",
            pluginId: "openapi",
            integration,
          }),
        );
      }

      expect(yield* runSqliteGoogleOpenApiOwnershipMigration(client)).toBe(1);
      expect(yield* runSqliteGoogleOpenApiOwnershipMigration(client)).toBe(0);

      const integrations = yield* Effect.promise(() =>
        client.execute("SELECT slug, plugin_id FROM integration ORDER BY slug"),
      );
      expect(integrations.rows).toEqual([
        { slug: "google", plugin_id: "google" },
        { slug: "stripe", plugin_id: "openapi" },
      ]);

      const googleBlob = yield* Effect.promise(() =>
        client.execute({
          sql: "SELECT value FROM blob WHERE id = ?",
          args: [JSON.stringify(["o:org_1/google", "spec/googlehash"])],
        }),
      );
      expect(googleBlob.rows).toEqual([{ value: "google spec" }]);

      const openApiBlobs = yield* Effect.promise(() =>
        client.execute("SELECT key FROM blob WHERE namespace = 'o:org_1/openapi' ORDER BY key"),
      );
      expect(openApiBlobs.rows).toEqual([{ key: "spec/googlehash" }, { key: "spec/stripehash" }]);

      const storage = yield* Effect.promise(() =>
        client.execute(
          "SELECT plugin_id, key FROM plugin_storage WHERE collection = 'operation' ORDER BY plugin_id, key",
        ),
      );
      expect(storage.rows).toEqual([
        { plugin_id: "google", key: "google.items.list" },
        { plugin_id: "openapi", key: "stripe.items.list" },
      ]);

      const tools = yield* Effect.promise(() =>
        client.execute("SELECT integration, plugin_id FROM tool ORDER BY integration"),
      );
      expect(tools.rows).toEqual([
        { integration: "google", plugin_id: "google" },
        { integration: "stripe", plugin_id: "openapi" },
      ]);

      const definitions = yield* Effect.promise(() =>
        client.execute("SELECT integration, plugin_id FROM definition ORDER BY integration"),
      );
      expect(definitions.rows).toEqual([
        { integration: "google", plugin_id: "google" },
        { integration: "stripe", plugin_id: "openapi" },
      ]);

      yield* Effect.promise(() => db.close());
    }),
  );
});
