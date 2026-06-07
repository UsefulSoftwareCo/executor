import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";

import { collectTables } from "@executor-js/api/server";
import { migratedItemId } from "@executor-js/sdk/migration";

import { executeSql, openLocalLibsql } from "./libsql";
import { migrateLocalV1ToV2IfNeeded } from "./v1-v2-migration";

const AuthFile = Schema.Record(Schema.String, Schema.String);
const decodeAuthFile = Schema.decodeUnknownSync(Schema.fromJsonString(AuthFile));

let workDir: string;
let previousXdgDataHome: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "executor-local-v1-v2-"));
  previousXdgDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(workDir, "xdg");
});

afterEach(() => {
  if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousXdgDataHome;
  rmSync(workDir, { recursive: true, force: true });
});

const seedV1Db = async (
  dbPath: string,
  scopeId: string,
  options: {
    readonly includeSecretBackedOauth?: boolean;
    readonly jsonBlobs?: boolean;
    readonly oauthConnectionProvider?: string;
  } = {},
) => {
  const client = await openLocalLibsql(dbPath);
  await client.execute("PRAGMA foreign_keys = OFF");
  await client.execute(`
    CREATE TABLE source (
      id text NOT NULL,
      scope_id text NOT NULL,
      plugin_id text NOT NULL,
      kind text NOT NULL,
      name text NOT NULL,
      PRIMARY KEY(scope_id, id)
    )
  `);
  await client.execute(`
    CREATE TABLE plugin_storage (
      id text NOT NULL,
      scope_id text NOT NULL,
      plugin_id text NOT NULL,
      collection text NOT NULL,
      key text NOT NULL,
      data text NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      PRIMARY KEY(scope_id, id)
    )
  `);
  await client.execute(`
    CREATE TABLE credential_binding (
      id text NOT NULL,
      scope_id text NOT NULL,
      plugin_id text NOT NULL,
      source_id text NOT NULL,
      source_scope_id text NOT NULL,
      slot_key text NOT NULL,
      kind text NOT NULL,
      text_value text,
      secret_id text,
      connection_id text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      PRIMARY KEY(scope_id, id)
    )
  `);
  await client.execute(`
    CREATE TABLE secret (
      id text NOT NULL,
      scope_id text NOT NULL,
      name text NOT NULL,
      provider text NOT NULL,
      owned_by_connection_id text,
      created_at integer NOT NULL,
      PRIMARY KEY(scope_id, id)
    )
  `);
  await client.execute(`
    CREATE TABLE connection (
      id text NOT NULL,
      scope_id text NOT NULL,
      provider text NOT NULL,
      identity_label text,
      access_token_secret_id text,
      refresh_token_secret_id text,
      expires_at integer,
      provider_state text,
      PRIMARY KEY(scope_id, id)
    )
  `);
  await client.execute(`
    CREATE TABLE tool_policy (
      id text NOT NULL,
      scope_id text NOT NULL,
      pattern text NOT NULL,
      action text NOT NULL,
      position text NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      PRIMARY KEY(scope_id, id)
    )
  `);
  await client.execute(`
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
      updated_at integer NOT NULL,
      PRIMARY KEY(scope_id, id)
    )
  `);
  await client.execute(`
    CREATE TABLE definition (
      id text NOT NULL,
      scope_id text NOT NULL,
      source_id text NOT NULL,
      plugin_id text NOT NULL,
      name text NOT NULL,
      schema text NOT NULL,
      created_at integer NOT NULL,
      PRIMARY KEY(scope_id, id)
    )
  `);
  await client.execute(`
    CREATE TABLE blob (
      namespace text NOT NULL,
      key text NOT NULL,
      value text NOT NULL,
      row_id text NOT NULL,
      id text NOT NULL,
      PRIMARY KEY(id)
    )
  `);

  const now = Date.now();
  const json = (value: unknown): string | Buffer => {
    const text = JSON.stringify(value);
    return options.jsonBlobs ? Buffer.from(text) : text;
  };

  await executeSql(
    client,
    "INSERT INTO source (id, scope_id, plugin_id, kind, name) VALUES (?, ?, ?, ?, ?)",
    ["stripe_api", scopeId, "openapi", "openapi", "Stripe"],
  );
  await executeSql(
    client,
    "INSERT INTO plugin_storage (id, scope_id, plugin_id, collection, key, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      "openapi-source-stripe",
      scopeId,
      "openapi",
      "source",
      "stripe_api",
      json({
        config: {
          spec: "{}",
          headers: {
            Authorization: {
              kind: "binding",
              slot: "header:authorization",
              prefix: "Bearer ",
            },
          },
        },
      }),
      now,
      now,
    ],
  );
  await executeSql(
    client,
    "INSERT INTO plugin_storage (id, scope_id, plugin_id, collection, key, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      "provider-settings",
      scopeId,
      "onepassword",
      "settings",
      "config",
      json({ vaultId: "vault-123" }),
      now,
      now,
    ],
  );
  await executeSql(
    client,
    "INSERT INTO credential_binding (id, scope_id, plugin_id, source_id, source_scope_id, slot_key, kind, text_value, secret_id, connection_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      "stripe-auth",
      scopeId,
      "openapi",
      "stripe_api",
      scopeId,
      "header:authorization",
      "secret",
      null,
      "stripe-key",
      null,
      now,
      now,
    ],
  );
  await executeSql(
    client,
    "INSERT INTO secret (id, scope_id, name, provider, owned_by_connection_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ["stripe-key", scopeId, "Stripe key", "file", null, now],
  );
  await executeSql(
    client,
    "INSERT INTO tool_policy (id, scope_id, pattern, action, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ["policy-1", scopeId, "stripe_api.charges.create", "approve", "a0", now, now],
  );
  await executeSql(
    client,
    "INSERT INTO tool (id, scope_id, source_id, plugin_id, name, description, input_schema, output_schema, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      "stripe_api.charges.create",
      scopeId,
      "stripe_api",
      "openapi",
      "charges.create",
      "Create a charge",
      json({ type: "object" }),
      json({ type: "object" }),
      now,
      now,
    ],
  );
  await executeSql(
    client,
    "INSERT INTO definition (id, scope_id, source_id, plugin_id, name, schema, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      "stripe_api.Charge",
      scopeId,
      "stripe_api",
      "openapi",
      "Charge",
      json({ type: "object", properties: { id: { type: "string" } } }),
      now,
    ],
  );
  await executeSql(
    client,
    "INSERT INTO blob (namespace, key, value, row_id, id) VALUES (?, ?, ?, ?, ?)",
    [
      `${scopeId}/onepassword`,
      "config",
      JSON.stringify({ vaultId: "vault-123" }),
      "blob-row",
      JSON.stringify([`${scopeId}/onepassword`, "config"]),
    ],
  );

  if (options.includeSecretBackedOauth) {
    await executeSql(
      client,
      "INSERT INTO source (id, scope_id, plugin_id, kind, name) VALUES (?, ?, ?, ?, ?)",
      ["dealcloud_api", scopeId, "openapi", "openapi", "DealCloud"],
    );
    await executeSql(
      client,
      "INSERT INTO plugin_storage (id, scope_id, plugin_id, collection, key, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "openapi-source-dealcloud",
        scopeId,
        "openapi",
        "source",
        "dealcloud_api",
        json({
          config: {
            spec: "{}",
            oauth2: {
              securitySchemeName: "dealCloudOAuth",
              flow: "clientCredentials",
              tokenUrl: "https://resolve.dealcloud.com/oauth/token",
              scopes: ["data"],
            },
          },
        }),
        now,
        now,
      ],
    );
    await executeSql(
      client,
      "INSERT INTO connection (id, scope_id, provider, identity_label, access_token_secret_id, refresh_token_secret_id, expires_at, provider_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "dealcloud-oauth",
        scopeId,
        options.oauthConnectionProvider ?? "file",
        "DealCloud API",
        "dealcloud-access",
        null,
        null,
        json({
          kind: "client-credentials",
          clientIdSecretId: "dealcloud-client-id",
          clientIdSecretScopeId: scopeId,
          clientSecretSecretId: "dealcloud-client-secret",
          clientSecretSecretScopeId: scopeId,
          tokenEndpoint: "https://resolve.dealcloud.com/oauth/token",
          resource: "https://api.dealcloud.com",
          scopes: ["data"],
        }),
      ],
    );
    await executeSql(
      client,
      "INSERT INTO credential_binding (id, scope_id, plugin_id, source_id, source_scope_id, slot_key, kind, text_value, secret_id, connection_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "dealcloud-auth",
        scopeId,
        "openapi",
        "dealcloud_api",
        scopeId,
        "oauth2:dealcloudoauth:connection",
        "connection",
        null,
        null,
        "dealcloud-oauth",
        now,
        now,
      ],
    );
    for (const [id, name, owner] of [
      ["dealcloud-access", "DealCloud access token", "dealcloud-oauth"],
      ["dealcloud-client-id", "DealCloud client id", null],
      ["dealcloud-client-secret", "DealCloud client secret", null],
    ] as const) {
      await executeSql(
        client,
        "INSERT INTO secret (id, scope_id, name, provider, owned_by_connection_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [id, scopeId, name, "file", owner, now],
      );
    }
  }
  client.close();
};

