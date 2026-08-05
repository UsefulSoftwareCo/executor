import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { collectTables } from "@executor-js/sdk";
import type { SqliteDataMigrationClient } from "@executor-js/sdk/core";
import { createSqliteTestFumaDb } from "@executor-js/sdk/testing";

import { runSqliteMicrosoftOpenApiOwnershipMigration } from "./openapi-ownership-migration";

const now = 1_780_000_000_000;

const insertIntegration = (
  client: SqliteDataMigrationClient,
  row: { readonly slug: string; readonly pluginId: string; readonly config: unknown },
) =>
  client.execute({
    sql: `INSERT INTO integration
      (row_id, tenant, slug, plugin_id, name, description, config, can_remove, can_refresh, created_at, updated_at)
      VALUES (?, 'org_1', ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
    args: [
      `integration-${row.slug}`,
      row.slug,
      row.pluginId,
      row.slug,
      row.slug,
      JSON.stringify(row.config),
      now,
      now,
    ],
  });

const insertBlob = (client: SqliteDataMigrationClient, key: string, value: string) =>
  client.execute({
    sql: "INSERT INTO blob (namespace, key, value, row_id, id) VALUES ('o:org_1/microsoft', ?, ?, ?, ?)",
    args: [key, value, `blob-${key}`, JSON.stringify(["o:org_1/microsoft", key])],
  });

const insertOperation = (client: SqliteDataMigrationClient) =>
  client.execute({
    sql: `INSERT INTO plugin_storage
      (tenant, owner, subject, plugin_id, collection, key, data, created_at, updated_at, row_id)
      VALUES ('org_1', 'org', '', 'microsoft', 'operation', 'op.profile', ?, ?, ?, 'operation-row')`,
    args: [
      JSON.stringify({
        integration: "microsoft_graph",
        toolName: "meUser.meUserGetUser",
        binding: { method: "get", pathTemplate: "/me" },
      }),
      now,
      now,
    ],
  });

const insertToolAndDefinition = (client: SqliteDataMigrationClient) =>
  Effect.promise(async () => {
    await client.execute({
      sql: `INSERT INTO tool
        (tenant, owner, subject, integration, connection, plugin_id, name, description, input_schema, output_schema, annotations, created_at, updated_at, row_id)
        VALUES ('org_1', 'org', '', 'microsoft_graph', 'default', 'microsoft', 'me.get', 'Get me', NULL, NULL, NULL, ?, ?, 'tool-row')`,
      args: [now, now],
    });
    await client.execute({
      sql: `INSERT INTO definition
        (tenant, owner, subject, integration, connection, plugin_id, name, schema, created_at, row_id)
        VALUES ('org_1', 'org', '', 'microsoft_graph', 'default', 'microsoft', 'User', '{}', ?, 'definition-row')`,
      args: [now],
    });
  });

const insertConnection = (client: SqliteDataMigrationClient) =>
  client.execute({
    sql: `INSERT INTO connection
      (tenant, owner, subject, integration, name, template, provider, item_ids, identity_label,
       description, tools_synced_at, oauth_client, oauth_client_owner, refresh_item_id, expires_at,
       oauth_scope, oauth_token_url, provider_state, created_at, updated_at, row_id)
      VALUES ('org_1', 'org', '', 'microsoft_graph', 'default', 'azureAdDelegated', 'encrypted', ?,
       'graph@example.com', 'Graph', ?, 'microsoft-graph', 'org', ?, ?, ?, NULL, ?, ?, ?, 'connection-row')`,
    args: [
      JSON.stringify({ token: "oauth:org:microsoft_graph:default" }),
      now,
      "oauth:org:microsoft_graph:default:refresh",
      now + 3_600_000,
      "Files.Read.All Sites.Read.All User.Read profile openid email",
      JSON.stringify({ durable: true }),
      now,
      now,
    ],
  });

const scopedConfig = {
  specHash: "graph-hash",
  microsoftGraphPresetIds: ["profile"],
  microsoftGraphCustomScopes: ["Files.Read.All", "Sites.Read.All"],
  authenticationTemplate: [
    {
      slug: "azureAdDelegated",
      kind: "oauth2",
      authorizationUrl: "https://login.example/authorize",
      tokenUrl: "https://login.example/token",
      scopes: ["offline_access", "User.Read", "Files.Read.All", "Sites.Read.All"],
    },
  ],
};

describe("runSqliteMicrosoftOpenApiOwnershipMigration", () => {
  it.effect("adopts a scoped Microsoft integration without changing its connection", () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() }));
      const client = db.client;

      yield* Effect.promise(() =>
        insertIntegration(client, {
          slug: "microsoft_graph",
          pluginId: "microsoft",
          config: scopedConfig,
        }),
      );
      yield* Effect.promise(() =>
        insertIntegration(client, {
          slug: "microsoft",
          pluginId: "microsoft",
          config: scopedConfig,
        }),
      );
      yield* Effect.promise(() => insertBlob(client, "spec/graph-hash", "graph spec"));
      yield* Effect.promise(() => insertBlob(client, "defs/graph-hash", "graph defs"));
      yield* Effect.promise(() => insertOperation(client));
      yield* insertToolAndDefinition(client);
      yield* Effect.promise(() => insertConnection(client));

      const connectionBefore = yield* Effect.promise(() =>
        client.execute("SELECT * FROM connection WHERE integration = 'microsoft_graph'"),
      );

      expect(yield* runSqliteMicrosoftOpenApiOwnershipMigration(client)).toBe(1);
      expect(yield* runSqliteMicrosoftOpenApiOwnershipMigration(client)).toBe(0);

      const integrations = yield* Effect.promise(() =>
        client.execute("SELECT slug, plugin_id, config FROM integration ORDER BY slug"),
      );
      expect(integrations.rows).toEqual([
        { slug: "microsoft", plugin_id: "microsoft", config: JSON.stringify(scopedConfig) },
        { slug: "microsoft_graph", plugin_id: "openapi", config: JSON.stringify(scopedConfig) },
      ]);

      const blobs = yield* Effect.promise(() =>
        client.execute("SELECT namespace, key, value FROM blob ORDER BY namespace, key"),
      );
      expect(blobs.rows).toEqual([
        { namespace: "o:org_1/microsoft", key: "defs/graph-hash", value: "graph defs" },
        { namespace: "o:org_1/microsoft", key: "spec/graph-hash", value: "graph spec" },
        { namespace: "o:org_1/openapi", key: "defs/graph-hash", value: "graph defs" },
        { namespace: "o:org_1/openapi", key: "spec/graph-hash", value: "graph spec" },
      ]);

      const ownershipRows = yield* Effect.promise(() =>
        client.execute(
          `SELECT 'operation' AS kind, plugin_id FROM plugin_storage
           UNION ALL SELECT 'tool', plugin_id FROM tool
           UNION ALL SELECT 'definition', plugin_id FROM definition
           ORDER BY kind`,
        ),
      );
      expect(ownershipRows.rows).toEqual([
        { kind: "definition", plugin_id: "openapi" },
        { kind: "operation", plugin_id: "openapi" },
        { kind: "tool", plugin_id: "openapi" },
      ]);

      const connectionAfter = yield* Effect.promise(() =>
        client.execute("SELECT * FROM connection WHERE integration = 'microsoft_graph'"),
      );
      expect(connectionAfter.rows).toEqual(connectionBefore.rows);

      yield* Effect.promise(() => db.close());
    }),
  );

  it.effect("fails closed when a database-backed source blob is missing", () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() }));
      yield* Effect.promise(() =>
        insertIntegration(db.client, {
          slug: "microsoft_graph",
          pluginId: "microsoft",
          config: scopedConfig,
        }),
      );
      yield* Effect.promise(() => insertBlob(db.client, "spec/graph-hash", "graph spec"));

      const error = yield* Effect.flip(runSqliteMicrosoftOpenApiOwnershipMigration(db.client));
      expect(error.migration).toBe("2026-08-05-microsoft-openapi-ownership");

      const rows = yield* Effect.promise(() =>
        db.client.execute("SELECT slug, plugin_id FROM integration"),
      );
      expect(rows.rows).toEqual([{ slug: "microsoft_graph", plugin_id: "microsoft" }]);

      yield* Effect.promise(() => db.close());
    }),
  );
});
