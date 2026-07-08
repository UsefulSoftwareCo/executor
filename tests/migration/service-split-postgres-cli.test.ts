import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { PGlite } from "../../apps/cloud/node_modules/@electric-sql/pglite";
import { PGLiteSocketServer } from "../../apps/cloud/node_modules/@electric-sql/pglite-socket";
import postgres from "../../apps/cloud/node_modules/postgres/src/index.js";
import {
  applyOrg,
  LEDGER_TABLE,
  readDatabaseInput,
  type SqlClient,
} from "../../scripts/migration/service-split-postgres-cli";
import {
  operationStorageKey,
  planMigration,
} from "@executor-js/plugin-provider-service-split/planner";

const now = "2026-01-01T00:00:00.000Z";
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const parseJson = (value: unknown): unknown =>
  typeof value === "string" ? decodeJson(value) : value;

const createSchema = async (sql: SqlClient): Promise<void> => {
  await sql.unsafe(`
    CREATE TABLE integration (
      slug varchar(255) NOT NULL,
      plugin_id varchar(255) NOT NULL,
      name text,
      description text,
      config json,
      health_check json,
      config_revised_at bigint,
      can_remove boolean NOT NULL,
      can_refresh boolean NOT NULL,
      created_at timestamp NOT NULL,
      updated_at timestamp NOT NULL,
      row_id text NOT NULL,
      tenant text NOT NULL
    );
    CREATE UNIQUE INDEX integration_uidx ON integration (tenant, slug);

    CREATE TABLE connection (
      integration varchar(255) NOT NULL,
      name varchar(255) NOT NULL,
      template varchar(255) NOT NULL,
      provider text NOT NULL,
      item_ids json,
      identity_label text,
      description text,
      last_health json,
      tools_synced_at bigint,
      oauth_client text,
      oauth_client_owner text,
      refresh_item_id text,
      expires_at bigint,
      oauth_scope text,
      oauth_token_url text,
      provider_state json,
      created_at timestamp NOT NULL,
      updated_at timestamp NOT NULL,
      row_id text NOT NULL,
      tenant text NOT NULL,
      owner text NOT NULL,
      subject text NOT NULL
    );
    CREATE UNIQUE INDEX connection_uidx ON connection
      (tenant, owner, subject, integration, name);

    CREATE TABLE tool (
      integration varchar(255) NOT NULL,
      connection varchar(255) NOT NULL,
      plugin_id varchar(255) NOT NULL,
      name text NOT NULL,
      description text,
      input_schema json,
      output_schema json,
      annotations json,
      created_at timestamp NOT NULL,
      updated_at timestamp NOT NULL,
      row_id text NOT NULL,
      tenant text NOT NULL,
      owner text NOT NULL,
      subject text NOT NULL
    );
    CREATE UNIQUE INDEX tool_uidx ON tool
      (tenant, owner, subject, integration, connection, name);

    CREATE TABLE plugin_storage (
      plugin_id varchar(255) NOT NULL,
      collection varchar(255) NOT NULL,
      key text NOT NULL,
      data jsonb,
      created_at timestamp NOT NULL,
      updated_at timestamp NOT NULL,
      row_id text NOT NULL,
      tenant text NOT NULL,
      owner text NOT NULL,
      subject text NOT NULL
    );
    CREATE UNIQUE INDEX plugin_storage_uidx ON plugin_storage
      (tenant, owner, subject, plugin_id, collection, key);

    CREATE TABLE blob (
      id text NOT NULL,
      namespace text NOT NULL,
      key text NOT NULL,
      value text NOT NULL,
      row_id text NOT NULL
    );
    CREATE UNIQUE INDEX blob_id_uidx ON blob (id);

    CREATE TABLE tool_policy (
      id text NOT NULL,
      pattern text NOT NULL,
      action text NOT NULL,
      position text NOT NULL,
      created_at timestamp NOT NULL,
      updated_at timestamp NOT NULL,
      row_id text NOT NULL,
      tenant text NOT NULL,
      owner text NOT NULL,
      subject text NOT NULL
    );
    CREATE UNIQUE INDEX tool_policy_uidx ON tool_policy (tenant, owner, subject, id);
  `);
};

