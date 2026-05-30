// End-to-end test for the graphql portion of
// GraphQL credential migrations: seed a DB at the pre-migration shape
// with json-blob headers/query_params/auth, run all migrations, and
// assert the final slot model plus shared credential_binding rows.

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openTestDb, runMigrations } from "./__test-helpers__/libsql-test-db";
import { PRE_0007_SQL, stampPriorMigrationsApplied } from "./__test-helpers__/pre-0007-schema";

const MIGRATIONS_FOLDER = join(import.meta.dirname, "../../drizzle");

const NullableString = Schema.NullOr(Schema.String);

const TableInfoRow = Schema.Struct({
  name: Schema.String,
});

const BindingRow = Schema.Struct({
  scope_id: Schema.String,
  plugin_id: Schema.String,
  source_id: Schema.String,
  source_scope_id: Schema.String,
  slot_key: Schema.String,
  kind: Schema.String,
  secret_id: NullableString,
  connection_id: NullableString,
});

const PluginStorageRow = Schema.Struct({ data: Schema.String });

const decodeTableInfoRows = Schema.decodeUnknownSync(Schema.Array(TableInfoRow));
const decodeBindingRows = Schema.decodeUnknownSync(Schema.Array(BindingRow));
const decodePluginStorageRow = Schema.decodeUnknownSync(PluginStorageRow);
const decodePluginStorageData = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "graphql-mig-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("graphql credential migrations", () => {
  it("moves auth json connection refs into a connection slot binding", async () => {
    const dbPath = join(dir, "test.sqlite");
    const db = openTestDb(dbPath);
    await db.exec(PRE_0007_SQL);
    await stampPriorMigrationsApplied(db);

    await db
      .prepare(
        "INSERT INTO graphql_source (scope_id, id, name, endpoint, auth) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "default-scope",
        "github",
        "GitHub",
        "https://api.github.com/graphql",
        JSON.stringify({ kind: "oauth2", connectionId: "conn-1" }),
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
          .get("graphql", "source", "github"),
      ).data,
    ) as { readonly auth: { readonly kind: string; readonly connectionSlot?: string } };
    expect(source.auth.kind).toBe("oauth2");
    expect(source.auth.connectionSlot).toBe("auth:oauth2:connection");
    const bindings = decodeBindingRows(
      await after
        .prepare(
          "SELECT scope_id, plugin_id, source_id, source_scope_id, slot_key, kind, secret_id, connection_id FROM credential_binding WHERE plugin_id = ? ORDER BY slot_key",
        )
        .all("graphql"),
    );
    expect(bindings).toEqual([
      {
        scope_id: "default-scope",
        plugin_id: "graphql",
        source_id: "github",
        source_scope_id: "default-scope",
        slot_key: "auth:oauth2:connection",
        kind: "connection",
        secret_id: null,
        connection_id: "conn-1",
      },
    ]);
    // Old json column is gone.
    const cols = decodeTableInfoRows(
      await after.prepare("PRAGMA table_info('graphql_source')").all(),
    );
    expect(cols.some((c) => c.name === "auth")).toBe(false);
    expect(cols.some((c) => c.name === "headers")).toBe(false);
    expect(cols.some((c) => c.name === "query_params")).toBe(false);
    expect(cols.some((c) => c.name === "auth_connection_id")).toBe(false);
    after.close();
  });

  it("explodes header/query_param json into slots and credential bindings", async () => {
    const dbPath = join(dir, "test.sqlite");
    const db = openTestDb(dbPath);
    await db.exec(PRE_0007_SQL);
    await stampPriorMigrationsApplied(db);

    const headers = {
      // Literal text header.
      "X-Static": "literal-value",
      // Secret-backed header without prefix.
      Authorization: { secretId: "sec-token" },
      // Secret-backed with prefix.
      "X-Bearer": { secretId: "sec-bearer", prefix: "Bearer " },
    };
    const queryParams = {
      api_key: { secretId: "sec-key" },
    };

    await db
      .prepare(
        "INSERT INTO graphql_source (scope_id, id, name, endpoint, headers, query_params, auth) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "default-scope",
        "example",
        "Example",
        "https://example.com/graphql",
        JSON.stringify(headers),
        JSON.stringify(queryParams),
        JSON.stringify({ kind: "none" }),
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
          .get("graphql", "source", "example"),
      ).data,
    ) as {
      readonly headers: Record<string, unknown>;
      readonly queryParams: Record<string, unknown>;
    };
    expect(source.headers).toMatchObject({
      "X-Static": "literal-value",
      Authorization: { kind: "binding", slot: "header:authorization" },
      "X-Bearer": { kind: "binding", slot: "header:x-bearer", prefix: "Bearer " },
    });
    expect(source.queryParams.api_key).toMatchObject({
      kind: "binding",
      slot: "query_param:api-key",
    });

    const bindings = decodeBindingRows(
      await after
        .prepare(
          "SELECT scope_id, plugin_id, source_id, source_scope_id, slot_key, kind, secret_id, connection_id FROM credential_binding WHERE plugin_id = ? ORDER BY slot_key",
        )
        .all("graphql"),
    );
    expect(bindings.map((binding) => [binding.slot_key, binding.secret_id])).toEqual([
      ["header:authorization", "sec-token"],
      ["header:x-bearer", "sec-bearer"],
      ["query_param:api-key", "sec-key"],
    ]);

    after.close();
  });

  it("fails instead of silently collapsing colliding legacy query parameter slots", async () => {
    const dbPath = join(dir, "test.sqlite");
    const db = openTestDb(dbPath);
    await db.exec(PRE_0007_SQL);
    await stampPriorMigrationsApplied(db);

    await db
      .prepare(
        "INSERT INTO graphql_source (scope_id, id, name, endpoint, query_params, auth) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "default-scope",
        "collision",
        "Collision",
        "https://example.com/graphql",
        JSON.stringify({
          api_key: { secretId: "sec-underscore" },
          "api-key": { secretId: "sec-dash" },
        }),
        JSON.stringify({ kind: "none" }),
      );

    db.close();

    await expect(runMigrations(dbPath, MIGRATIONS_FOLDER)).rejects.toThrow();
  });

  it("fails instead of silently collapsing colliding legacy header slots", async () => {
    const dbPath = join(dir, "test.sqlite");
    const db = openTestDb(dbPath);
    await db.exec(PRE_0007_SQL);
    await stampPriorMigrationsApplied(db);

    await db
      .prepare(
        "INSERT INTO graphql_source (scope_id, id, name, endpoint, headers, auth) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "default-scope",
        "collision",
        "Collision",
        "https://example.com/graphql",
        JSON.stringify({
          x_token: { secretId: "sec-underscore" },
          "x-token": { secretId: "sec-dash" },
        }),
        JSON.stringify({ kind: "none" }),
      );

    db.close();

    await expect(runMigrations(dbPath, MIGRATIONS_FOLDER)).rejects.toThrow();
  });

  it("handles graphql_source rows with null json (empty config)", async () => {
    const dbPath = join(dir, "test.sqlite");
    const db = openTestDb(dbPath);
    await db.exec(PRE_0007_SQL);
    await stampPriorMigrationsApplied(db);

    await db
      .prepare("INSERT INTO graphql_source (scope_id, id, name, endpoint) VALUES (?, ?, ?, ?)")
      .run("default-scope", "bare", "Bare", "https://bare.example/graphql");
    db.close();

    await runMigrations(dbPath, MIGRATIONS_FOLDER);

    const after = openTestDb(dbPath);
    const source = decodePluginStorageData(
      decodePluginStorageRow(
        await after
          .prepare(
            "SELECT data FROM plugin_storage WHERE plugin_id = ? AND collection = ? AND key = ?",
          )
          .get("graphql", "source", "bare"),
      ).data,
    ) as { readonly auth: { readonly kind: string }; readonly headers: Record<string, unknown> };
    expect(source.auth.kind).toBe("none");
    expect(source.headers).toEqual({});
    after.close();
  });

  it("does not collapse child rows whose source/name pairs share colon-concatenated ids", async () => {
    const dbPath = join(dir, "test.sqlite");
    const db = openTestDb(dbPath);
    await db.exec(PRE_0007_SQL);
    await stampPriorMigrationsApplied(db);

    const insert = db.prepare(
      "INSERT INTO graphql_source (scope_id, id, name, endpoint, headers) VALUES (?, ?, ?, ?, ?)",
    );
    await insert.run(
      "default-scope",
      "a:b",
      "First",
      "https://first.example/graphql",
      JSON.stringify({ c: "first" }),
    );
    await insert.run(
      "default-scope",
      "a",
      "Second",
      "https://second.example/graphql",
      JSON.stringify({ "b:c": "second" }),
    );
    db.close();

    await runMigrations(dbPath, MIGRATIONS_FOLDER);

    const after = openTestDb(dbPath);
    const rows = (
      await after
        .prepare(
          "SELECT key, data FROM plugin_storage WHERE plugin_id = ? AND collection = ? ORDER BY key",
        )
        .all<{ key: string; data: string }>("graphql", "source")
    ).map((row) => {
      const decoded = decodePluginStorageRow(row);
      return {
        key: row.key,
        data: decodePluginStorageData(decoded.data),
      };
    }) as ReadonlyArray<{
      readonly key: string;
      readonly data: { readonly headers: Record<string, unknown> };
    }>;
    expect(rows.map((row) => row.key)).toEqual(["a", "a:b"]);
    expect(rows[0]?.data.headers).toEqual({ "b:c": "second" });
    expect(rows[1]?.data.headers).toEqual({ c: "first" });
    after.close();
  });
});
