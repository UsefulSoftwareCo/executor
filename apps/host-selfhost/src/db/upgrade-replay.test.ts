// Upgrade replay: a realistic data.db created by an OLDER selfhost release is
// carried through the CURRENT boot path — the schema ensure plus the stamped
// data-migration ledger. Fresh-database tests only ever see the end state;
// this seeds a file the way the old code shipped it (tables without the
// later columns, inline spec configs, the variable()-templated legacy auth
// shape, envelope-era tool schemas) and then boots over it, asserting the
// data each migration promises to transform was transformed — and everything
// else survived.
//
// The old DDL below mirrors the checked-in sqlite v2 baseline
// (apps/local/drizzle/0000_v2_baseline.sql) — the genuine schema of the era —
// inlined so this package stays self-contained (the v1→v2 test in apps/local
// uses the same inline-DDL idiom).
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { describe, expect, test } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { runSqliteDataMigrations } from "@executor-js/sdk";

import { createSelfHostDb } from "./self-host-db";
import { selfHostDataMigrations } from "./data-migrations";

const TENANT = "org_team";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const MigratedConfig = Schema.Struct({
  spec: Schema.optional(Schema.String),
  specHash: Schema.optional(Schema.String),
  authenticationTemplate: Schema.Array(Schema.Struct({ kind: Schema.optional(Schema.String) })),
});
const decodeMigratedConfig = Schema.decodeUnknownSync(Schema.fromJsonString(MigratedConfig));

/** The retired {status, headers, data} transport envelope, exactly as the old
 *  OpenAPI tool producer persisted it. */
const envelopeSchema = (data: Record<string, unknown>) =>
  JSON.stringify({
    type: "object",
    additionalProperties: false,
    required: ["status", "headers", "data"],
    properties: {
      status: { type: "integer" },
      headers: { type: "object", additionalProperties: { type: "string" } },
      data,
    },
  });

const PAYLOAD_SCHEMA = { type: "object", properties: { id: { type: "string" } } };

const INLINE_SPEC = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "GitHub", version: "1.0.0" },
  paths: {
    "/repo": { get: { operationId: "getRepo", responses: { "200": { description: "ok" } } } },
  },
});

/** The pre-placements auth template (`variable()`-templated apiKey) the old
 *  release stored verbatim in `integration.config`. */
const LEGACY_TEMPLATE = {
  slug: "apiKey",
  type: "apiKey",
  headers: { authorization: ["Bearer ", { type: "variable", name: "token" }] },
};