const seedMonolith = async (sql: SqlClient): Promise<void> => {
  await sql.unsafe(
    `
      INSERT INTO integration (
        slug, plugin_id, name, description, config, health_check, config_revised_at,
        can_remove, can_refresh, created_at, updated_at, row_id, tenant
      )
      VALUES ('google', 'google', 'Google', 'Google APIs', $1::json, $2::json, NULL,
        true, true, $3, $3, 'google_row', 'org_1')
    `,
    [
      JSON.stringify({
        googleDiscoveryUrls: ["https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest"],
        specHash: "mono-hash",
      }),
      JSON.stringify({ operation: "oauth2.userinfo.get" }),
      now,
    ],
  );
  await sql.unsafe(
    `
      INSERT INTO connection (
        integration, name, template, provider, item_ids, identity_label, description,
        last_health, tools_synced_at, oauth_client, oauth_client_owner, refresh_item_id,
        expires_at, oauth_scope, oauth_token_url, provider_state, created_at, updated_at,
        row_id, tenant, owner, subject
      )
      VALUES ('google', 'main', 'googleOAuth', 'vault', $1::json, 'person@example.test',
        NULL, NULL, 1, 'google', 'org', 'refresh_item', 2, 'calendar',
        'https://oauth2.googleapis.com/token', $2::json, $3, $3, 'conn_google',
        'org_1', 'org', '')
    `,
    [JSON.stringify({ access: "access_item", refresh: "refresh_item" }), "{}", now],
  );
  await sql.unsafe(
    `
      INSERT INTO tool (
        integration, connection, plugin_id, name, description, input_schema, output_schema,
        annotations, created_at, updated_at, row_id, tenant, owner, subject
      )
      VALUES ('google', 'main', 'google', 'calendar.events.list', 'tool', '{}'::json,
        '{}'::json, '{}'::json, $1, $1, 'tool_calendar_events_list', 'org_1', 'org', '')
    `,
    [now],
  );
  await sql.unsafe(
    `
      INSERT INTO plugin_storage (
        plugin_id, collection, key, data, created_at, updated_at, row_id, tenant, owner, subject
      )
      VALUES ('google', 'operation', $1, $2::jsonb, $3, $3, 'op_calendar_events_list',
        'org_1', 'org', '')
    `,
    [
      operationStorageKey("google", "calendar.events.list"),
      JSON.stringify({
        integration: "google",
        toolName: "calendar.events.list",
        binding: {
          method: "get",
          pathTemplate: "/calendar.events.list",
          parameters: [],
        },
        description: "calendar.events.list",
      }),
      now,
    ],
  );
  await sql.unsafe(
    `INSERT INTO blob (id, namespace, key, value, row_id)
     VALUES
      ($1, 'o:org_1/google', 'spec/mono-hash', 'spec text', 'spec_row'),
      ($2, 'o:org_1/google', 'defs/mono-hash', 'defs text', 'defs_row')`,
    [
      JSON.stringify(["o:org_1/google", "spec/mono-hash"]),
      JSON.stringify(["o:org_1/google", "defs/mono-hash"]),
    ],
  );
  await sql.unsafe(
    `
      INSERT INTO tool_policy (
        id, pattern, action, position, created_at, updated_at, row_id, tenant, owner, subject
      )
      VALUES ('policy_google_all', 'google.*', 'block', 'a0', $1, $1, 'policy_row',
        'org_1', 'org', '')
    `,
    [now],
  );
};