describe("local v1 -> v2 migration", () => {
  it("moves a scoped v1 DB to a v2 DB and re-keys file auth.json", async () => {
    const scopeId = "executor-workspace-abcd1234";
    const tenantId = "executor-workspace-abcd1234";
    const dataDir = join(workDir, "data");
    const dbPath = join(dataDir, "data.db");
    mkdirSync(dataDir, { recursive: true });
    await seedV1Db(dbPath, scopeId);

    const authDir = join(process.env.XDG_DATA_HOME!, "executor");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(
      join(authDir, "auth.json"),
      JSON.stringify({ [scopeId]: { "stripe-key": "sk_test_123" } }, null, 2),
    );

    const result = await migrateLocalV1ToV2IfNeeded({
      sqlitePath: dbPath,
      tables: collectTables(),
      namespace: "executor_local",
      tenantId,
    });

    expect(result.migrated).toBe(true);
    expect(result.backupPath).toBeDefined();
    expect(result.report).toMatchObject({ integrations: 1, connections: 1, secretOps: 1 });

    const client = await openLocalLibsql(dbPath);
    const integrations = await client.execute("SELECT tenant, slug, plugin_id FROM integration");
    expect(integrations.rows).toEqual([
      { tenant: tenantId, slug: "stripe_api", plugin_id: "openapi" },
    ]);

    const connections = await client.execute(
      "SELECT tenant, owner, subject, integration, name, provider, item_ids FROM connection",
    );
    const itemId = migratedItemId(scopeId, "stripe-key");
    expect(connections.rows).toEqual([
      {
        tenant: tenantId,
        owner: "org",
        subject: "",
        integration: "stripe_api",
        name: "api-key",
        provider: "file",
        item_ids: JSON.stringify({ token: itemId }),
      },
    ]);

    const policies = await client.execute("SELECT pattern, action FROM tool_policy");
    expect(policies.rows).toEqual([
      { pattern: "stripe_api.*.*.charges.create", action: "approve" },
    ]);

    const tools = await client.execute(
      "SELECT tenant, owner, subject, integration, connection, plugin_id, name, input_schema FROM tool",
    );
    expect(tools.rows).toEqual([
      {
        tenant: tenantId,
        owner: "org",
        subject: "",
        integration: "stripe_api",
        connection: "api-key",
        plugin_id: "openapi",
        name: "charges.create",
        input_schema: JSON.stringify({ type: "object" }),
      },
    ]);

    const definitions = await client.execute(
      "SELECT tenant, owner, subject, integration, connection, plugin_id, name, schema FROM definition",
    );
    expect(definitions.rows).toEqual([
      {
        tenant: tenantId,
        owner: "org",
        subject: "",
        integration: "stripe_api",
        connection: "api-key",
        plugin_id: "openapi",
        name: "Charge",
        schema: JSON.stringify({ type: "object", properties: { id: { type: "string" } } }),
      },
    ]);

    const pluginStorage = await client.execute(
      "SELECT tenant, owner, subject, plugin_id, collection, key, data FROM plugin_storage",
    );
    expect(pluginStorage.rows).toEqual([
      {
        tenant: tenantId,
        owner: "org",
        subject: "",
        plugin_id: "onepassword",
        collection: "settings",
        key: "config",
        data: JSON.stringify({ vaultId: "vault-123" }),
      },
    ]);

    const blobs = await client.execute("SELECT namespace, key, value FROM blob");
    expect(blobs.rows).toEqual([
      {
        namespace: `o:${tenantId}/onepassword`,
        key: "config",
        value: JSON.stringify({ vaultId: "vault-123" }),
      },
    ]);
    client.close();

    const auth = decodeAuthFile(readFileSync(join(authDir, "auth.json"), "utf-8"));
    expect(auth[itemId]).toBe("sk_test_123");
  });

  it("resolves secret-backed v1 OAuth client ids into v2 oauth_client rows", async () => {
    const scopeId = "executor-workspace-abcd1234";
    const tenantId = "executor-workspace-abcd1234";
    const dataDir = join(workDir, "data");
    const dbPath = join(dataDir, "data.db");
    mkdirSync(dataDir, { recursive: true });
    await seedV1Db(dbPath, scopeId, {
      includeSecretBackedOauth: true,
      jsonBlobs: true,
      oauthConnectionProvider: "oauth2",
    });

    const authDir = join(process.env.XDG_DATA_HOME!, "executor");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(
      join(authDir, "auth.json"),
      JSON.stringify(
        {
          [scopeId]: {
            "stripe-key": "sk_test_123",
            "dealcloud-access": "old-access-token",
            "dealcloud-client-id": "dealcloud-client",
            "dealcloud-client-secret": "dealcloud-secret",
          },
        },
        null,
        2,
      ),
    );

    const result = await migrateLocalV1ToV2IfNeeded({
      sqlitePath: dbPath,
      tables: collectTables(),
      namespace: "executor_local",
      tenantId,
    });

    expect(result.migrated).toBe(true);
    expect(result.report).toMatchObject({
      integrations: 2,
      connections: 2,
      oauthClients: 1,
      secretOps: 3,
    });

    const client = await openLocalLibsql(dbPath);
    const oauthClients = await client.execute(
      "SELECT slug, grant, client_id, client_secret_item_id, token_url, authorization_url, resource FROM oauth_client",
    );
    const clientSecretItemId = migratedItemId(scopeId, "dealcloud-client-secret");
    expect(oauthClients.rows).toEqual([
      {
        slug: "dealcloud",
        grant: "client_credentials",
        client_id: "dealcloud-client",
        client_secret_item_id: clientSecretItemId,
        token_url: "https://resolve.dealcloud.com/oauth/token",
        authorization_url: "",
        resource: "https://api.dealcloud.com",
      },
    ]);

    const connections = await client.execute(
      "SELECT integration, name, template, provider, item_ids, oauth_client, oauth_client_owner, refresh_item_id, oauth_scope, expires_at FROM connection WHERE integration = 'dealcloud_api'",
    );
    const accessItemId = migratedItemId(scopeId, "dealcloud-access");
    expect(connections.rows).toHaveLength(1);
    expect(connections.rows[0]).toMatchObject({
      integration: "dealcloud_api",
      name: "dealcloud-api",
      template: "dealCloudOAuth",
      provider: "file",
      item_ids: JSON.stringify({ token: accessItemId }),
      oauth_client: "dealcloud",
      oauth_client_owner: "org",
      refresh_item_id: null,
      oauth_scope: "data",
    });
    expect(Number(connections.rows[0]!.expires_at)).toBeGreaterThan(Date.now());
    client.close();

    const auth = decodeAuthFile(readFileSync(join(authDir, "auth.json"), "utf-8"));
    expect(auth[accessItemId]).toBe("old-access-token");
    expect(auth[clientSecretItemId]).toBe("dealcloud-secret");
    expect(auth["dealcloud-client-id"]).toBeUndefined();
  });
});