/** Write a data.db shaped the way the June-era selfhost release left it. */
const seedOldDatabase = async (path: string) => {
  const db = createClient({ url: `file:${path}` });
  const now = Date.now();
  // The era's schema: no oauth_client.origin_kind / origin_integration yet,
  // no data_migration ledger table yet.
  await db.executeMultiple(`
    CREATE TABLE integration (
      slug text NOT NULL, plugin_id text NOT NULL, description text NOT NULL,
      config text, can_remove integer DEFAULT 1 NOT NULL, can_refresh integer DEFAULT 0 NOT NULL,
      created_at integer NOT NULL, updated_at integer NOT NULL,
      row_id text PRIMARY KEY NOT NULL, tenant text NOT NULL
    );
    CREATE UNIQUE INDEX integration_uidx ON integration (tenant, slug);
    CREATE TABLE connection (
      integration text NOT NULL, name text NOT NULL, template text NOT NULL, provider text NOT NULL,
      item_ids text NOT NULL, identity_label text, oauth_client text, oauth_client_owner text,
      refresh_item_id text, expires_at blob, oauth_scope text, provider_state text,
      created_at integer NOT NULL, updated_at integer NOT NULL,
      row_id text PRIMARY KEY NOT NULL, tenant text NOT NULL, owner text NOT NULL, subject text NOT NULL
    );
    CREATE UNIQUE INDEX connection_uidx ON connection (tenant, owner, subject, integration, name);
    CREATE TABLE tool (
      integration text NOT NULL, connection text NOT NULL, plugin_id text NOT NULL,
      name text NOT NULL, description text NOT NULL, input_schema text, output_schema text,
      annotations text, created_at integer NOT NULL, updated_at integer NOT NULL,
      row_id text PRIMARY KEY NOT NULL, tenant text NOT NULL, owner text NOT NULL, subject text NOT NULL
    );
    CREATE UNIQUE INDEX tool_uidx ON tool (tenant, owner, subject, integration, connection, name);
    CREATE TABLE oauth_client (
      slug text NOT NULL, authorization_url text NOT NULL, token_url text NOT NULL,
      grant text NOT NULL, client_id text NOT NULL, client_secret_item_id text, resource text,
      created_at integer NOT NULL,
      row_id text PRIMARY KEY NOT NULL, tenant text NOT NULL, owner text NOT NULL, subject text NOT NULL
    );
    CREATE UNIQUE INDEX oauth_client_uidx ON oauth_client (tenant, owner, subject, slug);
    CREATE TABLE blob (
      namespace text NOT NULL, key text NOT NULL, value text NOT NULL,
      row_id text PRIMARY KEY NOT NULL, id text NOT NULL
    );
    CREATE UNIQUE INDEX blob_id_uidx ON blob (id);
  `);

  await db.execute({
    sql: `INSERT INTO integration (slug, plugin_id, description, config, created_at, updated_at, row_id, tenant)
          VALUES ('github', 'openapi', 'GitHub API', ?, ?, ?, 'row_int_1', ?)`,
    args: [
      // Inline spec text (pre blob migration) + the legacy auth template
      // (pre placements migration), in one config — the realistic combination.
      JSON.stringify({
        spec: INLINE_SPEC,
        baseUrl: "https://api.github.com",
        authenticationTemplate: [LEGACY_TEMPLATE],
      }),
      now,
      now,
      TENANT,
    ],
  });
  await db.execute({
    sql: `INSERT INTO connection (integration, name, template, provider, item_ids, created_at, updated_at, row_id, tenant, owner, subject)
          VALUES ('github', 'shared', 'apiKey', 'local', '{"token":"item_1"}', ?, ?, 'row_conn_1', ?, 'org', '-')`,
    args: [now, now, TENANT],
  });
  await db.execute({
    sql: `INSERT INTO oauth_client (slug, authorization_url, token_url, grant, client_id, created_at, row_id, tenant, owner, subject)
          VALUES ('gh-app', 'https://example.test/authorize', 'https://example.test/token', 'authorization_code', 'client_abc', ?, 'row_oc_1', ?, 'org', '-')`,
    args: [now, TENANT],
  });

  const tool = (rowId: string, pluginId: string, name: string, outputSchema: string | null) =>
    db.execute({
      sql: `INSERT INTO tool (integration, connection, plugin_id, name, description, output_schema, created_at, updated_at, row_id, tenant, owner, subject)
            VALUES ('github', 'shared', ?, ?, 'd', ?, ?, ?, ?, ?, 'org', '-')`,
      args: [pluginId, name, outputSchema, now, now, rowId, TENANT],
    });
  // The envelope around a real payload → must unwrap to the payload.
  await tool("row_tool_env", "openapi", "getRepo", envelopeSchema(PAYLOAD_SCHEMA));
  // The envelope around `"data": {}` → the new producer persists NULL.
  await tool("row_tool_empty", "openapi", "deleteRepo", envelopeSchema({}));
  // Already payload-shaped → untouched.
  await tool("row_tool_plain", "openapi", "listRepos", JSON.stringify(PAYLOAD_SCHEMA));
  // Envelope SHAPE under another plugin → not openapi's to rewrite.
  await tool("row_tool_mcp", "mcp", "createIssue", envelopeSchema(PAYLOAD_SCHEMA));

  db.close();
};

