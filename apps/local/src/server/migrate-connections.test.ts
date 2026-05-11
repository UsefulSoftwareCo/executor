import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Database } from "bun:sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Schema } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateLegacyConnections } from "./migrate-connections";

let workDir: string;
let databases: Array<Database>;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "executor-migrate-connections-"));
  databases = [];
});

afterEach(() => {
  for (const db of databases) {
    db.close();
  }
  rmSync(workDir, { recursive: true, force: true });
});

const openDatabase = (): Database => {
  const db = new Database(join(workDir, "data.db"));
  databases.push(db);
  return db;
};

const columnNames = (db: Database, table: string): ReadonlyArray<string> =>
  (
    db.prepare(`PRAGMA table_info('${table}')`).all() as ReadonlyArray<{
      readonly name: string;
    }>
  ).map((column) => column.name);

const MigratedMcpConfig = Schema.Struct({
  auth: Schema.optional(Schema.Unknown),
});
const decodeMigratedMcpConfig = Schema.decodeUnknownSync(Schema.fromJsonString(MigratedMcpConfig));

const MigratedOpenApiOAuth2 = Schema.Struct({
  kind: Schema.Literal("oauth2"),
  clientIdSlot: Schema.String,
  clientSecretSlot: Schema.NullOr(Schema.String),
  connectionSlot: Schema.String,
});
const decodeMigratedOpenApiOAuth2 = Schema.decodeUnknownSync(
  Schema.fromJsonString(MigratedOpenApiOAuth2),
);

const CredentialBindingRow = Schema.Struct({
  slot_key: Schema.String,
  kind: Schema.String,
  secret_id: Schema.NullOr(Schema.String),
  connection_id: Schema.NullOr(Schema.String),
});
const decodeCredentialBindingRows = Schema.decodeUnknownSync(Schema.Array(CredentialBindingRow));

const ConnectionProviderStateRow = Schema.Struct({
  provider_state: Schema.String,
});
const decodeConnectionProviderStateRow = Schema.decodeUnknownSync(ConnectionProviderStateRow);
const decodeJsonRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

