// End-to-end tests for the MCP credential migrations. These seed the old
// config JSON shape, run the full migration runner, and assert the final
// runtime model only contains source-owned slots plus core credential_binding
// rows.

import { afterEach, describe, expect, it } from "@effect/vitest";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Schema } from "effect";

import { PRE_0007_SQL, stampPriorMigrationsApplied } from "./__test-helpers__/pre-0007-schema";

const MIGRATIONS_FOLDER = join(import.meta.dirname, "../../drizzle");

const ConfigJson = Schema.fromJsonString(
  Schema.Struct({
    auth: Schema.optional(Schema.Unknown),
    command: Schema.optional(Schema.String),
    endpoint: Schema.optional(Schema.String),
    transport: Schema.String,
  }),
);

const decodeConfigJson = Schema.decodeUnknownSync(ConfigJson);

const tempDirs: Array<string> = [];

const makeDbPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-mig-"));
  tempDirs.push(dir);
  return join(dir, "test.sqlite");
};

describe("mcp credential migrations", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("moves header auth into an auth slot and credential binding", () => {
    const dbPath = makeDbPath();
    const db = new Database(dbPath);
    db.exec(PRE_0007_SQL);
    stampPriorMigrationsApplied(db);

    db.prepare(
      "INSERT INTO mcp_source (scope_id, id, name, config, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "default-scope",
      "remote-headers",
      "Remote Headers",
      JSON.stringify({
        transport: "remote",
        endpoint: "https://example.com/mcp",
        auth: {
          kind: "header",
          headerName: "X-API-Key",
          secretId: "tok-secret",
          prefix: "Bearer ",
        },
      }),
      Date.now(),
    );

    db.close();
    const drizzleDb = drizzle(new Database(dbPath));
    migrate(drizzleDb, { migrationsFolder: MIGRATIONS_FOLDER });

    const after = new Database(dbPath, { readonly: true });
    const row = after
      .prepare(
        "SELECT auth_kind, auth_header_name, auth_header_slot, auth_header_prefix, config FROM mcp_source WHERE id = ?",
      )
      .get("remote-headers") as {
      auth_kind: string;
      auth_header_name: string;
      auth_header_slot: string;
      auth_header_prefix: string;
      config: string;
    };
    expect(row.auth_kind).toBe("header");
    expect(row.auth_header_name).toBe("X-API-Key");
    expect(row.auth_header_slot).toBe("auth:header");
    expect(row.auth_header_prefix).toBe("Bearer ");
    const binding = after
      .prepare(
        "SELECT slot_key, kind, secret_id FROM credential_binding WHERE plugin_id = ? AND source_id = ? AND slot_key = ?",
      )
      .get("mcp", "remote-headers", "auth:header") as Record<string, string>;
    expect(binding).toMatchObject({
      slot_key: "auth:header",
      kind: "secret",
      secret_id: "tok-secret",
    });
    // The auth key should be stripped from config json after migration.
    const config = decodeConfigJson(row.config);
    expect(config.auth).toBeUndefined();
    expect(config.transport).toBe("remote");
    expect(config.endpoint).toBe("https://example.com/mcp");
    after.close();
  });

  it("moves oauth2 auth and request credentials into slots and bindings", () => {
    const dbPath = makeDbPath();
    const db = new Database(dbPath);
    db.exec(PRE_0007_SQL);
    stampPriorMigrationsApplied(db);

    db.prepare(
      "INSERT INTO mcp_source (scope_id, id, name, config, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "default-scope",
      "remote-oauth",
      "Remote OAuth",
      JSON.stringify({
        transport: "remote",
        endpoint: "https://oauth.example/mcp",
        headers: {
          "X-Trace": "static",
          "X-Token": { secretId: "extra-tok" },
        },
        queryParams: {
          org: { secretId: "org-id-secret" },
        },
        auth: {
          kind: "oauth2",
          connectionId: "conn-1",
          clientIdSecretId: "client-id-sec",
          clientSecretSecretId: "client-secret-sec",
        },
      }),
      Date.now(),
    );

    db.close();
    const drizzleDb = drizzle(new Database(dbPath));
    migrate(drizzleDb, { migrationsFolder: MIGRATIONS_FOLDER });

    const after = new Database(dbPath, { readonly: true });
    const row = after
      .prepare(
        "SELECT auth_kind, auth_connection_slot, auth_client_id_slot, auth_client_secret_slot FROM mcp_source WHERE id = ?",
      )
      .get("remote-oauth") as Record<string, string | null>;
    expect(row.auth_kind).toBe("oauth2");
    expect(row.auth_connection_slot).toBe("auth:oauth2:connection");
    expect(row.auth_client_id_slot).toBe("auth:oauth2:client-id");
    expect(row.auth_client_secret_slot).toBe("auth:oauth2:client-secret");

    const authBindings = after
      .prepare(
        "SELECT slot_key, kind, secret_id, connection_id FROM credential_binding WHERE plugin_id = ? AND source_id = ? ORDER BY slot_key",
      )
      .all("mcp", "remote-oauth") as ReadonlyArray<Record<string, string | null>>;
    const bySlot = new Map(authBindings.map((binding) => [binding.slot_key, binding]));
    expect(bySlot.get("auth:oauth2:connection")).toMatchObject({
      kind: "connection",
      connection_id: "conn-1",
    });
    expect(bySlot.get("auth:oauth2:client-id")).toMatchObject({
      kind: "secret",
      secret_id: "client-id-sec",
    });
    expect(bySlot.get("auth:oauth2:client-secret")).toMatchObject({
      kind: "secret",
      secret_id: "client-secret-sec",
    });

    const headers = after
      .prepare(
        "SELECT name, kind, text_value, slot_key, prefix FROM mcp_source_header WHERE source_id = ? ORDER BY name",
      )
      .all("remote-oauth") as ReadonlyArray<Record<string, string | null>>;
    expect(headers).toHaveLength(2);
    const byName = new Map(headers.map((h) => [h.name, h]));
    expect(byName.get("X-Trace")).toMatchObject({
      kind: "text",
      text_value: "static",
    });
    expect(byName.get("X-Token")).toMatchObject({
      kind: "binding",
      slot_key: "header:x-token",
    });
    expect(bySlot.get("header:x-token")).toMatchObject({
      kind: "secret",
      secret_id: "extra-tok",
    });

    const params = after
      .prepare("SELECT name, kind, slot_key FROM mcp_source_query_param WHERE source_id = ?")
      .all("remote-oauth") as ReadonlyArray<Record<string, string>>;
    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({
      name: "org",
      kind: "binding",
      slot_key: "query_param:org",
    });
    expect(bySlot.get("query_param:org")).toMatchObject({
      kind: "secret",
      secret_id: "org-id-secret",
    });

    after.close();
  });

  it("fails instead of silently collapsing colliding legacy header slots", () => {
    const dbPath = makeDbPath();
    const db = new Database(dbPath);
    db.exec(PRE_0007_SQL);
    stampPriorMigrationsApplied(db);

    db.prepare(
      "INSERT INTO mcp_source (scope_id, id, name, config, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "default-scope",
      "collision",
      "Collision",
      JSON.stringify({
        transport: "remote",
        endpoint: "https://example.com/mcp",
        headers: {
          x_token: { secretId: "sec-underscore" },
          "x-token": { secretId: "sec-dash" },
        },
      }),
      Date.now(),
    );

    db.close();
    const sqlite = new Database(dbPath);
    const drizzleDb = drizzle(sqlite);
    expect(() => migrate(drizzleDb, { migrationsFolder: MIGRATIONS_FOLDER })).toThrow();
    sqlite.close();
  });

  it("leaves stdio sources alone (no auth, no headers, no queryParams)", () => {
    const dbPath = makeDbPath();
    const db = new Database(dbPath);
    db.exec(PRE_0007_SQL);
    stampPriorMigrationsApplied(db);

    db.prepare(
      "INSERT INTO mcp_source (scope_id, id, name, config, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "default-scope",
      "stdio-only",
      "Stdio",
      JSON.stringify({
        transport: "stdio",
        command: "/usr/bin/server",
        args: ["--flag"],
      }),
      Date.now(),
    );

    db.close();
    const drizzleDb = drizzle(new Database(dbPath));
    migrate(drizzleDb, { migrationsFolder: MIGRATIONS_FOLDER });

    const after = new Database(dbPath, { readonly: true });
    const row = after
      .prepare("SELECT auth_kind, auth_header_slot, config FROM mcp_source WHERE id = ?")
      .get("stdio-only") as {
      auth_kind: string;
      auth_header_slot: string | null;
      config: string;
    };
    expect(row.auth_kind).toBe("none");
    expect(row.auth_header_slot).toBeNull();
    const config = decodeConfigJson(row.config);
    expect(config.transport).toBe("stdio");
    expect(config.command).toBe("/usr/bin/server");
    after.close();
  });
});
