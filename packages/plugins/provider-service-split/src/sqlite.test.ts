import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  collectTables,
  DataMigrationError,
  runSqliteDataMigrations,
  type SqliteDataMigrationClient,
} from "@executor-js/sdk";
import { createSqliteTestFumaDb } from "@executor-js/sdk/testing";

import { operationStorageKey } from "./planner";
import {
  providerServiceSplitDataMigration,
  runSqliteProviderServiceSplitMigration,
} from "./sqlite";

const now = 1_780_000_000_000;
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const insertIntegration = (
  client: SqliteDataMigrationClient,
  row: {
    readonly rowId: string;
    readonly tenant: string;
    readonly slug: string;
    readonly pluginId: string;
    readonly config: unknown;
    readonly healthCheck?: unknown;
  },
) =>
  client.execute({
    sql: `INSERT INTO integration
      (row_id, tenant, slug, plugin_id, name, description, config, health_check,
       can_remove, can_refresh, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
    args: [
      row.rowId,
      row.tenant,
      row.slug,
      row.pluginId,
      row.slug,
      row.slug,
      JSON.stringify(row.config),
      row.healthCheck ? JSON.stringify(row.healthCheck) : null,
      now,
      now,
    ],
  });

const insertConnection = (client: SqliteDataMigrationClient, tenant = "org_1") =>
  client.execute({
    sql: `INSERT INTO connection
      (integration, name, template, provider, item_ids, identity_label, description,
       last_health, tools_synced_at, oauth_client, oauth_client_owner, refresh_item_id,
       expires_at, oauth_scope, oauth_token_url, provider_state, created_at, updated_at,
       row_id, tenant, owner, subject)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      "google",
      "main",
      "googleOAuth",
      "vault",
      JSON.stringify({ token: "access_item", refresh: "refresh_item" }),
      "person@example.test",
      now,
      "google",
      "org",
      "refresh_item",
      now + 60_000,
      "calendar gmail",
      "https://oauth2.googleapis.com/token",
      JSON.stringify({ token: "metadata" }),
      now,
      now,
      `conn_google_${tenant}`,
      tenant,
      "org",
      "",
    ],
  });

const insertTool = (client: SqliteDataMigrationClient, name: string, tenant = "org_1") =>
  client.execute({
    sql: `INSERT INTO tool
      (tenant, owner, subject, integration, connection, plugin_id, name, description,
       input_schema, output_schema, annotations, created_at, updated_at, row_id)
      VALUES (?, 'org', '', 'google', 'main', 'google', ?, 'tool', '{}', '{}', '{}', ?, ?, ?)`,
    args: [tenant, name, now, now, `tool_${tenant}_${name}`],
  });

const insertOperation = (client: SqliteDataMigrationClient, name: string, tenant = "org_1") =>
  client.execute({
    sql: `INSERT INTO plugin_storage
      (tenant, owner, subject, plugin_id, collection, key, data, created_at, updated_at, row_id)
      VALUES (?, 'org', '', 'google', 'operation', ?, ?, ?, ?, ?)`,
    args: [
      tenant,
      operationStorageKey("google", name),
      JSON.stringify({
        integration: "google",
        toolName: name,
        binding: { method: "get", pathTemplate: `/${name}`, parameters: [] },
        description: name,
      }),
      now,
      now,
      `op_${tenant}_${name}`,
    ],
  });

const insertBlob = (client: SqliteDataMigrationClient, key: string, tenant = "org_1") =>
  client.execute({
    sql: "INSERT INTO blob (namespace, key, value, row_id, id) VALUES (?, ?, ?, ?, ?)",
    args: [
      `o:${tenant}/google`,
      key,
      "blob",
      `blob_${tenant}_${key}`,
      JSON.stringify([`o:${tenant}/google`, key]),
    ],
  });

