// End-to-end tests for the MCP credential migrations. These seed the old
// config JSON shape, run the full migration runner, and assert the final
// runtime model only contains source-owned slots plus core credential_binding
// rows.

import { afterEach, describe, expect, it } from "@effect/vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Schema } from "effect";

import { openTestDb, runMigrations } from "./__test-helpers__/libsql-test-db";
import { PRE_0007_SQL, stampPriorMigrationsApplied } from "./__test-helpers__/pre-0007-schema";

const MIGRATIONS_FOLDER = join(import.meta.dirname, "../../drizzle");

const PluginStorageRow = Schema.Struct({ data: Schema.String });
const decodePluginStorageRow = Schema.decodeUnknownSync(PluginStorageRow);
const decodePluginStorageData = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

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

  it("moves header auth into an auth slot and credential binding", async () => {
    const dbPath = makeDbPath();
    const db = openTestDb(dbPath);
    await db.exec(PRE_0007_SQL);
    await stampPriorMigrationsApplied(db);

    await db
      .prepare(
        "INSERT INTO mcp_source (scope_id, id, name, config, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
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
    await runMigrations(dbPath, MIGRATIONS_FOLDER);

    const after = openTestDb(dbPath);
    const source = decodePluginStorageData(
      decodePluginStorageRow(
        await after
          .prepare(
            "SELECT data FROM plugin_storage WHERE plugin_id = ? AND collection = ? AND key = ?",
          )
          .get("mcp", "source", "remote-headers"),
      ).data,
    ) as {
      readonly config: {
        readonly auth?: {
          readonly kind: string;
          readonly headerName?: string;
          readonly secretSlot?: string;
          readonly prefix?: string;
        };
        readonly endpoint?: string;
        readonly transport: string;
      };
    };
    expect(source.config.auth).toMatchObject({
      kind: "header",
      headerName: "X-API-Key",
      secretSlot: "auth:header",
      prefix: "Bearer ",
    });
    const binding = (await after
      .prepare(
        "SELECT slot_key, kind, secret_id FROM credential_binding WHERE plugin_id = ? AND source_id = ? AND slot_key = ?",
      )
      .get("mcp", "remote-headers", "auth:header")) as Record<string, string>;
    expect(binding).toMatchObject({
      slot_key: "auth:header",
      kind: "secret",
      secret_id: "tok-secret",
    });
    expect(source.config.transport).toBe("remote");
    expect(source.config.endpoint).toBe("https://example.com/mcp");
    after.close();
  });

  it("moves oauth2 auth and request credentials into slots and bindings", async () => {
    const dbPath = makeDbPath();
    const db = openTestDb(dbPath);
    await db.exec(PRE_0007_SQL);
    await stampPriorMigrationsApplied(db);

    await db
      .prepare(
        "INSERT INTO mcp_source (scope_id, id, name, config, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
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
    await runMigrations(dbPath, MIGRATIONS_FOLDER);

    const after = openTestDb(dbPath);
    const source = decodePluginStorageData(
      decodePluginStorageRow(
        await after
          .prepare(
            "SELECT data FROM plugin_storage WHERE plugin_id = ? AND collection = ? AND key = ?",
          )
          .get("mcp", "source", "remote-oauth"),
      ).data,
    ) as {
      readonly config: {
        readonly auth?: Record<string, unknown>;
        readonly headers?: Record<string, unknown>;
        readonly queryParams?: Record<string, unknown>;
      };
    };
    expect(source.config.auth).toMatchObject({
      kind: "oauth2",
      connectionSlot: "auth:oauth2:connection",
      clientIdSlot: "auth:oauth2:client-id",
      clientSecretSlot: "auth:oauth2:client-secret",
    });

    const authBindings = (await after
      .prepare(
        "SELECT slot_key, kind, secret_id, connection_id FROM credential_binding WHERE plugin_id = ? AND source_id = ? ORDER BY slot_key",
      )
      .all("mcp", "remote-oauth")) as ReadonlyArray<Record<string, string | null>>;
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

    expect(source.config.headers).toMatchObject({
      "X-Trace": "static",
      "X-Token": { kind: "binding", slot: "header:x-token" },
    });
    expect(bySlot.get("header:x-token")).toMatchObject({
      kind: "secret",
      secret_id: "extra-tok",
    });

    expect(source.config.queryParams?.org).toMatchObject({
      kind: "binding",
      slot: "query_param:org",
    });
    expect(bySlot.get("query_param:org")).toMatchObject({
      kind: "secret",
      secret_id: "org-id-secret",
    });

    after.close();
  });

  it("fails instead of silently collapsing colliding legacy header slots", async () => {
    const dbPath = makeDbPath();
    const db = openTestDb(dbPath);
    await db.exec(PRE_0007_SQL);
    await stampPriorMigrationsApplied(db);

    await db
      .prepare(
        "INSERT INTO mcp_source (scope_id, id, name, config, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
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
    await expect(runMigrations(dbPath, MIGRATIONS_FOLDER)).rejects.toThrow();
  });

  it("leaves stdio sources alone (no auth, no headers, no queryParams)", async () => {
    const dbPath = makeDbPath();
    const db = openTestDb(dbPath);
    await db.exec(PRE_0007_SQL);
    await stampPriorMigrationsApplied(db);

    await db
      .prepare(
        "INSERT INTO mcp_source (scope_id, id, name, config, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
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
    await runMigrations(dbPath, MIGRATIONS_FOLDER);

    const after = openTestDb(dbPath);
    const source = decodePluginStorageData(
      decodePluginStorageRow(
        await after
          .prepare(
            "SELECT data FROM plugin_storage WHERE plugin_id = ? AND collection = ? AND key = ?",
          )
          .get("mcp", "source", "stdio-only"),
      ).data,
    ) as { readonly config: { readonly transport: string; readonly command?: string } };
    expect(source.config.transport).toBe("stdio");
    expect(source.config.command).toBe("/usr/bin/server");
    after.close();
  });
});