const seedNonCanonicalGoogleMonolith = async (sql: SqlClient): Promise<void> => {
  await sql.unsafe(
    `
      INSERT INTO integration (
        slug, plugin_id, name, description, config, health_check, config_revised_at,
        can_remove, can_refresh, created_at, updated_at, row_id, tenant
      )
      VALUES ('google_photos_youtube', 'google', 'Google Photos YouTube', 'Google APIs',
        $1::json, NULL, NULL, true, true, $2, $2, 'google_photos_youtube_row', 'org_1')
    `,
    [
      JSON.stringify({
        googleDiscoveryUrls: ["https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest"],
        specHash: "youtube-hash",
      }),
      now,
    ],
  );
  await sql.unsafe(
    `
      INSERT INTO connection (
        integration, name, template, provider, item_ids, identity_label, description,
        last_health, tools_synced_at, oauth_client, oauth_client_owner, refresh_item_id,
        expires_at, oauth_scope, oauth_token_url, provider_state, created_at, updated_at,
        row_id, tenant, owner, subject
      )
      VALUES ('google_photos_youtube', 'main', 'googleOAuth', 'vault', '{}'::json,
        'person@example.test', NULL, NULL, 1, 'google', 'org', 'refresh_item', 2,
        'youtube', 'https://oauth2.googleapis.com/token', '{}'::json, $1, $1,
        'conn_google_photos_youtube', 'org_1', 'org', '')
    `,
    [now],
  );
  await sql.unsafe(
    `
      INSERT INTO tool (
        integration, connection, plugin_id, name, description, input_schema, output_schema,
        annotations, created_at, updated_at, row_id, tenant, owner, subject
      )
      VALUES ('google_photos_youtube', 'main', 'google', 'youtube.channels.list', 'tool',
        '{}'::json, '{}'::json, '{}'::json, $1, $1, 'tool_youtube_channels_list',
        'org_1', 'org', '')
    `,
    [now],
  );
  await sql.unsafe(
    `
      INSERT INTO plugin_storage (
        plugin_id, collection, key, data, created_at, updated_at, row_id, tenant, owner, subject
      )
      VALUES ('google', 'operation', $1, $2::jsonb, $3, $3, 'op_youtube_channels_list',
        'org_1', 'org', '')
    `,
    [
      operationStorageKey("google_photos_youtube", "youtube.channels.list"),
      JSON.stringify({
        integration: "google_photos_youtube",
        toolName: "youtube.channels.list",
      }),
      now,
    ],
  );
  await sql.unsafe(
    `INSERT INTO blob (id, namespace, key, value, row_id)
     VALUES
      ($1, 'o:org_1/google', 'spec/youtube-hash', 'spec text', 'spec_youtube_row'),
      ($2, 'o:org_1/google', 'defs/youtube-hash', 'defs text', 'defs_youtube_row')`,
    [
      JSON.stringify(["o:org_1/google", "spec/youtube-hash"]),
      JSON.stringify(["o:org_1/google", "defs/youtube-hash"]),
    ],
  );
};

