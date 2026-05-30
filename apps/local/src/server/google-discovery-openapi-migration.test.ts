import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { createClient, type Client } from "@libsql/client";
import { Schema } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { oneShotMigrateGoogleDiscoveryToOpenApi } from "./google-discovery-openapi-migration";

const encodeJson = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const MigratedSourceData = Schema.Struct({
  config: Schema.Struct({
    spec: Schema.String,
    oauth2: Schema.optional(Schema.Struct({ connectionSlot: Schema.optional(Schema.String) })),
  }),
});
const MigratedOperation = Schema.Struct({
  operationId: Schema.optional(Schema.String),
  "x-executor-toolPath": Schema.optional(Schema.String),
  parameters: Schema.optional(Schema.Array(Schema.Unknown)),
});
const MigratedSpec = Schema.Struct({
  paths: Schema.Record(Schema.String, Schema.Record(Schema.String, MigratedOperation)),
});
const decodeMigratedSourceData = Schema.decodeUnknownSync(
  Schema.fromJsonString(MigratedSourceData),
);
const decodeMigratedSpec = Schema.decodeUnknownSync(Schema.fromJsonString(MigratedSpec));

// libSQL's `:memory:` opens a SEPARATE in-memory database per connection, so a
// write transaction (used by the one-shot migration) would not see the seeded
// tables. Back the fixture with a temp file so the migration's transaction
// shares the same database — matching local's real on-disk usage.
let fixtureDir: string;

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "gd-openapi-mig-"));
});

