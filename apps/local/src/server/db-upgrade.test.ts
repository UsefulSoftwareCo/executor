// Upgrade path for local DBs written by pre-scope executor versions.
//
// These helpers still run before the one-shot FumaDB import. They detect
// SQLite files whose core tables predate `scope_id`, move the file set aside,
// and preserve legacy secret routing rows for the fresh scoped database.

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openTestDb, runMigrations } from "./__test-helpers__/libsql-test-db";
import {
  importLegacySecrets,
  isPreScopeSchema,
  moveAsidePreScopeDb,
  readLegacySecrets,
} from "./db-upgrade";

const PRE_SCOPE_SCHEMA = `
  CREATE TABLE source (
    id TEXT PRIMARY KEY NOT NULL,
    plugin_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    can_remove INTEGER DEFAULT 1 NOT NULL,
    can_refresh INTEGER DEFAULT 0 NOT NULL,
    can_edit INTEGER DEFAULT 0 NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE tool (
    id TEXT PRIMARY KEY NOT NULL,
    source_id TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE secret (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE blob (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (namespace, key)
  );
`;

const SCOPED_SCHEMA = `
  CREATE TABLE source (
    id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    can_remove INTEGER DEFAULT 1 NOT NULL,
    can_refresh INTEGER DEFAULT 0 NOT NULL,
    can_edit INTEGER DEFAULT 0 NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope_id, id)
  );
`;

const seed = async (path: string, sql: string) => {
  const db = openTestDb(path);
  await db.exec(sql);
  db.close();
};

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "exec-dbup-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("isPreScopeSchema", () => {
  it("returns true for a DB with a source table missing scope_id", async () => {
    const path = join(workDir, "data.db");
    await seed(path, PRE_SCOPE_SCHEMA);
    expect(await isPreScopeSchema(path)).toBe(true);
  });

  it("returns false for a DB whose source table already has scope_id", async () => {
    const path = join(workDir, "data.db");
    await seed(path, SCOPED_SCHEMA);
    expect(await isPreScopeSchema(path)).toBe(false);
  });

  it("returns false for a DB with no source table", async () => {
    const path = join(workDir, "data.db");
    await seed(path, "CREATE TABLE unrelated (x TEXT);");
    expect(await isPreScopeSchema(path)).toBe(false);
  });

  it("returns false when the DB file doesn't exist", async () => {
    expect(await isPreScopeSchema(join(workDir, "missing.db"))).toBe(false);
  });
});

describe("moveAsidePreScopeDb", () => {
  it("renames data.db + wal/shm siblings and returns the backup path", async () => {
    const path = join(workDir, "data.db");
    await seed(path, PRE_SCOPE_SCHEMA);
    writeFileSync(`${path}-wal`, "wal-bytes");
    writeFileSync(`${path}-shm`, "shm-bytes");

    const backup = await moveAsidePreScopeDb(path);
    expect(backup).toMatch(/data\.db\.pre-scopes-\d+-[0-9a-f]{8}$/);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(existsSync(backup!)).toBe(true);
    expect(existsSync(`${backup}-wal`)).toBe(true);
    expect(existsSync(`${backup}-shm`)).toBe(true);
  });

  it("is a no-op when the DB already has the scoped schema", async () => {
    const path = join(workDir, "data.db");
    await seed(path, SCOPED_SCHEMA);
    expect(await moveAsidePreScopeDb(path)).toBeNull();
    expect(existsSync(path)).toBe(true);
  });

  it("is a no-op when the DB doesn't exist yet", async () => {
    expect(await moveAsidePreScopeDb(join(workDir, "missing.db"))).toBeNull();
  });
});

describe("move-aside + fresh migrate end-to-end", () => {
  it("lets migrations run cleanly after an old DB is moved aside", async () => {
    const path = join(workDir, "data.db");
    await seed(path, PRE_SCOPE_SCHEMA);

    const backup = await moveAsidePreScopeDb(path);
    expect(backup).not.toBeNull();

    await runMigrations(path, join(import.meta.dirname, "../../drizzle"));
    const db = openTestDb(path);
    const cols = (await db.prepare("PRAGMA table_info('source')").all()) as ReadonlyArray<{
      readonly name: string;
    }>;
    db.close();
    expect(cols.some((c) => c.name === "scope_id")).toBe(true);
  });
});

describe("readLegacySecrets", () => {
  it("returns all rows from a pre-scope DB's secret table", async () => {
    const path = join(workDir, "data.db");
    await seed(path, PRE_SCOPE_SCHEMA);
    const db = openTestDb(path);
    await db
      .prepare("INSERT INTO secret (id, name, provider, created_at) VALUES (?, ?, ?, ?)")
      .run("sec_1", "GitHub Token", "onepassword", 1_700_000_000);
    await db
      .prepare("INSERT INTO secret (id, name, provider, created_at) VALUES (?, ?, ?, ?)")
      .run("sec_2", "Stripe", "keychain", 1_700_000_001);
    db.close();

    const rows = await readLegacySecrets(path);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: "sec_1",
      name: "GitHub Token",
      provider: "onepassword",
      createdAt: 1_700_000_000,
    });
  });

  it("returns [] when the DB has no secret table", async () => {
    const path = join(workDir, "data.db");
    await seed(path, "CREATE TABLE unrelated (x TEXT);");
    expect(await readLegacySecrets(path)).toEqual([]);
  });

  it("returns [] when the DB file doesn't exist", async () => {
    expect(await readLegacySecrets(join(workDir, "missing.db"))).toEqual([]);
  });
});

describe("importLegacySecrets", () => {
  const createScopedDb = async (path: string) => {
    const db = openTestDb(path);
    await db.exec(`
      CREATE TABLE secret (
        id TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (scope_id, id)
      );
    `);
    return db;
  };

  it("inserts rows stamped with the given scope id", async () => {
    const path = join(workDir, "data.db");
    const db = await createScopedDb(path);
    await importLegacySecrets(db.client, "scope_a", [
      { id: "sec_1", name: "GH", provider: "onepassword", createdAt: 1 },
      { id: "sec_2", name: "St", provider: "keychain", createdAt: 2 },
    ]);
    const rows = await db
      .prepare("SELECT id, scope_id, name, provider FROM secret ORDER BY id")
      .all<{ id: string; scope_id: string; name: string; provider: string }>();
    db.close();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: "sec_1",
      scope_id: "scope_a",
      name: "GH",
      provider: "onepassword",
    });
    expect(rows[1].scope_id).toBe("scope_a");
  });

  it("is a no-op with an empty list", async () => {
    const path = join(workDir, "data.db");
    const db = await createScopedDb(path);
    await importLegacySecrets(db.client, "scope_a", []);
    const count = (await db.prepare("SELECT COUNT(*) as n FROM secret").get<{ n: number }>())?.n;
    db.close();
    expect(count).toBe(0);
  });

  it("uses INSERT OR IGNORE so a second import of the same ids is a no-op", async () => {
    const path = join(workDir, "data.db");
    const db = await createScopedDb(path);
    const rows = [{ id: "sec_1", name: "GH", provider: "onepassword", createdAt: 1 }];
    await importLegacySecrets(db.client, "scope_a", rows);
    await db
      .prepare("UPDATE secret SET provider = 'file' WHERE id = 'sec_1' AND scope_id = 'scope_a'")
      .run();
    await importLegacySecrets(db.client, "scope_a", rows);
    const provider = (
      await db
        .prepare("SELECT provider FROM secret WHERE id = ? AND scope_id = ?")
        .get<{ provider: string }>("sec_1", "scope_a")
    )?.provider;
    db.close();
    expect(provider).toBe("file");
  });
});