describe("migrateLegacyConnections", () => {
  it("backfills legacy MCP OAuth rows after connection.kind has been dropped", async () => {
    const db = openDatabase();
    migrate(drizzle(db), {
      migrationsFolder: join(import.meta.dirname, "../../drizzle"),
    });

    expect(columnNames(db, "connection")).not.toContain("kind");

    const now = Date.now();
    db.prepare(
      "INSERT INTO secret (scope_id, id, name, provider, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("scope-1", "access-token", "Access token", "keychain", now);
    db.prepare(
      "INSERT INTO secret (scope_id, id, name, provider, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("scope-1", "refresh-token", "Refresh token", "keychain", now);
    db.prepare(
      "INSERT INTO mcp_source (scope_id, id, name, config, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "scope-1",
      "remote-mcp",
      "Remote MCP",
      JSON.stringify({
        transport: "remote",
        endpoint: "https://example.com/mcp",
        auth: {
          kind: "oauth2",
          accessTokenSecretId: "access-token",
          refreshTokenSecretId: "refresh-token",
          tokenType: "Bearer",
          expiresAt: null,
          scope: "read",
          clientInformation: {
            client_id: "legacy-client",
            token_endpoint_auth_method: "none",
          },
          tokenEndpoint: "https://auth.example.com/token",
          authorizationServerUrl: null,
          authorizationServerMetadata: null,
          resourceMetadataUrl: null,
        },
      }),
      now,
    );

    await migrateLegacyConnections(db);

    const connection = db
      .prepare(
        "SELECT id, provider, access_token_secret_id, refresh_token_secret_id FROM connection WHERE scope_id = ?",
      )
      .get("scope-1") as
      | {
          readonly id: string;
          readonly provider: string;
          readonly access_token_secret_id: string;
          readonly refresh_token_secret_id: string | null;
        }
      | undefined;
    expect(connection).toEqual({
      id: "mcp-oauth2-remote-mcp",
      provider: "oauth2",
      access_token_secret_id: "access-token",
      refresh_token_secret_id: "refresh-token",
    });
    const providerState = decodeJsonRecord(
      decodeConnectionProviderStateRow(
        db.prepare("SELECT provider_state FROM connection WHERE scope_id = ?").get("scope-1"),
      ).provider_state,
    );
    expect(providerState).toMatchObject({
      kind: "dynamic-dcr",
      tokenEndpoint: "https://auth.example.com/token",
      clientId: "legacy-client",
      resource: "https://example.com/mcp",
    });

    // The canonical auth lives in a source-owned slot. The migrator
    // strips config.auth, stamps the slot on mcp_source, and writes the
    // concrete connection id to credential_binding.
    const source = db
      .prepare(
        "SELECT config, auth_kind, auth_connection_slot FROM mcp_source WHERE scope_id = ? AND id = ?",
      )
      .get("scope-1", "remote-mcp") as {
      readonly config: string;
      readonly auth_kind: string;
      readonly auth_connection_slot: string;
    };
    expect(decodeMigratedMcpConfig(source.config).auth).toBeUndefined();
    expect(source.auth_kind).toBe("oauth2");
    expect(source.auth_connection_slot).toBe("auth:oauth2:connection");

    const connectionBindings = decodeCredentialBindingRows(
      db
        .prepare(
          "SELECT slot_key, kind, secret_id, connection_id FROM credential_binding WHERE plugin_id = ? AND source_id = ?",
        )
        .all("mcp", "remote-mcp"),
    );
    expect(connectionBindings).toEqual([
      {
        slot_key: "auth:oauth2:connection",
        kind: "connection",
        secret_id: null,
        connection_id: "mcp-oauth2-remote-mcp",
      },
    ]);

    const ownedSecrets = db
      .prepare("SELECT id, owned_by_connection_id FROM secret WHERE scope_id = ? ORDER BY id")
      .all("scope-1");
    expect(ownedSecrets).toEqual([
      {
        id: "access-token",
        owned_by_connection_id: "mcp-oauth2-remote-mcp",
      },
      {
        id: "refresh-token",
        owned_by_connection_id: "mcp-oauth2-remote-mcp",
      },
    ]);
  });

  it("fails and rolls back legacy MCP OAuth rows when token secrets are already owned", async () => {
    const db = openDatabase();
    migrate(drizzle(db), {
      migrationsFolder: join(import.meta.dirname, "../../drizzle"),
    });

    const now = Date.now();
    db.prepare(
      `INSERT INTO connection (
         scope_id, id, provider, identity_label,
         access_token_secret_id, refresh_token_secret_id,
         expires_at, scope, provider_state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "scope-1",
      "existing-connection",
      "oauth2",
      "Existing",
      "access-token",
      null,
      null,
      null,
      "{}",
      now,
      now,
    );
    db.prepare(
      `INSERT INTO secret (
         scope_id, id, name, provider, created_at, owned_by_connection_id
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("scope-1", "access-token", "Access token", "keychain", now, "existing-connection");
    db.prepare(
      "INSERT INTO mcp_source (scope_id, id, name, config, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "scope-1",
      "remote-mcp",
      "Remote MCP",
      JSON.stringify({
        transport: "remote",
        endpoint: "https://example.com/mcp",
        auth: {
          kind: "oauth2",
          accessTokenSecretId: "access-token",
          refreshTokenSecretId: null,
          tokenType: "Bearer",
          expiresAt: null,
          scope: "read",
          tokenEndpoint: "https://auth.example.com/token",
        },
      }),
      now,
    );

    await expect(migrateLegacyConnections(db)).rejects.toThrow("secret(s) already owned");

    expect(
      db
        .prepare("SELECT id FROM connection WHERE scope_id = ? AND id = ?")
        .get("scope-1", "mcp-oauth2-remote-mcp"),
    ).toBeNull();
    expect(
      db
        .prepare(
          "SELECT connection_id FROM credential_binding WHERE scope_id = ? AND source_id = ?",
        )
        .all("scope-1", "remote-mcp"),
    ).toEqual([]);

    const source = db
      .prepare("SELECT config FROM mcp_source WHERE scope_id = ? AND id = ?")
      .get("scope-1", "remote-mcp") as { readonly config: string };
    expect(decodeMigratedMcpConfig(source.config).auth).toBeDefined();
  });

  it("backfills legacy OpenAPI OAuth from oauth2 column after invocation_config has been dropped", async () => {
    const db = openDatabase();
    migrate(drizzle(db), {
      migrationsFolder: join(import.meta.dirname, "../../drizzle"),
    });

    expect(columnNames(db, "openapi_source")).not.toContain("invocation_config");

    const now = Date.now();
    db.prepare(
      "INSERT INTO secret (scope_id, id, name, provider, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("scope-1", "client-id", "Client ID", "keychain", now);
    db.prepare(
      "INSERT INTO secret (scope_id, id, name, provider, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("scope-1", "client-secret", "Client secret", "keychain", now);
    db.prepare(
      "INSERT INTO secret (scope_id, id, name, provider, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("scope-1", "access-token", "Access token", "keychain", now);

    db.prepare(
      "INSERT INTO openapi_source (scope_id, id, name, spec, oauth2) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "scope-1",
      "legacy-openapi",
      "Legacy OpenAPI",
      JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Legacy", version: "1" },
        paths: {},
        components: {
          securitySchemes: {
            oauth2: {
              type: "oauth2",
              flows: {
                clientCredentials: {
                  tokenUrl: "https://example.com/oauth/token",
                  scopes: { read: "read" },
                },
              },
            },
          },
        },
      }),
      JSON.stringify({
        kind: "oauth2",
        securitySchemeName: "oauth2",
        flow: "clientCredentials",
        tokenUrl: "https://example.com/oauth/token",
        clientIdSecretId: "client-id",
        clientSecretSecretId: "client-secret",
        accessTokenSecretId: "access-token",
        refreshTokenSecretId: null,
        tokenType: "Bearer",
        expiresAt: null,
        scope: "read",
        scopes: ["read"],
      }),
    );

    await migrateLegacyConnections(db);

    const connection = db
      .prepare("SELECT id, provider, access_token_secret_id FROM connection WHERE scope_id = ?")
      .get("scope-1") as
      | { readonly id: string; readonly provider: string; readonly access_token_secret_id: string }
      | undefined;
    expect(connection?.provider).toBe("oauth2");
    expect(connection?.access_token_secret_id).toBe("access-token");
    const providerState = decodeJsonRecord(
      decodeConnectionProviderStateRow(
        db.prepare("SELECT provider_state FROM connection WHERE scope_id = ?").get("scope-1"),
      ).provider_state,
    );
    expect(providerState).toMatchObject({
      kind: "client-credentials",
      tokenEndpoint: "https://example.com/oauth/token",
      clientIdSecretId: "client-id",
      clientSecretSecretId: "client-secret",
      scopes: ["read"],
      scope: "read",
    });

    // The oauth2 column should now hold source-owned slot structure. Concrete
    // secrets and the live connection id live in core credential_binding rows.
    const source = db
      .prepare("SELECT oauth2 FROM openapi_source WHERE scope_id = ? AND id = ?")
      .get("scope-1", "legacy-openapi") as { readonly oauth2: string };
    const oauth2 = decodeMigratedOpenApiOAuth2(source.oauth2);
    expect(oauth2.kind).toBe("oauth2");
    expect(oauth2.clientIdSlot).toBe("oauth2:oauth2:client-id");
    expect(oauth2.clientSecretSlot).toBe("oauth2:oauth2:client-secret");
    expect(oauth2.connectionSlot).toBe("oauth2:oauth2:connection");

    const bindings = decodeCredentialBindingRows(
      db
        .prepare(
          "SELECT slot_key, kind, secret_id, connection_id FROM credential_binding WHERE scope_id = ? AND source_id = ? ORDER BY slot_key",
        )
        .all("scope-1", "legacy-openapi"),
    );
    expect(
      bindings.map((row) => [row.slot_key, row.kind, row.secret_id, row.connection_id]),
    ).toEqual([
      ["oauth2:oauth2:client-id", "secret", "client-id", null],
      ["oauth2:oauth2:client-secret", "secret", "client-secret", null],
      ["oauth2:oauth2:connection", "connection", null, connection?.id],
    ]);
  });

  it("fails legacy OpenAPI auth-code rows that cannot produce an authorization endpoint", async () => {
    const db = openDatabase();
    migrate(drizzle(db), {
      migrationsFolder: join(import.meta.dirname, "../../drizzle"),
    });

    db.prepare(
      "INSERT INTO openapi_source (scope_id, id, name, spec, oauth2) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "scope-1",
      "broken-openapi",
      "Broken OpenAPI",
      JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Broken", version: "1" },
        paths: {},
      }),
      JSON.stringify({
        kind: "oauth2",
        securitySchemeName: "oauth2",
        flow: "authorizationCode",
        tokenUrl: "https://example.com/oauth/token",
        clientIdSecretId: "client-id",
        clientSecretSecretId: null,
        accessTokenSecretId: "access-token",
        refreshTokenSecretId: "refresh-token",
        tokenType: "Bearer",
        expiresAt: null,
        scope: "read",
        scopes: ["read"],
      }),
    );

    await expect(migrateLegacyConnections(db)).rejects.toThrow("authorizationUrl unavailable");
  });

  it("fails legacy MCP OAuth rows that cannot produce a token endpoint", async () => {
    const db = openDatabase();
    migrate(drizzle(db), {
      migrationsFolder: join(import.meta.dirname, "../../drizzle"),
    });

    db.prepare(
      "INSERT INTO mcp_source (scope_id, id, name, config, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "scope-1",
      "broken-mcp",
      "Broken MCP",
      JSON.stringify({
        transport: "remote",
        endpoint: "https://example.com/mcp",
        auth: {
          kind: "oauth2",
          accessTokenSecretId: "access-token",
          refreshTokenSecretId: null,
          tokenType: "Bearer",
          expiresAt: null,
          scope: "read",
        },
      }),
      Date.now(),
    );

    await expect(migrateLegacyConnections(db)).rejects.toThrow("token endpoint unavailable");
  });
});
