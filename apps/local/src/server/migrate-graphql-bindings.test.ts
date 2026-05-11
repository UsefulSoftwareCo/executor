// End-to-end test for the graphql portion of
// GraphQL credential migrations: seed a DB at the pre-migration shape
// with json-blob headers/query_params/auth, run all migrations, and
// assert the final slot model plus shared credential_binding rows.

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Database } from "bun:sqlite";
import { Schema } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { PRE_0007_SQL, stampPriorMigrationsApplied } from "./__test-helpers__/pre-0007-schema";

const MIGRATIONS_FOLDER = join(import.meta.dirname, "../../drizzle");

const NullableString = Schema.NullOr(Schema.String);

const GraphqlAuthRow = Schema.Struct({
  auth_kind: Schema.String,
  auth_connection_slot: NullableString,
});

const TableInfoRow = Schema.Struct({
  name: Schema.String,
});

const GraphqlHeaderRow = Schema.Struct({
  name: Schema.String,
  kind: Schema.String,
  text_value: NullableString,
  slot_key: NullableString,
  prefix: NullableString,
});

const GraphqlQueryParamRow = Schema.Struct({
  kind: Schema.String,
  slot_key: Schema.String,
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

const CountRow = Schema.Struct({
  n: Schema.Number,
});

const GraphqlHeaderIdRow = Schema.Struct({
  id: Schema.String,
  source_id: Schema.String,
  name: Schema.String,
  text_value: Schema.String,
});

const decodeAuthRow = Schema.decodeUnknownSync(GraphqlAuthRow);
const decodeTableInfoRows = Schema.decodeUnknownSync(Schema.Array(TableInfoRow));
const decodeHeaderRows = Schema.decodeUnknownSync(Schema.Array(GraphqlHeaderRow));
const decodeQueryParamRow = Schema.decodeUnknownSync(GraphqlQueryParamRow);
const decodeBindingRows = Schema.decodeUnknownSync(Schema.Array(BindingRow));
const decodeCountRow = Schema.decodeUnknownSync(CountRow);
const decodeHeaderIdRows = Schema.decodeUnknownSync(Schema.Array(GraphqlHeaderIdRow));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "graphql-mig-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("graphql credential migrations", () => {
  it("moves auth json connection refs into a connection slot binding", () => {
    const dbPath = join(dir, "test.sqlite");
    const db = new Database(dbPath);
    db.exec(PRE_0007_SQL);
    stampPriorMigrationsApplied(db);

    db.prepare(
      "INSERT INTO graphql_source (scope_id, id, name, endpoint, auth) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "default-scope",
      "github",
      "GitHub",
      "https://api.github.com/graphql",
      JSON.stringify({ kind: "oauth2", connectionId: "conn-1" }),
    );

    db.close();

    const drizzleDb = drizzle(new Database(dbPath));
    migrate(drizzleDb, { migrationsFolder: MIGRATIONS_FOLDER });

    const after = new Database(dbPath, { readonly: true });
    const row = decodeAuthRow(
      after
        .prepare("SELECT auth_kind, auth_connection_slot FROM graphql_source WHERE id = ?")
        .get("github"),
    );
    expect(row.auth_kind).toBe("oauth2");
    expect(row.auth_connection_slot).toBe("auth:oauth2:connection");
    const bindings = decodeBindingRows(
      after
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
    const cols = decodeTableInfoRows(after.prepare("PRAGMA table_info('graphql_source')").all());
    expect(cols.some((c) => c.name === "auth")).toBe(false);
    expect(cols.some((c) => c.name === "headers")).toBe(false);
    expect(cols.some((c) => c.name === "query_params")).toBe(false);
    expect(cols.some((c) => c.name === "auth_connection_id")).toBe(false);
    after.close();
  });

  it("explodes header/query_param json into slots and credential bindings", () => {
    const dbPath = join(dir, "test.sqlite");
    const db = new Database(dbPath);
    db.exec(PRE_0007_SQL);
    stampPriorMigrationsApplied(db);

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

    db.prepare(
      "INSERT INTO graphql_source (scope_id, id, name, endpoint, headers, query_params, auth) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "default-scope",
      "example",
      "Example",
      "https://example.com/graphql",
      JSON.stringify(headers),
      JSON.stringify(queryParams),
      JSON.stringify({ kind: "none" }),
    );

    db.close();

    const drizzleDb = drizzle(new Database(dbPath));
    migrate(drizzleDb, { migrationsFolder: MIGRATIONS_FOLDER });

    const after = new Database(dbPath, { readonly: true });
    const headerRows = decodeHeaderRows(
      after
        .prepare(
          "SELECT name, kind, text_value, slot_key, prefix FROM graphql_source_header WHERE source_id = ? ORDER BY name",
        )
        .all("example"),
    );
    expect(headerRows).toHaveLength(3);

    const byName = new Map(headerRows.map((r) => [r.name, r]));
    expect(byName.get("X-Static")).toMatchObject({
      kind: "text",
      text_value: "literal-value",
      slot_key: null,
    });
    expect(byName.get("Authorization")).toMatchObject({
      kind: "binding",
      text_value: null,
      slot_key: "header:authorization",
      prefix: null,
    });
    expect(byName.get("X-Bearer")).toMatchObject({
      kind: "binding",
      slot_key: "header:x-bearer",
      prefix: "Bearer ",
    });

    const paramRow = decodeQueryParamRow(
      after
        .prepare("SELECT kind, slot_key FROM graphql_source_query_param WHERE source_id = ?")
        .get("example"),
    );
    expect(paramRow).toMatchObject({ kind: "binding", slot_key: "query_param:api-key" });

    const bindings = decodeBindingRows(
      after
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

  it("fails instead of silently collapsing colliding legacy query parameter slots", () => {
    const dbPath = join(dir, "test.sqlite");
    const db = new Database(dbPath);
    db.exec(PRE_0007_SQL);
    stampPriorMigrationsApplied(db);

    db.prepare(
      "INSERT INTO graphql_source (scope_id, id, name, endpoint, query_params, auth) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
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

    const sqlite = new Database(dbPath);
    const drizzleDb = drizzle(sqlite);
    expect(() => migrate(drizzleDb, { migrationsFolder: MIGRATIONS_FOLDER })).toThrow();
    sqlite.close();
  });

  it("fails instead of silently collapsing colliding legacy header slots", () => {
    const dbPath = join(dir, "test.sqlite");
    const db = new Database(dbPath);
    db.exec(PRE_0007_SQL);
    stampPriorMigrationsApplied(db);

    db.prepare(
      "INSERT INTO graphql_source (scope_id, id, name, endpoint, headers, auth) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
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

    const sqlite = new Database(dbPath);
    const drizzleDb = drizzle(sqlite);
    expect(() => migrate(drizzleDb, { migrationsFolder: MIGRATIONS_FOLDER })).toThrow();
    sqlite.close();
  });

  it("handles graphql_source rows with null json (empty config)", () => {
    const dbPath = join(dir, "test.sqlite");
    const db = new Database(dbPath);
    db.exec(PRE_0007_SQL);
    stampPriorMigrationsApplied(db);

    db.prepare("INSERT INTO graphql_source (scope_id, id, name, endpoint) VALUES (?, ?, ?, ?)").run(
      "default-scope",
      "bare",
      "Bare",
      "https://bare.example/graphql",
    );
    db.close();

    const drizzleDb = drizzle(new Database(dbPath));
    migrate(drizzleDb, { migrationsFolder: MIGRATIONS_FOLDER });

    const after = new Database(dbPath, { readonly: true });
    const row = decodeAuthRow(
      after
        .prepare("SELECT auth_kind, auth_connection_slot FROM graphql_source WHERE id = ?")
        .get("bare"),
    );
    expect(row.auth_kind).toBe("none");
    expect(row.auth_connection_slot).toBeNull();

    const headerCount = decodeCountRow(
      after
        .prepare("SELECT count(*) as n FROM graphql_source_header WHERE source_id = ?")
        .get("bare"),
    ).n;
    expect(headerCount).toBe(0);
    after.close();
  });

  it("does not collapse child rows whose source/name pairs share colon-concatenated ids", () => {
    const dbPath = join(dir, "test.sqlite");
    const db = new Database(dbPath);
    db.exec(PRE_0007_SQL);
    stampPriorMigrationsApplied(db);

    const insert = db.prepare(
      "INSERT INTO graphql_source (scope_id, id, name, endpoint, headers) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run(
      "default-scope",
      "a:b",
      "First",
      "https://first.example/graphql",
      JSON.stringify({ c: "first" }),
    );
    insert.run(
      "default-scope",
      "a",
      "Second",
      "https://second.example/graphql",
      JSON.stringify({ "b:c": "second" }),
    );
    db.close();

    const drizzleDb = drizzle(new Database(dbPath));
    migrate(drizzleDb, { migrationsFolder: MIGRATIONS_FOLDER });

    const after = new Database(dbPath, { readonly: true });
    const rows = decodeHeaderIdRows(
      after
        .prepare(
          "SELECT id, source_id, name, text_value FROM graphql_source_header ORDER BY source_id, name",
        )
        .all(),
    );
    expect(rows).toHaveLength(2);
    expect(rows).toEqual([
      {
        id: '["a","b:c"]',
        source_id: "a",
        name: "b:c",
        text_value: "second",
      },
      {
        id: '["a:b","c"]',
        source_id: "a:b",
        name: "c",
        text_value: "first",
      },
    ]);
    after.close();
  });
});