describe("service-split-postgres-cli", () => {
  it("reads non-canonical provider monolith slugs from Postgres input", async () => {
    const pglite = await PGlite.create("memory://");
    const server = new PGLiteSocketServer({
      db: pglite,
      port: 0,
      host: "127.0.0.1",
    });
    await server.start();
    const port = Number(server.getServerConn().split(":").at(1));
    const sql = postgres(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`, {
      max: 1,
      prepare: false,
    }) as SqlClient;

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: test cleans up pglite/postgres resources after assertions
    try {
      await createSchema(sql);
      await seedNonCanonicalGoogleMonolith(sql);

      const input = await readDatabaseInput(sql, false, "database");
      const plan = planMigration(input);

      expect(input.integrations.map((row) => row.slug)).toContain("google_photos_youtube");
      expect(input.tools.map((row) => row.integration)).toEqual(["google_photos_youtube"]);
      expect(plan.orgs[0]?.integrations.map((row) => row.target.slug)).toEqual([
        "google_youtube_data",
      ]);
    } finally {
      await sql.end({ timeout: 0 });
      await server.stop();
      await pglite.close();
    }
  });

  it("applies a synthetic monolith split through the Postgres runner and stamps the ledger", async () => {
    const pglite = await PGlite.create("memory://");
    const server = new PGLiteSocketServer({
      db: pglite,
      port: 0,
      host: "127.0.0.1",
    });
    await server.start();
    const port = Number(server.getServerConn().split(":").at(1));
    const sql = postgres(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`, {
      max: 1,
      prepare: false,
    }) as SqlClient;

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: test cleans up pglite/postgres resources after assertions
    try {
      await createSchema(sql);
      await seedMonolith(sql);

      const input = await readDatabaseInput(sql, false, "database");
      const plan = planMigration(input);
      expect(plan.summary).toMatchObject({
        integrationsCreate: 1,
        connectionsClone: 1,
        policiesRewrite: 1,
        monolithDeletes: 1,
      });

      const org = plan.orgs[0];
      expect(org).toBeDefined();
      await applyOrg(sql, org!);

      const integrations = await sql.unsafe<
        {
          readonly slug: string;
          readonly plugin_id: string;
          readonly config: unknown;
        }[]
      >(
        "SELECT slug, plugin_id, config::jsonb AS config, jsonb_typeof(config::jsonb) AS config_type FROM integration ORDER BY slug",
      );
      expect(integrations).toHaveLength(1);
      expect(integrations[0]).toMatchObject({
        slug: "google_calendar",
        plugin_id: "openapi",
        // A double-encoded config lands as jsonb string, which some runtime
        // readers reject; the migration must write a real JSON object.
        config_type: "object",
      });
      expect(parseJson(integrations[0]?.config)).toMatchObject({
        specHash: "mono-hash",
        sourceUrl: "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest",
        specFormat: "google-discovery",
        family: "google",
      });

      const connections = await sql.unsafe<
        {
          readonly integration: string;
          readonly provider: string;
          readonly item_ids: unknown;
          readonly oauth_client: string;
        }[]
      >("SELECT integration, provider, item_ids, oauth_client FROM connection");
      expect(connections).toHaveLength(1);
      expect(connections[0]).toMatchObject({
        integration: "google_calendar",
        provider: "vault",
        oauth_client: "google",
      });
      expect(parseJson(connections[0]?.item_ids)).toEqual({
        access: "access_item",
        refresh: "refresh_item",
      });

      const operations = await sql.unsafe<
        {
          readonly plugin_id: string;
          readonly key: string;
          readonly data: unknown;
        }[]
      >(
        "SELECT plugin_id, key, data, jsonb_typeof(data::jsonb) AS data_type FROM plugin_storage WHERE collection = 'operation'",
      );
      expect(operations).toHaveLength(1);
      expect(operations[0]).toMatchObject({
        plugin_id: "openapi",
        key: operationStorageKey("google_calendar", "calendar.events.list"),
        data_type: "object",
      });
      expect(parseJson(operations[0]?.data)).toMatchObject({
        integration: "google_calendar",
        toolName: "calendar.events.list",
      });

      const tools = await sql.unsafe<
        {
          readonly integration: string;
          readonly plugin_id: string;
          readonly name: string;
        }[]
      >("SELECT integration, plugin_id, name FROM tool");
      expect(tools).toEqual([
        {
          integration: "google_calendar",
          plugin_id: "openapi",
          name: "calendar.events.list",
        },
      ]);

      const policies = await sql.unsafe<{ readonly pattern: string; readonly action: string }[]>(
        "SELECT pattern, action FROM tool_policy",
      );
      expect(policies).toEqual([{ pattern: "google_calendar.*", action: "block" }]);

      const blobs = await sql.unsafe<
        {
          readonly namespace: string;
          readonly key: string;
          readonly value: string;
        }[]
      >("SELECT namespace, key, value FROM blob WHERE namespace = 'o:org_1/openapi' ORDER BY key");
      expect(blobs).toEqual([
        {
          namespace: "o:org_1/openapi",
          key: "defs/mono-hash",
          value: "defs text",
        },
        {
          namespace: "o:org_1/openapi",
          key: "spec/mono-hash",
          value: "spec text",
        },
      ]);

      const ledger = await sql.unsafe<{ readonly tenant: string }[]>(
        `SELECT tenant FROM ${LEDGER_TABLE}`,
      );
      expect(ledger).toEqual([{ tenant: "org_1" }]);

      const rerunInput = await readDatabaseInput(sql, false, "database");
      expect(planMigration(rerunInput).summary.orgs).toBe(0);
    } finally {
      await sql.end({ timeout: 0 });
      await server.stop();
      await pglite.close();
    }
  });
});
