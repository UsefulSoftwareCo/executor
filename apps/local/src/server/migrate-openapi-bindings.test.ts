// End-to-end test for the openapi portion of
// openapi credential migrations. Seeds the pre-0007 shape
// shape (json blobs on openapi_source.headers/query_params,
// openapi_source.invocation_config.specFetchCredentials.*, and
// openapi_source_binding.value), runs the migration runner, asserts
// child rows and shared credential bindings match the old data.

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Schema } from "effect";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { PRE_0007_SQL, stampPriorMigrationsApplied } from "./__test-helpers__/pre-0007-schema";

const MIGRATIONS_FOLDER = join(import.meta.dirname, "../../drizzle");

const BindingRow = Schema.Struct({
  id: Schema.String,
  scope_id: Schema.String,
  plugin_id: Schema.String,
  source_id: Schema.String,
  source_scope_id: Schema.String,
  slot_key: Schema.String,
  kind: Schema.String,
  secret_id: Schema.NullOr(Schema.String),
  connection_id: Schema.NullOr(Schema.String),
  text_value: Schema.NullOr(Schema.String),
});

const QueryParamRow = Schema.Struct({
  name: Schema.String,
  kind: Schema.String,
  text_value: Schema.NullOr(Schema.String),
  slot_key: Schema.NullOr(Schema.String),
  prefix: Schema.NullOr(Schema.String),
});

const HeaderRow = QueryParamRow;

const FetchHeaderRow = Schema.Struct({
  name: Schema.String,
  kind: Schema.String,
  slot_key: Schema.NullOr(Schema.String),
  prefix: Schema.NullOr(Schema.String),
});

const FetchQueryParamRow = Schema.Struct({
  name: Schema.String,
  kind: Schema.String,
  slot_key: Schema.NullOr(Schema.String),
  prefix: Schema.NullOr(Schema.String),
});

const SourceJsonRow = Schema.Struct({
  oauth2: Schema.NullOr(Schema.String),
});

const TableInfoRow = Schema.Struct({
  name: Schema.String,
});

const CountRow = Schema.Struct({
  n: Schema.Number,
});

const decodeBindingRows = Schema.decodeUnknownSync(Schema.Array(BindingRow));
const decodeQueryParamRows = Schema.decodeUnknownSync(Schema.Array(QueryParamRow));
const decodeHeaderRows = Schema.decodeUnknownSync(Schema.Array(HeaderRow));
const decodeFetchHeaderRows = Schema.decodeUnknownSync(Schema.Array(FetchHeaderRow));
const decodeFetchQueryParamRows = Schema.decodeUnknownSync(Schema.Array(FetchQueryParamRow));
const decodeTableInfoRows = Schema.decodeUnknownSync(Schema.Array(TableInfoRow));
const decodeCountRow = Schema.decodeUnknownSync(CountRow);
const decodeSourceJsonRow = Schema.decodeUnknownSync(SourceJsonRow);
const decodeJsonRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