const insertPolicy = (client: SqliteDataMigrationClient) =>
  client.execute({
    sql: `INSERT INTO tool_policy
      (id, pattern, action, position, created_at, updated_at, row_id, tenant, owner, subject)
      VALUES (?, ?, 'block', 'a0', ?, ?, ?, 'org_1', 'org', '')`,
    args: ["policy_orphan", "google.*.*.gmail.users.messages.send", now, now, "policy_orphan_row"],
  });

const seedCalendarOrg = (
  client: SqliteDataMigrationClient,
  tenant = "org_1",
  options: { readonly includeBlobs?: boolean } = { includeBlobs: true },
) =>
  Effect.gen(function* () {
    yield* Effect.promise(() =>
      insertIntegration(client, {
        rowId: `google_row_${tenant}`,
        tenant,
        slug: "google",
        pluginId: "google",
        config: {
          googleDiscoveryUrls: [
            "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest",
            "https://www.googleapis.com/discovery/v1/apis/oauth2/v2/rest",
          ],
          specHash: "mono-hash",
        },
        healthCheck: { operation: "oauth2.userinfo.get" },
      }),
    );
    yield* Effect.promise(() => insertConnection(client, tenant));
    yield* Effect.promise(() => insertTool(client, "calendar.events.list", tenant));
    yield* Effect.promise(() => insertOperation(client, "calendar.events.list", tenant));
    yield* Effect.promise(() => insertOperation(client, "oauth2.userinfo.get", tenant));
    if (options.includeBlobs !== false) {
      yield* Effect.promise(() => insertBlob(client, "spec/mono-hash", tenant));
      yield* Effect.promise(() => insertBlob(client, "defs/mono-hash", tenant));
    }
  });

