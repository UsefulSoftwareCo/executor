// End-to-end test for the openapi portion of
// openapi credential migrations. Seeds the pre-0007 shape
// shape (json blobs on openapi_source.headers/query_params,
// openapi_source.invocation_config.specFetchCredentials.*, and
// openapi_source_binding.value), runs the migration runner, asserts
// child rows and shared credential bindings match the old data.

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Schema } from "effect";

import { LibsqlTestDb, openTestDb, runMigrations } from "./__test-helpers__/libsql-test-db";
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

const PluginStorageRow = Schema.Struct({
  data: Schema.String,
});

const CountRow = Schema.Struct({
  n: Schema.Number,
});

const decodeBindingRows = Schema.decodeUnknownSync(Schema.Array(BindingRow));
const decodeCountRow = Schema.decodeUnknownSync(CountRow);
const decodePluginStorageRow = Schema.decodeUnknownSync(PluginStorageRow);
const decodePluginStorageData = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

describe("0007_normalize_plugin_secret_refs (openapi)", () => {
  let dir: string;
  let dbPath: string;
  let openDatabases: Set<LibsqlTestDb>;

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

  const openDatabase = (path: string) => {
    const db = openTestDb(path);
    openDatabases.add(db);
    return db;
  };

  const closeDatabase = (db: LibsqlTestDb) => {
    db.close();
    openDatabases.delete(db);
  };

  it("moves openapi_source_binding rows into shared credential_binding", async () => {
    const db = openDatabase(dbPath);
    await db.exec(PRE_0007_SQL);
    await stampPriorMigrationsApplied(db);

    // Seed three bindings, one per kind.
    const insert = await db.prepare(
      "INSERT INTO openapi_source_binding (id, source_id, source_scope_id, target_scope_id, slot, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const now = Date.now();
    await insert.run(
      "b1",
      "src",
      "default-scope",
      "default-scope",
      "header:authorization",
      JSON.stringify({ kind: "secret", secretId: "tok-secret" }),
      now,
      now,
    );
    await insert.run(
      "b2",
      "src",
      "default-scope",
      "default-scope",
      "oauth2:default:connection",
      JSON.stringify({ kind: "connection", connectionId: "conn-1" }),
      now,
      now,
    );
    await insert.run(
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
    await db
      .prepare(
        "INSERT INTO openapi_source (scope_id, id, name, spec, invocation_config) VALUES (?, ?, ?, ?, ?)",
      )
      .run("default-scope", "src", "Source", "{}", "{}");

    closeDatabase(db);

    await runMigrations(dbPath, MIGRATIONS_FOLDER);

    const after = openDatabase(dbPath);
    const rows = decodeBindingRows(
      await after
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
      await after
        .prepare(
          "SELECT count(*) as n FROM sqlite_master WHERE type = 'table' AND name = 'openapi_source_binding'",
        )
        .get(),
    );
    expect(oldTableCount.n).toBe(0);
  });

  it("explodes query_params and specFetchCredentials json into child slot rows", async () => {
    const db = openDatabase(dbPath);
    await db.exec(PRE_0007_SQL);
    await stampPriorMigrationsApplied(db);

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

    await db
      .prepare(
        "INSERT INTO openapi_source (scope_id, id, name, spec, query_params, invocation_config) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "default-scope",
        "src",
        "Source",
        "{}",
        JSON.stringify(queryParams),
        JSON.stringify(invocationConfig),
      );

    closeDatabase(db);

    await runMigrations(dbPath, MIGRATIONS_FOLDER);

    const after = openDatabase(dbPath);

    const sourceData = decodePluginStorageData(
      decodePluginStorageRow(
        await after
          .prepare(
            "SELECT data FROM plugin_storage WHERE plugin_id = ? AND collection = ? AND key = ?",
          )
          .get("openapi", "source", "src"),
      ).data,
    ) as {
      readonly config: {
        readonly queryParams?: Record<string, unknown>;
        readonly specFetchCredentials?: {
          readonly headers?: Record<string, unknown>;
          readonly queryParams?: Record<string, unknown>;
        };
      };
    };
    expect(sourceData.config.queryParams).toMatchObject({
      api_key: { kind: "binding", slot: "query_param:api-key" },
      flag: "true",
    });
    expect(sourceData.config.specFetchCredentials?.headers?.Authorization).toMatchObject({
      kind: "binding",
      slot: "spec_fetch_header:authorization",
      prefix: "Bearer ",
    });
    expect(sourceData.config.specFetchCredentials?.queryParams?.token).toMatchObject({
      kind: "binding",
      slot: "spec_fetch_query_param:token",
    });
    const oldQueryParamTableCount = decodeCountRow(
      await after
        .prepare(
          "SELECT count(*) as n FROM sqlite_master WHERE type = 'table' AND name = 'openapi_source_query_param'",
        )
        .get(),
    );
    expect(oldQueryParamTableCount.n).toBe(0);

    const bindings = decodeBindingRows(
      await after
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

    const oldSourceTableCount = decodeCountRow(
      await after
        .prepare(
          "SELECT count(*) as n FROM sqlite_master WHERE type = 'table' AND name = 'openapi_source'",
        )
        .get(),
    );
    expect(oldSourceTableCount.n).toBe(0);
  });

  it("fails instead of silently collapsing colliding legacy query parameter slots", async () => {
    const db = openDatabase(dbPath);
    await db.exec(PRE_0007_SQL);
    await stampPriorMigrationsApplied(db);

    await db
      .prepare(
        "INSERT INTO openapi_source (scope_id, id, name, spec, query_params, invocation_config) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
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

    await expect(runMigrations(dbPath, MIGRATIONS_FOLDER)).rejects.toThrow();
  });

  it("fails on punctuation collisions that runtime canonicalization would collapse", async () => {
    const db = openDatabase(dbPath);
    await db.exec(PRE_0007_SQL);
    await stampPriorMigrationsApplied(db);

    await db
      .prepare(
        "INSERT INTO openapi_source (scope_id, id, name, spec, query_params, invocation_config) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
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

    await expect(runMigrations(dbPath, MIGRATIONS_FOLDER)).rejects.toThrow();
  });

  it("rewrites old OpenAPI header and OAuth JSON into slot config plus core bindings", async () => {
    const db = openDatabase(dbPath);
    await db.exec(PRE_0007_SQL);
    await stampPriorMigrationsApplied(db);

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

    await db
      .prepare(
        "INSERT INTO openapi_source (scope_id, id, name, spec, headers, oauth2, invocation_config) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "default-scope",
        "src",
        "Source",
        "{}",
        JSON.stringify(headers),
        JSON.stringify(oauth2),
        JSON.stringify({}),
      );

    closeDatabase(db);

    await runMigrations(dbPath, MIGRATIONS_FOLDER);

    const after = openDatabase(dbPath);
    const source = decodePluginStorageData(
      decodePluginStorageRow(
        await after
          .prepare(
            "SELECT data FROM plugin_storage WHERE plugin_id = ? AND collection = ? AND key = ?",
          )
          .get("openapi", "source", "src"),
      ).data,
    ) as {
      readonly config: {
        readonly headers?: Record<string, unknown>;
        readonly oauth2?: Record<string, unknown>;
      };
    };
    expect(source.config.headers).toMatchObject({
      Authorization: { kind: "binding", slot: "header:authorization", prefix: "Bearer " },
      "X-Static": "literal",
      "X-Already": { kind: "binding", slot: "header:x-already" },
    });
    const oldHeaderTableCount = decodeCountRow(
      await after
        .prepare(
          "SELECT count(*) as n FROM sqlite_master WHERE type = 'table' AND name = 'openapi_source_header'",
        )
        .get(),
    );
    expect(oldHeaderTableCount.n).toBe(0);

    const migratedOAuth2 = source.config.oauth2 ?? {};
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
      await after
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

    const oldSourceTableCount = decodeCountRow(
      await after
        .prepare(
          "SELECT count(*) as n FROM sqlite_master WHERE type = 'table' AND name = 'openapi_source'",
        )
        .get(),
    );
    expect(oldSourceTableCount.n).toBe(0);
  });

  it("survives empty / missing json on bindings and sources", async () => {
    const db = openDatabase(dbPath);
    await db.exec(PRE_0007_SQL);
    await stampPriorMigrationsApplied(db);

    // Source with empty invocation_config and no query_params.
    await db
      .prepare(
        "INSERT INTO openapi_source (scope_id, id, name, spec, invocation_config) VALUES (?, ?, ?, ?, ?)",
      )
      .run("default-scope", "bare", "Bare", "{}", JSON.stringify({}));

    closeDatabase(db);
    await runMigrations(dbPath, MIGRATIONS_FOLDER);

    const after = openDatabase(dbPath);
    const source = decodePluginStorageData(
      decodePluginStorageRow(
        await after
          .prepare(
            "SELECT data FROM plugin_storage WHERE plugin_id = ? AND collection = ? AND key = ?",
          )
          .get("openapi", "source", "bare"),
      ).data,
    ) as { readonly config: { readonly queryParams?: unknown } };
    expect(source.config.queryParams).toBeUndefined();
  });
});