describe("0007_normalize_plugin_secret_refs (openapi)", () => {
  let dir: string;
  let dbPath: string;
  let openDatabases: Set<Database>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openapi-mig-"));
    dbPath = join(dir, "test.sqlite");
    openDatabases = new Set();
  });

  afterEach(() => {
    for (const db of openDatabases) {
      db.close();
    }
    openDatabases.clear();
    rmSync(dir, { recursive: true, force: true });
  });

  const openDatabase = (...args: ConstructorParameters<typeof Database>) => {
    const db = new Database(...args);
    openDatabases.add(db);
    return db;
  };

  const closeDatabase = (db: Database) => {
    db.close();
    openDatabases.delete(db);
  };

  it("moves openapi_source_binding rows into shared credential_binding", () => {
    const db = openDatabase(dbPath);
    db.exec(PRE_0007_SQL);
    stampPriorMigrationsApplied(db);

    // Seed three bindings, one per kind.
    const insert = db.prepare(
      "INSERT INTO openapi_source_binding (id, source_id, source_scope_id, target_scope_id, slot, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const now = Date.now();
    insert.run(
      "b1",
      "src",
      "default-scope",
      "default-scope",
      "header:authorization",
      JSON.stringify({ kind: "secret", secretId: "tok-secret" }),
      now,
      now,
    );
    insert.run(
      "b2",
      "src",
      "default-scope",
      "default-scope",
      "oauth2:default:connection",
      JSON.stringify({ kind: "connection", connectionId: "conn-1" }),
      now,
      now,
    );
    insert.run(
      "b3",
      "src",
      "default-scope",
      "default-scope",
      "header:x-static",
      JSON.stringify({ kind: "text", text: "literal" }),
      now,
      now,
    );

    // Need the parent openapi_source row so the source_id FK ergonomics
    // are satisfied for any cascading delete logic, though the binding
    // table has no DB-level FK, code paths assume the parent exists.
    db.prepare(
      "INSERT INTO openapi_source (scope_id, id, name, spec, invocation_config) VALUES (?, ?, ?, ?, ?)",
    ).run("default-scope", "src", "Source", "{}", "{}");

    closeDatabase(db);

    const drizzleSqlite = openDatabase(dbPath);
    const drizzleDb = drizzle(drizzleSqlite);
    migrate(drizzleDb, { migrationsFolder: MIGRATIONS_FOLDER });
    closeDatabase(drizzleSqlite);

    const after = openDatabase(dbPath, { readonly: true });
    const rows = decodeBindingRows(
      after
        .prepare(
          "SELECT id, scope_id, plugin_id, source_id, source_scope_id, slot_key, kind, secret_id, connection_id, text_value FROM credential_binding ORDER BY id",
        )
        .all(),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      id: '["openapi","default-scope","src","header:authorization"]',
      scope_id: "default-scope",
      plugin_id: "openapi",
      source_id: "src",
      source_scope_id: "default-scope",
      slot_key: "header:authorization",
      kind: "secret",
      secret_id: "tok-secret",
      connection_id: null,
      text_value: null,
    });
    expect(rows[1]).toMatchObject({
      id: '["openapi","default-scope","src","header:x-static"]',
      scope_id: "default-scope",
      plugin_id: "openapi",
      source_id: "src",
      source_scope_id: "default-scope",
      slot_key: "header:x-static",
      kind: "text",
      secret_id: null,
      connection_id: null,
      text_value: "literal",
    });
    expect(rows[2]).toMatchObject({
      id: '["openapi","default-scope","src","oauth2:default:connection"]',
      scope_id: "default-scope",
      plugin_id: "openapi",
      source_id: "src",
      source_scope_id: "default-scope",
      slot_key: "oauth2:default:connection",
      kind: "connection",
      secret_id: null,
      connection_id: "conn-1",
      text_value: null,
    });
    const oldTableCount = decodeCountRow(
      after
        .prepare(
          "SELECT count(*) as n FROM sqlite_master WHERE type = 'table' AND name = 'openapi_source_binding'",
        )
        .get(),
    );
    expect(oldTableCount.n).toBe(0);
  });

  it("explodes query_params and specFetchCredentials json into child slot rows", () => {
    const db = openDatabase(dbPath);
    db.exec(PRE_0007_SQL);
    stampPriorMigrationsApplied(db);

    const queryParams = {
      api_key: { secretId: "qp-secret" },
      flag: "true",
    };
    const invocationConfig = {
      specFetchCredentials: {
        headers: {
          Authorization: { secretId: "fetch-tok", prefix: "Bearer " },
        },
        queryParams: { token: { secretId: "fetch-qp" } },
      },
    };

    db.prepare(
      "INSERT INTO openapi_source (scope_id, id, name, spec, query_params, invocation_config) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "default-scope",
      "src",
      "Source",
      "{}",
      JSON.stringify(queryParams),
      JSON.stringify(invocationConfig),
    );

    closeDatabase(db);

    const drizzleSqlite = openDatabase(dbPath);
    const drizzleDb = drizzle(drizzleSqlite);
    migrate(drizzleDb, { migrationsFolder: MIGRATIONS_FOLDER });
    closeDatabase(drizzleSqlite);

    const after = openDatabase(dbPath, { readonly: true });

    const qpRows = decodeQueryParamRows(
      after
        .prepare(
          "SELECT name, kind, text_value, slot_key, prefix FROM openapi_source_query_param WHERE source_id = ? ORDER BY name",
        )
        .all("src"),
    );
    expect(qpRows).toHaveLength(2);
    const byName = new Map(qpRows.map((r) => [r.name, r]));
    expect(byName.get("api_key")).toMatchObject({
      kind: "binding",
      slot_key: "query_param:api-key",
      prefix: null,
    });
    expect(byName.get("flag")).toMatchObject({
      kind: "text",
      text_value: "true",
      slot_key: null,
    });

    const fetchHeaders = decodeFetchHeaderRows(
      after
        .prepare(
          "SELECT name, kind, slot_key, prefix FROM openapi_source_spec_fetch_header WHERE source_id = ?",
        )
        .all("src"),
    );
    expect(fetchHeaders).toHaveLength(1);
    expect(fetchHeaders[0]).toMatchObject({
      name: "Authorization",
      kind: "binding",
      slot_key: "spec_fetch_header:authorization",
      prefix: "Bearer ",
    });

    const fetchQp = decodeFetchQueryParamRows(
      after
        .prepare(
          "SELECT name, kind, slot_key, prefix FROM openapi_source_spec_fetch_query_param WHERE source_id = ?",
        )
        .all("src"),
    );
    expect(fetchQp).toHaveLength(1);
    expect(fetchQp[0]).toMatchObject({
      name: "token",
      kind: "binding",
      slot_key: "spec_fetch_query_param:token",
      prefix: null,
    });

    const bindings = decodeBindingRows(
      after
        .prepare(
          "SELECT id, scope_id, plugin_id, source_id, source_scope_id, slot_key, kind, secret_id, connection_id, text_value FROM credential_binding WHERE source_id = ? ORDER BY slot_key",
        )
        .all("src"),
    );
    expect(bindings.map((row) => [row.slot_key, row.kind, row.secret_id])).toEqual([
      ["query_param:api-key", "secret", "qp-secret"],
      ["spec_fetch_header:authorization", "secret", "fetch-tok"],
      ["spec_fetch_query_param:token", "secret", "fetch-qp"],
    ]);

    // Old json columns dropped.
    const cols = decodeTableInfoRows(after.prepare("PRAGMA table_info('openapi_source')").all());
    expect(cols.some((c) => c.name === "query_params")).toBe(false);
    expect(cols.some((c) => c.name === "invocation_config")).toBe(false);
  });

  it("fails instead of silently collapsing colliding legacy query parameter slots", () => {
    const db = openDatabase(dbPath);
    db.exec(PRE_0007_SQL);
    stampPriorMigrationsApplied(db);

    db.prepare(
      "INSERT INTO openapi_source (scope_id, id, name, spec, query_params, invocation_config) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "default-scope",
      "collision",
      "Collision",
      "{}",
      JSON.stringify({
        api_key: { secretId: "sec-underscore" },
        "api-key": { secretId: "sec-dash" },
      }),
      "{}",
    );

    closeDatabase(db);

    const sqlite = openDatabase(dbPath);
    const drizzleDb = drizzle(sqlite);
    expect(() => migrate(drizzleDb, { migrationsFolder: MIGRATIONS_FOLDER })).toThrow();
    closeDatabase(sqlite);
  });

  it("fails on punctuation collisions that runtime canonicalization would collapse", () => {
    const db = openDatabase(dbPath);
    db.exec(PRE_0007_SQL);
    stampPriorMigrationsApplied(db);

    db.prepare(
      "INSERT INTO openapi_source (scope_id, id, name, spec, query_params, invocation_config) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "default-scope",
      "punctuation-collision",
      "Punctuation Collision",
      "{}",
      JSON.stringify({
        "X@Token": { secretId: "sec-at" },
        "X-Token": { secretId: "sec-dash" },
      }),
      "{}",
    );

    closeDatabase(db);

    const sqlite = openDatabase(dbPath);
    const drizzleDb = drizzle(sqlite);
    expect(() => migrate(drizzleDb, { migrationsFolder: MIGRATIONS_FOLDER })).toThrow();
    closeDatabase(sqlite);
  });

  it("rewrites old OpenAPI header and OAuth JSON into slot config plus core bindings", () => {
    const db = openDatabase(dbPath);
    db.exec(PRE_0007_SQL);
    stampPriorMigrationsApplied(db);

    const headers = {
      Authorization: { secretId: "header-token", prefix: "Bearer " },
      "X-Static": "literal",
      "X-Already": { kind: "binding", slot: "header:x-already" },
    };
    const oauth2 = {
      kind: "oauth2",
      connectionId: "conn-1",
      securitySchemeName: "oauth2",
      flow: "authorizationCode",
      tokenUrl: "https://auth.example.com/token",
      authorizationUrl: "https://auth.example.com/authorize",
      issuerUrl: "https://auth.example.com",
      clientIdSecretId: "client-id",
      clientSecretSecretId: "client-secret",
      scopes: ["read"],
    };

    db.prepare(
      "INSERT INTO openapi_source (scope_id, id, name, spec, headers, oauth2, invocation_config) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "default-scope",
      "src",
      "Source",
      "{}",
      JSON.stringify(headers),
      JSON.stringify(oauth2),
      JSON.stringify({}),
    );

    closeDatabase(db);

    const drizzleSqlite = openDatabase(dbPath);
    const drizzleDb = drizzle(drizzleSqlite);
    migrate(drizzleDb, { migrationsFolder: MIGRATIONS_FOLDER });
    closeDatabase(drizzleSqlite);

    const after = openDatabase(dbPath, { readonly: true });
    const source = decodeSourceJsonRow(
      after.prepare("SELECT oauth2 FROM openapi_source WHERE id = ?").get("src"),
    );
    const headerRows = decodeHeaderRows(
      after
        .prepare(
          "SELECT name, kind, text_value, slot_key, prefix FROM openapi_source_header WHERE source_id = ? ORDER BY name",
        )
        .all("src"),
    );
    expect(headerRows).toHaveLength(3);
    const headersByName = new Map(headerRows.map((row) => [row.name, row]));
    expect(headersByName.get("Authorization")).toMatchObject({
      kind: "binding",
      text_value: null,
      slot_key: "header:authorization",
      prefix: "Bearer ",
    });
    expect(headersByName.get("X-Static")).toMatchObject({
      kind: "text",
      text_value: "literal",
      slot_key: null,
      prefix: null,
    });
    expect(headersByName.get("X-Already")).toMatchObject({
      kind: "binding",
      slot_key: "header:x-already",
      prefix: null,
    });

    const migratedOAuth2 = decodeJsonRecord(source.oauth2 ?? "{}");
    expect(migratedOAuth2).toMatchObject({
      kind: "oauth2",
      securitySchemeName: "oauth2",
      clientIdSlot: "oauth2:oauth2:client-id",
      clientSecretSlot: "oauth2:oauth2:client-secret",
      connectionSlot: "oauth2:oauth2:connection",
    });
    expect(migratedOAuth2).not.toHaveProperty("connectionId");
    expect(migratedOAuth2).not.toHaveProperty("clientIdSecretId");

    const bindings = decodeBindingRows(
      after
        .prepare(
          "SELECT id, scope_id, plugin_id, source_id, source_scope_id, slot_key, kind, secret_id, connection_id, text_value FROM credential_binding WHERE source_id = ? ORDER BY slot_key",
        )
        .all("src"),
    );
    expect(
      bindings.map((row) => [row.slot_key, row.kind, row.secret_id, row.connection_id]),
    ).toEqual([
      ["header:authorization", "secret", "header-token", null],
      ["oauth2:oauth2:client-id", "secret", "client-id", null],
      ["oauth2:oauth2:client-secret", "secret", "client-secret", null],
      ["oauth2:oauth2:connection", "connection", null, "conn-1"],
    ]);

    const cols = decodeTableInfoRows(after.prepare("PRAGMA table_info('openapi_source')").all());
    expect(cols.some((c) => c.name === "headers")).toBe(false);
  });

  it("survives empty / missing json on bindings and sources", () => {
    const db = openDatabase(dbPath);
    db.exec(PRE_0007_SQL);
    stampPriorMigrationsApplied(db);

    // Source with empty invocation_config and no query_params.
    db.prepare(
      "INSERT INTO openapi_source (scope_id, id, name, spec, invocation_config) VALUES (?, ?, ?, ?, ?)",
    ).run("default-scope", "bare", "Bare", "{}", JSON.stringify({}));

    closeDatabase(db);
    const drizzleSqlite = openDatabase(dbPath);
    const drizzleDb = drizzle(drizzleSqlite);
    migrate(drizzleDb, { migrationsFolder: MIGRATIONS_FOLDER });
    closeDatabase(drizzleSqlite);

    const after = openDatabase(dbPath, { readonly: true });
    const qpCount = decodeCountRow(
      after
        .prepare("SELECT count(*) as n FROM openapi_source_query_param WHERE source_id = ?")
        .get("bare"),
    ).n;
    expect(qpCount).toBe(0);
  });
});