describe("providerServiceSplitDataMigration", () => {
  it.effect("splits libSQL monolith rows into openapi service rows and stamps once", () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() }));
      const client = db.client;

      yield* Effect.promise(() =>
        insertIntegration(client, {
          rowId: "google_row",
          tenant: "org_1",
          slug: "google",
          pluginId: "google",
          config: {
            googleDiscoveryUrls: [
              "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest",
              "https://www.googleapis.com/discovery/v1/apis/oauth2/v2/rest",
            ],
            specHash: "mono-hash",
          },
          healthCheck: { operation: "oauth2.userinfo.get" },
        }),
      );
      yield* Effect.promise(() => insertConnection(client));
      yield* Effect.promise(() => insertTool(client, "calendar.events.list"));
      yield* Effect.promise(() => insertOperation(client, "calendar.events.list"));
      yield* Effect.promise(() => insertOperation(client, "oauth2.userinfo.get"));
      yield* Effect.promise(() => insertBlob(client, "spec/mono-hash"));
      yield* Effect.promise(() => insertBlob(client, "defs/mono-hash"));
      yield* Effect.promise(() => insertPolicy(client));

      expect(yield* runSqliteDataMigrations(client, [providerServiceSplitDataMigration])).toEqual([
        "2026-07-08-provider-service-split",
      ]);
      expect(yield* runSqliteDataMigrations(client, [providerServiceSplitDataMigration])).toEqual(
        [],
      );

      const integrations = yield* Effect.promise(() =>
        client.execute(
          "SELECT slug, plugin_id, config, health_check FROM integration ORDER BY slug",
        ),
      );
      expect(integrations.rows).toHaveLength(1);
      expect(integrations.rows[0]?.slug).toBe("google_calendar");
      expect(integrations.rows[0]?.plugin_id).toBe("openapi");
      expect(parseJson(String(integrations.rows[0]?.config))).toMatchObject({
        specHash: "mono-hash",
        specUrl: "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest",
        specFormat: "google-discovery",
        family: "google",
      });
      expect(parseJson(String(integrations.rows[0]?.health_check))).toEqual({
        operation: "calendar.calendarList.list",
      });

      const connections = yield* Effect.promise(() =>
        client.execute("SELECT integration, item_ids, oauth_client FROM connection"),
      );
      expect(connections.rows).toEqual([
        {
          integration: "google_calendar",
          item_ids: JSON.stringify({
            token: "access_item",
            refresh: "refresh_item",
          }),
          oauth_client: "google",
        },
      ]);

      const storage = yield* Effect.promise(() =>
        client.execute(
          "SELECT plugin_id, key, data FROM plugin_storage WHERE collection = 'operation'",
        ),
      );
      expect(storage.rows).toHaveLength(1);
      expect(storage.rows[0]?.plugin_id).toBe("openapi");
      expect(storage.rows[0]?.key).toBe(
        operationStorageKey("google_calendar", "calendar.events.list"),
      );
      expect(parseJson(String(storage.rows[0]?.data))).toMatchObject({
        integration: "google_calendar",
        toolName: "calendar.events.list",
      });

      const tools = yield* Effect.promise(() =>
        client.execute("SELECT integration, plugin_id, name FROM tool"),
      );
      expect(tools.rows).toEqual([
        {
          integration: "google_calendar",
          plugin_id: "openapi",
          name: "calendar.events.list",
        },
      ]);

      const policies = yield* Effect.promise(() =>
        client.execute("SELECT id, pattern, action FROM tool_policy"),
      );
      expect(policies.rows).toEqual([
        {
          id: "policy_orphan",
          pattern: "google_calendar.*.*.gmail.users.messages.send",
          action: "block",
        },
      ]);

      yield* Effect.promise(() => db.close());
    }),
  );

  it.effect("skips an org intact when a source blob is missing", () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() }));
      const client = db.client;

      yield* seedCalendarOrg(client, "org_1", { includeBlobs: false });

      expect(yield* runSqliteProviderServiceSplitMigration(client)).toBe(0);

      const integrations = yield* Effect.promise(() =>
        client.execute("SELECT slug, plugin_id FROM integration ORDER BY slug"),
      );
      expect(integrations.rows).toEqual([{ slug: "google", plugin_id: "google" }]);

      yield* Effect.promise(() => db.close());
    }),
  );

  it.effect("uses the per-org ledger to recover after a mid-run crash", () =>
    Effect.gen(function* () {
      const db = yield* Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() }));
      const client = db.client;

      yield* seedCalendarOrg(client, "org_1");
      yield* seedCalendarOrg(client, "org_2");

      const failed = yield* Effect.flip(
        runSqliteProviderServiceSplitMigration(client, {
          beforeStampOrg: (org) =>
            org.tenant === "org_2"
              ? Effect.fail(
                  new DataMigrationError({
                    migration: "2026-07-08-provider-service-split",
                    cause: "crash before org_2 stamp",
                  }),
                )
              : Effect.void,
        }),
      );
      expect(failed).toBeInstanceOf(DataMigrationError);

      const ledgerAfterCrash = yield* Effect.promise(() =>
        client.execute("SELECT tenant FROM provider_service_split_org_migration ORDER BY tenant"),
      );
      expect(ledgerAfterCrash.rows).toEqual([{ tenant: "org_1" }]);

      expect(yield* runSqliteProviderServiceSplitMigration(client)).toBe(1);

      const ledgerAfterRerun = yield* Effect.promise(() =>
        client.execute("SELECT tenant FROM provider_service_split_org_migration ORDER BY tenant"),
      );
      expect(ledgerAfterRerun.rows).toEqual([{ tenant: "org_1" }, { tenant: "org_2" }]);

      const integrations = yield* Effect.promise(() =>
        client.execute("SELECT tenant, slug, plugin_id FROM integration ORDER BY tenant, slug"),
      );
      expect(integrations.rows).toEqual([
        { tenant: "org_1", slug: "google_calendar", plugin_id: "openapi" },
        { tenant: "org_2", slug: "google_calendar", plugin_id: "openapi" },
      ]);

      yield* Effect.promise(() => db.close());
    }),
  );
});