describe("selfhost boot · upgrade replay over a realistic old data.db", () => {
  test("an old-release database upgrades through the schema ensure and the data-migration ledger", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "eh-upgrade-")), "data.db");
    await seedOldDatabase(path);

    // THE production boot order (app.ts): schema bring-up, then the ledger.
    const handle = await createSelfHostDb({ path });
    const applied = await Effect.runPromise(
      runSqliteDataMigrations(handle.client, selfHostDataMigrations),
    );
    expect(applied, "first boot over an old database applies the full migration registry").toEqual(
      selfHostDataMigrations.map((migration) => migration.name),
    );

    // The ensure brought the schema to current: tables the old release didn't
    // have exist now…
    const tables = (
      await handle.client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    ).rows.map((row) => row.name);
    for (const table of ["definition", "oauth_session", "plugin_storage", "tool_policy"]) {
      expect(tables, `the ensure created the ${table} table the old release lacked`).toContain(
        table,
      );
    }
    // …and columns added to EXISTING tables since the old release exist too.
    // (`CREATE TABLE IF NOT EXISTS` alone never alters an existing table —
    // this is what the defensive column adds are for.)
    const oauthClientColumns = (
      await handle.client.execute("PRAGMA table_info('oauth_client')")
    ).rows.map((row) => row.name);
    expect(
      oauthClientColumns,
      "the upgraded oauth_client table carries the origin columns added since",
    ).toEqual(expect.arrayContaining(["origin_kind", "origin_integration"]));
    const oldApp = (
      await handle.client.execute(
        "SELECT client_id, origin_kind FROM oauth_client WHERE row_id = 'row_oc_1'",
      )
    ).rows[0];
    expect(oldApp, "the pre-existing app survives; null origin reads as manual").toMatchObject({
      client_id: "client_abc",
      origin_kind: null,
    });

    // Auth-config migration: the legacy template was rewritten to placements.
    const config = decodeMigratedConfig(
      String(
        (await handle.client.execute("SELECT config FROM integration WHERE row_id = 'row_int_1'"))
          .rows[0]?.config,
      ),
    );
    expect(
      config.authenticationTemplate[0]?.kind,
      "the legacy variable()-templated apiKey became a canonical placements method",
    ).toBe("apikey");

    // Spec-blob migration: the inline spec moved to the blob table; the
    // config keeps only the content hash.
    const specHash = createHash("sha256").update(INLINE_SPEC).digest("hex");
    expect(config.spec, "the inline spec text left the config").toBeUndefined();
    expect(config.specHash, "the config now carries the spec's content hash").toBe(specHash);
    const blob = (
      await handle.client.execute({
        sql: "SELECT value FROM blob WHERE namespace = ? AND key = ?",
        args: [`o:${TENANT}/openapi`, `spec/${specHash}`],
      })
    ).rows[0];
    expect(blob?.value, "the blob row holds the original spec, content-addressed").toBe(
      INLINE_SPEC,
    );

    // Output-schema migration: exactly the openapi envelope rows transformed.
    const schemas = new Map(
      (await handle.client.execute("SELECT row_id, output_schema FROM tool")).rows.map((row) => [
        row.row_id,
        typeof row.output_schema === "string" ? decodeJson(row.output_schema) : row.output_schema,
      ]),
    );
    expect(schemas.get("row_tool_env"), "the envelope unwraps to its payload schema").toEqual(
      PAYLOAD_SCHEMA,
    );
    expect(schemas.get("row_tool_empty"), "an empty-data envelope becomes no schema").toBeNull();
    expect(schemas.get("row_tool_plain"), "a payload-shaped row is left alone").toEqual(
      PAYLOAD_SCHEMA,
    );
    expect(
      schemas.get("row_tool_mcp"),
      "another plugin's envelope-shaped schema is NOT openapi's to rewrite",
    ).toEqual(decodeJson(envelopeSchema(PAYLOAD_SCHEMA)));

    // The rows no migration targets survive untouched.
    const connection = (
      await handle.client.execute(
        "SELECT item_ids, tenant FROM connection WHERE row_id = 'row_conn_1'",
      )
    ).rows[0];
    expect(connection, "the saved connection's credential map is untouched").toMatchObject({
      item_ids: '{"token":"item_1"}',
      tenant: TENANT,
    });

    await handle.close();

    // A second boot is a no-op: every migration is stamped in the ledger.
    const second = await createSelfHostDb({ path });
    const reapplied = await Effect.runPromise(
      runSqliteDataMigrations(second.client, selfHostDataMigrations),
    );
    expect(reapplied, "the next boot applies nothing — the ledger is stamped").toEqual([]);
    await second.close();
  });
});
