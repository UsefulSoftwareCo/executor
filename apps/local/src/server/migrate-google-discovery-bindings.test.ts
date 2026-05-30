// End-to-end test for the google-discovery portion of
// `0007_normalize_plugin_secret_refs.sql`. Seeds a
// google_discovery_source row with the legacy json shape (config
// containing auth/credentials), runs the migration, asserts the new
// columns and child tables are populated.

import { afterEach, describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openTestDb, runMigrations } from "./__test-helpers__/libsql-test-db";
import { PRE_0007_SQL, stampPriorMigrationsApplied } from "./__test-helpers__/pre-0007-schema";

const MIGRATIONS_FOLDER = join(import.meta.dirname, "../../drizzle");

const migratedConfig = Schema.Struct({
  auth: Schema.optional(Schema.Unknown),
  service: Schema.String,
});
const decodeMigratedConfig = Schema.decodeUnknownSync(Schema.fromJsonString(migratedConfig));

const tempDirs = new Set<string>();

const createTempDbPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "gd-mig-"));
  tempDirs.add(dir);
  return join(dir, "test.sqlite");
};

describe("0007_normalize_plugin_secret_refs (google-discovery)", () => {
  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  it("flattens oauth2 auth into columns", async () => {
    const dbPath = createTempDbPath();
    const db = openTestDb(dbPath);
    await db.exec(PRE_0007_SQL);
    await stampPriorMigrationsApplied(db);

    await db
      .prepare(
        "INSERT INTO google_discovery_source (scope_id, id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "default-scope",
        "drive",
        "Drive",
        JSON.stringify({
          name: "Drive",
          discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
          service: "drive",
          version: "v3",
          rootUrl: "https://www.googleapis.com/",
          servicePath: "drive/v3/",
          auth: {
            kind: "oauth2",
            connectionId: "conn-1",
            clientIdSecretId: "client-id",
            clientSecretSecretId: "client-secret",
            scopes: ["https://www.googleapis.com/auth/drive"],
          },
        }),
        Date.now(),
        Date.now(),
      );

    db.close();
    await runMigrations(dbPath, MIGRATIONS_FOLDER);

    const after = openTestDb(dbPath);
    const row = (await after
      .prepare(
        "SELECT auth_kind, auth_connection_id, auth_client_id_secret_id, auth_client_secret_secret_id, auth_scopes, config FROM google_discovery_source WHERE id = ?",
      )
      .get("drive")) as Record<string, string | null>;
    expect(row.auth_kind).toBe("oauth2");
    expect(row.auth_connection_id).toBe("conn-1");
    expect(row.auth_client_id_secret_id).toBe("client-id");
    expect(row.auth_client_secret_secret_id).toBe("client-secret");
    // auth_scopes column is text-typed (string[] gets stored as JSON in sqlite).
    expect(row.auth_scopes).toContain("drive");
    // The auth key should be stripped from config json.
    const config = decodeMigratedConfig(row.config);
    expect(config.auth).toBeUndefined();
    expect(config.service).toBe("drive");
    after.close();
  });

  it("explodes credentials.headers and queryParams into child rows", async () => {
    const dbPath = createTempDbPath();
    const db = openTestDb(dbPath);
    await db.exec(PRE_0007_SQL);
    await stampPriorMigrationsApplied(db);

    await db
      .prepare(
        "INSERT INTO google_discovery_source (scope_id, id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "default-scope",
        "with-creds",
        "With Creds",
        JSON.stringify({
          name: "With Creds",
          discoveryUrl: "https://example.com/discovery",
          service: "svc",
          version: "v1",
          rootUrl: "https://example.com/",
          servicePath: "svc/v1/",
          auth: { kind: "none" },
          credentials: {
            headers: {
              "X-Static": "literal",
              Authorization: { secretId: "tok-secret", prefix: "Bearer " },
            },
            queryParams: {
              api_key: { secretId: "key-secret" },
            },
          },
        }),
        Date.now(),
        Date.now(),
      );

    db.close();
    await runMigrations(dbPath, MIGRATIONS_FOLDER);

    const after = openTestDb(dbPath);
    const headers = (await after
      .prepare(
        "SELECT name, kind, text_value, secret_id, secret_prefix FROM google_discovery_source_credential_header WHERE source_id = ? ORDER BY name",
      )
      .all("with-creds")) as ReadonlyArray<Record<string, string | null>>;
    expect(headers).toHaveLength(2);
    const byName = new Map(headers.map((h) => [h.name!, h]));
    expect(byName.get("X-Static")).toMatchObject({
      kind: "text",
      text_value: "literal",
    });
    expect(byName.get("Authorization")).toMatchObject({
      kind: "secret",
      secret_id: "tok-secret",
      secret_prefix: "Bearer ",
    });

    const params = (await after
      .prepare(
        "SELECT name, secret_id FROM google_discovery_source_credential_query_param WHERE source_id = ?",
      )
      .all("with-creds")) as ReadonlyArray<Record<string, string>>;
    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({ name: "api_key", secret_id: "key-secret" });

    after.close();
  });

  it("survives auth.kind=none with no credentials", async () => {
    const dbPath = createTempDbPath();
    const db = openTestDb(dbPath);
    await db.exec(PRE_0007_SQL);
    await stampPriorMigrationsApplied(db);

    await db
      .prepare(
        "INSERT INTO google_discovery_source (scope_id, id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "default-scope",
        "bare",
        "Bare",
        JSON.stringify({
          name: "Bare",
          discoveryUrl: "https://example.com/discovery",
          service: "svc",
          version: "v1",
          rootUrl: "https://example.com/",
          servicePath: "svc/v1/",
          auth: { kind: "none" },
        }),
        Date.now(),
        Date.now(),
      );

    db.close();
    await runMigrations(dbPath, MIGRATIONS_FOLDER);

    const after = openTestDb(dbPath);
    const row = (await after
      .prepare(
        "SELECT auth_kind, auth_connection_id, auth_scopes FROM google_discovery_source WHERE id = ?",
      )
      .get("bare")) as Record<string, string | null>;
    expect(row.auth_kind).toBe("none");
    expect(row.auth_connection_id).toBeNull();

    const headerCount = (
      (await after
        .prepare(
          "SELECT count(*) as n FROM google_discovery_source_credential_header WHERE source_id = ?",
        )
        .get("bare")) as { n: number }
    ).n;
    expect(headerCount).toBe(0);
    after.close();
  });
});