afterEach(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

const createMigrationFixture = async (): Promise<Client> => {
  const db = createClient({ url: `file:${join(fixtureDir, "data.db")}` });
  await db.executeMultiple(`
    CREATE TABLE google_discovery_source (
      id text NOT NULL,
      scope_id text NOT NULL,
      name text NOT NULL,
      config text NOT NULL,
      auth_kind text NOT NULL,
      auth_connection_id text,
      auth_client_id_secret_id text,
      auth_client_secret_secret_id text,
      auth_scopes text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE TABLE google_discovery_binding (
      id text NOT NULL,
      scope_id text NOT NULL,
      source_id text NOT NULL,
      binding text NOT NULL,
      created_at integer NOT NULL
    );
    CREATE TABLE google_discovery_source_credential_header (
      id text NOT NULL,
      scope_id text NOT NULL,
      source_id text NOT NULL,
      name text NOT NULL,
      kind text NOT NULL,
      text_value text,
      secret_id text,
      secret_prefix text
    );
    CREATE TABLE google_discovery_source_credential_query_param (
      id text NOT NULL,
      scope_id text NOT NULL,
      source_id text NOT NULL,
      name text NOT NULL,
      kind text NOT NULL,
      text_value text,
      secret_id text,
      secret_prefix text
    );
    CREATE TABLE source (
      id text NOT NULL,
      scope_id text NOT NULL,
      plugin_id text NOT NULL,
      kind text NOT NULL,
      name text NOT NULL,
      url text,
      can_remove integer NOT NULL,
      can_refresh integer NOT NULL,
      can_edit integer NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE TABLE tool (
      id text NOT NULL,
      scope_id text NOT NULL,
      source_id text NOT NULL,
      plugin_id text NOT NULL,
      name text NOT NULL,
      description text NOT NULL,
      input_schema text,
      output_schema text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE TABLE definition (
      id text NOT NULL,
      scope_id text NOT NULL,
      source_id text NOT NULL,
      plugin_id text NOT NULL,
      name text NOT NULL,
      schema text NOT NULL,
      created_at integer NOT NULL
    );
    CREATE TABLE plugin_storage (
      plugin_id text NOT NULL,
      collection text NOT NULL,
      key text NOT NULL,
      data text NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      row_id text NOT NULL,
      id text NOT NULL,
      scope_id text NOT NULL
    );
    CREATE TABLE credential_binding (
      plugin_id text NOT NULL,
      source_id text NOT NULL,
      source_scope_id text NOT NULL,
      slot_key text NOT NULL,
      kind text NOT NULL,
      text_value text,
      secret_id text,
      secret_scope_id text,
      connection_id text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      row_id text NOT NULL,
      id text NOT NULL,
      scope_id text NOT NULL
    );
  `);
  return db;
};

describe("oneShotMigrateGoogleDiscoveryToOpenApi", () => {
  it("moves a Google Discovery source into OpenAPI storage without changing tool ids", async () => {
    const db = await createMigrationFixture();
    const now = 1_700_000_000;
    const sourceId = "gmail_api";
    const scopeId = "local-scope";
    const toolId = `${sourceId}.users.messages.list`;

    await db.execute({
      sql: "INSERT INTO google_discovery_source (id, scope_id, name, config, auth_kind, auth_connection_id, auth_client_id_secret_id, auth_client_secret_secret_id, auth_scopes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [
        sourceId,
        scopeId,
        "Gmail API",
        encodeJson({
          discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest",
          service: "gmail",
          version: "v1",
          rootUrl: "https://gmail.googleapis.com/",
          servicePath: "",
        }),
        "oauth2",
        "google-discovery-oauth2-gmail_api",
        "client-id-secret",
        "client-secret-secret",
        encodeJson(["https://www.googleapis.com/auth/gmail.metadata"]),
        now,
        now,
      ],
    });
    await db.execute({
      sql: "INSERT INTO source (id, scope_id, plugin_id, kind, name, url, can_remove, can_refresh, can_edit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [
        sourceId,
        scopeId,
        "googleDiscovery",
        "googleDiscovery",
        "Gmail API",
        null,
        1,
        0,
        1,
        now,
        now,
      ],
    });
    await db.execute({
      sql: "INSERT INTO google_discovery_binding (id, scope_id, source_id, binding, created_at) VALUES (?, ?, ?, ?, ?)",
      args: [
        toolId,
        scopeId,
        sourceId,
        encodeJson({
          method: "get",
          pathTemplate: "gmail/v1/users/{userId}/messages",
          hasBody: false,
          parameters: [
            {
              name: "userId",
              location: "path",
              required: true,
              repeated: false,
              schema: { type: "string" },
            },
            {
              name: "metadataHeaders",
              location: "query",
              required: false,
              repeated: true,
              schema: { type: "array", items: { type: "string" } },
            },
          ],
        }),
        now,
      ],
    });
    await db.execute({
      sql: "INSERT INTO tool (id, scope_id, source_id, plugin_id, name, description, input_schema, output_schema, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [
        toolId,
        scopeId,
        sourceId,
        "googleDiscovery",
        "users.messages.list",
        "Lists messages.",
        encodeJson({
          type: "object",
          properties: {
            userId: { type: "string" },
            metadataHeaders: { type: "array", items: { type: "string" } },
          },
        }),
        encodeJson({ $ref: "#/$defs/ListMessagesResponse" }),
        now,
        now,
      ],
    });
    await db.execute({
      sql: "INSERT INTO definition (id, scope_id, source_id, plugin_id, name, schema, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [
        `${sourceId}.ListMessagesResponse`,
        scopeId,
        sourceId,
        "googleDiscovery",
        "ListMessagesResponse",
        encodeJson({ type: "object", properties: { messages: { type: "array" } } }),
        now,
      ],
    });

    const migrated = await oneShotMigrateGoogleDiscoveryToOpenApi(db);

    expect(migrated).toBe(1);
    expect(
      (await db.execute("SELECT count(*) AS n FROM google_discovery_source")).rows[0],
    ).toMatchObject({ n: 0 });
    expect(
      (
        await db.execute({
          sql: "SELECT plugin_id, kind, url, can_refresh FROM source WHERE id = ?",
          args: [sourceId],
        })
      ).rows[0],
    ).toMatchObject({
      plugin_id: "openapi",
      kind: "openapi",
      url: "https://gmail.googleapis.com/",
      can_refresh: 0,
    });
    expect(
      (await db.execute({ sql: "SELECT plugin_id FROM tool WHERE id = ?", args: [toolId] }))
        .rows[0],
    ).toMatchObject({
      plugin_id: "openapi",
    });

    // oxlint-disable-next-line executor/no-double-cast -- boundary: the SELECT column is the schema contract for this plugin_storage row read off the libSQL client
    const sourceStorage = (
      await db.execute({
        sql: "SELECT data FROM plugin_storage WHERE collection = 'source' AND key = ?",
        args: [sourceId],
      })
    ).rows[0] as unknown as { data: string };
    const sourceData = decodeMigratedSourceData(sourceStorage.data);
    const spec = decodeMigratedSpec(sourceData.config.spec);
    const operation = spec.paths["/gmail/v1/users/{userId}/messages"]?.get;
    expect(operation).toMatchObject({
      operationId: "users.messages.list",
      "x-executor-toolPath": "users.messages.list",
    });
    expect(operation?.parameters).toContainEqual(
      expect.objectContaining({
        name: "metadataHeaders",
        in: "query",
        style: "form",
        explode: true,
      }),
    );
    expect(sourceData.config.oauth2).toMatchObject({
      connectionSlot: "oauth2:googleoauth2:connection",
    });

    expect(
      (await db.execute("SELECT key FROM plugin_storage WHERE collection = 'operation'")).rows[0],
    ).toMatchObject({ key: toolId });
    const credentialBindings = (
      await db.execute(
        "SELECT slot_key, kind, secret_id, connection_id FROM credential_binding ORDER BY slot_key",
      )
    ).rows.map((row) => ({
      slot_key: row.slot_key,
      kind: row.kind,
      secret_id: row.secret_id,
      connection_id: row.connection_id,
    }));
    expect(credentialBindings).toEqual([
      {
        slot_key: "oauth2:googleoauth2:client-id",
        kind: "secret",
        secret_id: "client-id-secret",
        connection_id: null,
      },
      {
        slot_key: "oauth2:googleoauth2:client-secret",
        kind: "secret",
        secret_id: "client-secret-secret",
        connection_id: null,
      },
      {
        slot_key: "oauth2:googleoauth2:connection",
        kind: "connection",
        secret_id: null,
        connection_id: "google-discovery-oauth2-gmail_api",
      },
    ]);

    db.close();
  });
});
