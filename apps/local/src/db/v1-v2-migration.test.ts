import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
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
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
// Preserves every journal field (`when`, `breakpoints`, …) — drizzle's
// migrator needs them, so only `entries` is typed for the truncation filter.
const decodeJournal = (text: string) =>
  decodeUnknownJson(text) as {
    readonly entries: ReadonlyArray<{ readonly idx: number; readonly tag: string }>;
  };

let workDir: string;
let previousXdgDataHome: string | undefined;
let previousFetch: typeof globalThis.fetch;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "executor-local-v1-v2-"));
  previousXdgDataHome = process.env.XDG_DATA_HOME;
  previousFetch = globalThis.fetch;
  process.env.XDG_DATA_HOME = join(workDir, "xdg");
});

afterEach(() => {
  if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousXdgDataHome;
  globalThis.fetch = previousFetch;
  rmSync(workDir, { recursive: true, force: true });
});

const seedV1Db = async (
  dbPath: string,
  scopeId: string,
  options: {
    readonly includeSecretBackedOauth?: boolean;
    readonly includeGraphqlTool?: boolean;
    readonly includeMcpToolBinding?: boolean;
    readonly includeMcpOauth?: boolean;
    readonly jsonBlobs?: boolean;
    readonly oauthConnectionProvider?: string;
    readonly oauthProviderStateOverrides?: Record<string, unknown>;
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
    "INSERT INTO plugin_storage (id, scope_id, plugin_id, collection, key, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      "openapi-operation-stripe-charge",
      scopeId,
      "openapi",
      "operation",
      "stripe_api.charges.create",
      json({
        toolId: "stripe_api.charges.create",
        sourceId: "stripe_api",
        binding: {
          method: "post",
          pathTemplate: "/v1/charges",
          parameters: [],
        },
      }),
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

  if (options.includeMcpToolBinding) {
    await executeSql(
      client,
      "INSERT INTO source (id, scope_id, plugin_id, kind, name) VALUES (?, ?, ?, ?, ?)",
      ["axiom_mcp", scopeId, "mcp", "mcp", "Axiom MCP"],
    );
    await executeSql(
      client,
      "INSERT INTO plugin_storage (id, scope_id, plugin_id, collection, key, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "mcp-source-axiom",
        scopeId,
        "mcp",
        "source",
        "axiom_mcp",
        json({
          config: {
            endpoint: "https://mcp.axiom.co/mcp",
            headers: {
              Authorization: {
                kind: "binding",
                slot: "header:authorization",
                prefix: "Bearer ",
              },
            },
            auth: { kind: "none" },
          },
        }),
        now,
        now,
      ],
    );
    await executeSql(
      client,
      "INSERT INTO secret (id, scope_id, name, provider, owned_by_connection_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["axiom-token", scopeId, "Axiom MCP OAuth", "file", null, now],
    );
    await executeSql(
      client,
      "INSERT INTO credential_binding (id, scope_id, plugin_id, source_id, source_scope_id, slot_key, kind, text_value, secret_id, connection_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "axiom-auth",
        scopeId,
        "mcp",
        "axiom_mcp",
        scopeId,
        "header:authorization",
        "secret",
        null,
        "axiom-token",
        null,
        now,
        now,
      ],
    );
    await executeSql(
      client,
      "INSERT INTO tool (id, scope_id, source_id, plugin_id, name, description, input_schema, output_schema, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "axiom_mcp.querydataset",
        scopeId,
        "axiom_mcp",
        "mcp",
        "querydataset",
        "Query Axiom datasets",
        json({ type: "object" }),
        json({ type: "object" }),
        now,
        now,
      ],
    );
    await executeSql(
      client,
      "INSERT INTO plugin_storage (id, scope_id, plugin_id, collection, key, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "mcp-binding-axiom-querydataset",
        scopeId,
        "mcp",
        "binding",
        "axiom_mcp.querydataset",
        json({
          namespace: "axiom_mcp",
          toolId: "axiom_mcp.querydataset",
          binding: {
            toolId: "querydataset",
            toolName: "queryDataset",
            description: "Query Axiom datasets",
            inputSchema: { type: "object" },
            annotations: { title: "Query dataset", readOnlyHint: true },
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
        "graphql-operation-query-hello",
        scopeId,
        "graphql",
        "operation",
        "graphql_api.query.hello",
        json({
          toolId: "graphql_api.query.hello",
          sourceId: "graphql_api",
          binding: {
            kind: "query",
            fieldName: "hello",
            operationString: "query { hello }",
            variableNames: [],
          },
        }),
        now,
        now,
      ],
    );
  }

  if (options.includeGraphqlTool) {
    await executeSql(
      client,
      "INSERT INTO source (id, scope_id, plugin_id, kind, name) VALUES (?, ?, ?, ?, ?)",
      ["graphql_api", scopeId, "graphql", "graphql", "GraphQL API"],
    );
    await executeSql(
      client,
      "INSERT INTO plugin_storage (id, scope_id, plugin_id, collection, key, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "graphql-source-api",
        scopeId,
        "graphql",
        "source",
        "graphql_api",
        json({
          config: {
            endpoint: "https://api.example.com/graphql",
            headers: {
              Authorization: {
                kind: "binding",
                slot: "header:authorization",
                prefix: "Bearer ",
              },
            },
            auth: { kind: "none" },
          },
        }),
        now,
        now,
      ],
    );
    await executeSql(
      client,
      "INSERT INTO secret (id, scope_id, name, provider, owned_by_connection_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["graphql-token", scopeId, "GraphQL token", "file", null, now],
    );
    await executeSql(
      client,
      "INSERT INTO credential_binding (id, scope_id, plugin_id, source_id, source_scope_id, slot_key, kind, text_value, secret_id, connection_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "graphql-auth",
        scopeId,
        "graphql",
        "graphql_api",
        scopeId,
        "header:authorization",
        "secret",
        null,
        "graphql-token",
        null,
        now,
        now,
      ],
    );
    await executeSql(
      client,
      "INSERT INTO tool (id, scope_id, source_id, plugin_id, name, description, input_schema, output_schema, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "graphql_api.query.hello",
        scopeId,
        "graphql_api",
        "graphql",
        "query.hello",
        "GraphQL query",
        json({ type: "object" }),
        json({ type: "object" }),
        now,
        now,
      ],
    );
  }

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
              tokenUrl: "https://tenant.dealcloud.example/oauth/token",
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
          tokenEndpoint: "https://tenant.dealcloud.example/oauth/token",
          resource: "https://api.dealcloud.com",
          scopes: ["data"],
          ...(options.oauthProviderStateOverrides ?? {}),
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

  if (options.includeMcpOauth) {
    await executeSql(
      client,
      "INSERT INTO source (id, scope_id, plugin_id, kind, name) VALUES (?, ?, ?, ?, ?)",
      ["pscale_mcp", scopeId, "mcp", "mcp", "PlanetScale MCP"],
    );
    await executeSql(
      client,
      "INSERT INTO plugin_storage (id, scope_id, plugin_id, collection, key, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "mcp-source-pscale",
        scopeId,
        "mcp",
        "source",
        "pscale_mcp",
        json({
          config: {
            endpoint: "https://mcp.pscale.dev/mcp/planetscale",
            transport: "remote",
            auth: { kind: "oauth2", connectionSlot: "auth:oauth2:connection" },
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
        "pscale-oauth",
        scopeId,
        options.oauthConnectionProvider ?? "oauth2",
        "PlanetScale MCP OAuth",
        "pscale-access",
        "pscale-refresh",
        now + 60_000,
        json({
          kind: "authorization-code",
          clientId: "pscale-client",
          tokenEndpoint: "https://auth.pscale.dev/oauth/token",
          authorizationServerUrl: "https://mcp.pscale.dev/oauth/authorize",
          resource: "https://mcp.pscale.dev",
          scopes: ["read"],
        }),
      ],
    );
    await executeSql(
      client,
      "INSERT INTO credential_binding (id, scope_id, plugin_id, source_id, source_scope_id, slot_key, kind, text_value, secret_id, connection_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "pscale-auth",
        scopeId,
        "mcp",
        "pscale_mcp",
        scopeId,
        "auth:oauth2:connection",
        "connection",
        null,
        null,
        "pscale-oauth",
        now,
        now,
      ],
    );
    for (const [id, name] of [
      ["pscale-access", "PlanetScale access token"],
      ["pscale-refresh", "PlanetScale refresh token"],
    ] as const) {
      await executeSql(
        client,
        "INSERT INTO secret (id, scope_id, name, provider, owned_by_connection_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [id, scopeId, name, "file", "pscale-oauth", now],
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
        name: "stripeKey",
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
        connection: "stripeKey",
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
        connection: "stripeKey",
        plugin_id: "openapi",
        name: "Charge",
        schema: JSON.stringify({ type: "object", properties: { id: { type: "string" } } }),
      },
    ]);

    const pluginStorage = await client.execute(
      "SELECT tenant, owner, subject, plugin_id, collection, key, data FROM plugin_storage WHERE plugin_id = 'onepassword'",
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

  it("preserves migrated tool slugs and stamps MCP tools with their upstream binding", async () => {
    const scopeId = "executor-workspace-abcd1234";
    const tenantId = "executor-workspace-abcd1234";
    const dataDir = join(workDir, "data");
    const dbPath = join(dataDir, "data.db");
    mkdirSync(dataDir, { recursive: true });
    await seedV1Db(dbPath, scopeId, { includeGraphqlTool: true, includeMcpToolBinding: true });

    const authDir = join(process.env.XDG_DATA_HOME!, "executor");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(
      join(authDir, "auth.json"),
      JSON.stringify(
        {
          [scopeId]: {
            "stripe-key": "sk_test_123",
            "axiom-token": "axiom-access-token",
            "graphql-token": "graphql-access-token",
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

    const client = await openLocalLibsql(dbPath);
    const migratedToolNames = await client.execute(
      "SELECT integration, plugin_id, name FROM tool ORDER BY integration, name",
    );
    expect(migratedToolNames.rows).toEqual([
      { integration: "axiom_mcp", plugin_id: "mcp", name: "querydataset" },
      { integration: "graphql_api", plugin_id: "graphql", name: "query.hello" },
      { integration: "stripe_api", plugin_id: "openapi", name: "charges.create" },
    ]);

    const operationRows = await client.execute(
      "SELECT tenant, owner, subject, plugin_id, collection, key, data FROM plugin_storage WHERE collection = 'operation' ORDER BY plugin_id, key",
    );
    expect(operationRows.rows).toEqual([
      {
        tenant: tenantId,
        owner: "org",
        subject: "",
        plugin_id: "graphql",
        collection: "operation",
        key: "graphql_api.query.hello",
        data: JSON.stringify({
          integration: "graphql_api",
          toolName: "query.hello",
          binding: {
            kind: "query",
            fieldName: "hello",
            operationString: "query { hello }",
            variableNames: [],
          },
        }),
      },
      {
        tenant: tenantId,
        owner: "org",
        subject: "",
        plugin_id: "openapi",
        collection: "operation",
        key: "stripe_api.charges.create",
        data: JSON.stringify({
          integration: "stripe_api",
          toolName: "charges.create",
          binding: {
            method: "post",
            pathTemplate: "/v1/charges",
            parameters: [],
          },
        }),
      },
    ]);

    const rows = await client.execute(
      "SELECT connection, name, annotations FROM tool WHERE integration = 'axiom_mcp'",
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      connection: "axiomMcpOauth",
      name: "querydataset",
    });

    const annotations = decodeUnknownJson(String(rows.rows[0]!.annotations));
    expect(annotations).toMatchObject({
      requiresApproval: false,
      mcp: {
        toolName: "queryDataset",
        upstream: {
          title: "Query dataset",
          readOnlyHint: true,
        },
      },
    });
    client.close();
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
        token_url: "https://tenant.dealcloud.example/oauth/token",
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
      name: "dealcloudApi",
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

  it("resolves v1 OAuth authorization-server metadata URLs before writing oauth_client rows", async () => {
    const scopeId = "executor-workspace-abcd1234";
    const tenantId = "executor-workspace-abcd1234";
    const metadataUrl =
      "https://mcp.pscale.dev/.well-known/oauth-authorization-server/mcp/planetscale";
    const dataDir = join(workDir, "data");
    const dbPath = join(dataDir, "data.db");
    mkdirSync(dataDir, { recursive: true });
    await seedV1Db(dbPath, scopeId, {
      includeSecretBackedOauth: true,
      oauthConnectionProvider: "oauth2",
      oauthProviderStateOverrides: {
        kind: "dynamic-dcr",
        authorizationServerUrl: "https://mcp.pscale.dev/mcp/planetscale",
        authorizationServerMetadataUrl: metadataUrl,
        resource: "https://mcp.pscale.dev/mcp/planetscale",
      },
    });

    const authDir = join(process.env.XDG_DATA_HOME!, "executor");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(
      join(authDir, "auth.json"),
      JSON.stringify({
        [scopeId]: {
          "dealcloud-access": "old-access-token",
          "dealcloud-client-id": "dealcloud-client",
          "dealcloud-client-secret": "dealcloud-secret",
        },
      }),
    );

    const seenMetadataUrls: string[] = [];
    const oauthMetadataFetch: typeof globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        seenMetadataUrls.push(String(input));
        return new Response(
          JSON.stringify({
            issuer: "https://api.planetscale.com",
            authorization_endpoint: "https://app.planetscale.com/oauth/authorize",
            token_endpoint: "https://auth.planetscale.com/oauth/token",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    const result = await migrateLocalV1ToV2IfNeeded({
      sqlitePath: dbPath,
      tables: collectTables(),
      namespace: "executor_local",
      tenantId,
      oauthMetadataFetch,
    });

    expect(result.migrated).toBe(true);
    expect(seenMetadataUrls).toEqual([metadataUrl]);

    const client = await openLocalLibsql(dbPath);
    const oauthClients = await client.execute(
      "SELECT slug, grant, authorization_url, resource FROM oauth_client",
    );
    expect(oauthClients.rows).toEqual([
      {
        slug: "dealcloud",
        grant: "authorization_code",
        authorization_url: "https://app.planetscale.com/oauth/authorize",
        resource: "https://mcp.pscale.dev/mcp/planetscale",
      },
    ]);
    client.close();
  });

  it("discovers MCP OAuth protected-resource metadata before writing oauth_client rows", async () => {
    const scopeId = "executor-workspace-abcd1234";
    const tenantId = "executor-workspace-abcd1234";
    const dataDir = join(workDir, "data");
    const dbPath = join(dataDir, "data.db");
    mkdirSync(dataDir, { recursive: true });
    await seedV1Db(dbPath, scopeId, { includeMcpOauth: true });

    const authDir = join(process.env.XDG_DATA_HOME!, "executor");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(
      join(authDir, "auth.json"),
      JSON.stringify({
        [scopeId]: {
          "stripe-key": "sk_test_123",
          "pscale-access": "old-access-token",
          "pscale-refresh": "old-refresh-token",
        },
      }),
    );

    const seenResourceUrls: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = String(input);
        seenResourceUrls.push(url);
        if (url.includes("/.well-known/oauth-protected-resource")) {
          return new Response(
            JSON.stringify({ resource: "https://mcp.pscale.dev/mcp/planetscale" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
      },
      { preconnect: previousFetch.preconnect },
    );

    const result = await migrateLocalV1ToV2IfNeeded({
      sqlitePath: dbPath,
      tables: collectTables(),
      namespace: "executor_local",
      tenantId,
    });

    expect(result.migrated).toBe(true);
    expect(seenResourceUrls).toContain(
      "https://mcp.pscale.dev/.well-known/oauth-protected-resource/mcp/planetscale",
    );

    const client = await openLocalLibsql(dbPath);
    const oauthClients = await client.execute(
      "SELECT slug, authorization_url, token_url, resource FROM oauth_client WHERE slug = 'pscale'",
    );
    expect(oauthClients.rows).toEqual([
      {
        slug: "pscale",
        authorization_url: "https://mcp.pscale.dev/oauth/authorize",
        token_url: "https://auth.pscale.dev/oauth/token",
        resource: "https://mcp.pscale.dev/mcp/planetscale",
      },
    ]);
    client.close();
  });

  // Regression: a database last touched by a release OLDER than v1-final
  // (pre-0011 — no `plugin_storage` table) must be replayed through the
  // bundled legacy drizzle chain before the v1→v2 data migration reads it.
  // Without the replay, migration crashed with "no such table: plugin_storage"
  // on every fresh 1.5.0 install over old data.
  it("replays the legacy drizzle chain for a v1 database that predates v1-final", async () => {
    const scopeId = "executor-workspace-abcd1234";
    const dataDir = join(workDir, "data");
    const dbPath = join(dataDir, "data.db");
    mkdirSync(dataDir, { recursive: true });

    // Build a REAL pre-0011 v1 database: apply the vendored legacy chain
    // truncated after 0010, so drizzle records the genuine hashes and the
    // schema has per-plugin source tables but no `plugin_storage`.
    const legacyDir = join(import.meta.dirname, "../../drizzle-legacy-v1");
    const truncatedDir = join(workDir, "legacy-truncated");
    mkdirSync(join(truncatedDir, "meta"), { recursive: true });
    const journal = decodeJournal(
      readFileSync(join(legacyDir, "meta", "_journal.json")).toString(),
    );
    const kept = journal.entries.filter((entry) => entry.idx <= 10);
    for (const entry of kept) {
      writeFileSync(
        join(truncatedDir, `${entry.tag}.sql`),
        readFileSync(join(legacyDir, `${entry.tag}.sql`)),
      );
    }
    writeFileSync(
      join(truncatedDir, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: kept }),
    );

    const seed = await openLocalLibsql(dbPath);
    await migrate(drizzle({ client: seed }), { migrationsFolder: truncatedDir });
    const missing = await seed.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plugin_storage'",
    );
    expect(missing.rows).toEqual([]); // genuinely pre-0011
    const now = Date.now();
    await executeSql(
      seed,
      "INSERT INTO source (id, scope_id, plugin_id, kind, name, url, can_remove, can_refresh, can_edit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?)",
      ["context7", scopeId, "mcp", "mcp", "Context7", "https://mcp.context7.com/mcp", now, now],
    );
    await executeSql(
      seed,
      "INSERT INTO mcp_source (id, scope_id, name, config, created_at) VALUES (?, ?, ?, ?, ?)",
      [
        "context7",
        scopeId,
        "Context7",
        JSON.stringify({ transport: "remote", endpoint: "https://mcp.context7.com/mcp" }),
        now,
      ],
    );
    seed.close();

    const result = await migrateLocalV1ToV2IfNeeded({
      sqlitePath: dbPath,
      tables: collectTables(),
      namespace: "executor_local",
      tenantId: scopeId,
    });

    expect(result.migrated).toBe(true);
    const client = await openLocalLibsql(dbPath);
    const integrations = await client.execute("SELECT tenant, slug, plugin_id FROM integration");
    expect(integrations.rows).toEqual([{ tenant: scopeId, slug: "context7", plugin_id: "mcp" }]);
    client.close();
  });
});
