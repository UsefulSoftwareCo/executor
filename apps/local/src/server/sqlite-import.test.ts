import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectTables, definePlugin, scopedExecutorTable, textColumn } from "@executor-js/sdk";
import { withQueryContext } from "fumadb/query";

import { importLegacySqliteIfNeeded, readBundledDrizzleMigrationHashes } from "./executor";
import { importSqliteDataToFuma, readLegacySqliteScopeIds } from "./sqlite-import";
import { createSqliteFumaDb, type SqliteFumaDb } from "./sqlite-fumadb";

let workDir: string;
let sqlite: SqliteFumaDb | null;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "executor-sqlite-import-"));
  sqlite = null;
});

afterEach(async () => {
  await sqlite?.close();
  rmSync(workDir, { recursive: true, force: true });
});

const seedSqlite = (path: string) => {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE source (
      id TEXT PRIMARY KEY NOT NULL,
      plugin_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT,
      can_remove INTEGER NOT NULL,
      can_refresh INTEGER NOT NULL,
      can_edit INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE blob (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (namespace, key)
    );
  `);
  db.prepare(
    `INSERT INTO source (
      id, plugin_id, kind, name, url, can_remove, can_refresh, can_edit, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "src_1",
    "plugin",
    "remote",
    "Imported",
    null,
    1,
    0,
    1,
    1_700_000_000_000,
    1_700_000_001_000,
  );
  db.prepare("INSERT INTO blob (namespace, key, value) VALUES (?, ?, ?)").run(
    "scope_a/plugin",
    "spec",
    "{}",
  );
  db.close();
};

const seedDrizzleMigrationHistory = (
  db: Database,
  hashes: ReadonlyArray<string> = readBundledDrizzleMigrationHashes(
    join(import.meta.dirname, "../../drizzle"),
  ),
) => {
  db.exec(`
    CREATE TABLE "__drizzle_migrations" (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      hash text NOT NULL,
      created_at numeric
    );
  `);
  const insert = db.prepare(`INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)`);
  for (const hash of hashes) {
    insert.run(hash, Date.now());
  }
};

const seedMigratedSqlite = (
  path: string,
  options?: {
    readonly migrationHashes?: ReadonlyArray<string>;
  },
) => {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE source (
      scope_id TEXT NOT NULL,
      id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT,
      can_remove INTEGER NOT NULL,
      can_refresh INTEGER NOT NULL,
      can_edit INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope_id, id)
    );
    CREATE TABLE blob (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (namespace, key)
    );
  `);
  seedDrizzleMigrationHistory(db, options?.migrationHashes);
  db.prepare(
    `INSERT INTO source (
      scope_id, id, plugin_id, kind, name, url, can_remove, can_refresh, can_edit, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "scope_a",
    "src_1",
    "plugin",
    "remote",
    "Imported",
    null,
    1,
    0,
    1,
    1_700_000_000_000,
    1_700_000_001_000,
  );
  db.prepare("INSERT INTO blob (namespace, key, value) VALUES (?, ?, ?)").run(
    "scope_a/plugin",
    "spec",
    "{}",
  );
  db.close();
};

const lateSchema = {
  late_item: scopedExecutorTable("late_item", {
    value: textColumn("value"),
  }),
};

const latePlugin = definePlugin(() => ({
  id: "late" as const,
  schema: lateSchema,
  storage: () => ({}),
}))();

describe("importSqliteDataToFuma", () => {
  it("imports current SQLite rows into FumaDB SQLite without replacing source files", async () => {
    const sqlitePath = join(workDir, "data.db");
    const markerPath = join(workDir, "fumadb-sqlite-imported");
    seedSqlite(sqlitePath);

    const tables = collectTables([]);
    sqlite = await createSqliteFumaDb({
      tables,
      namespace: "executor_local_test",
      path: join(workDir, "target.db"),
    });

    const scopedDb = withQueryContext(sqlite.db, { allowedScopeIds: new Set(["scope_a"]) });
    const result = await importSqliteDataToFuma({
      sqlitePath,
      target: scopedDb,
      tables,
      scopeId: "scope_a",
    });

    expect(result.imported).toBe(true);
    expect(result.importedRows).toBe(2);
    expect(result.importedTables).toEqual(["source", "blob"]);
    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(sqlitePath)).toBe(true);
    expect(result.backupPath).toBeUndefined();

    const source = (await scopedDb.findFirst("source", {
      where: (b) => b("id", "=", "src_1"),
    })) as Record<string, unknown>;
    expect(source.scope_id).toBe("scope_a");
    expect(source.can_remove).toBe(true);
    expect(source.can_refresh).toBe(false);
    expect(source.can_edit).toBe(true);
    expect(source.created_at).toBeInstanceOf(Date);

    const blob = (await scopedDb.findFirst("blob", {
      where: (b) => b("id", "=", JSON.stringify(["scope_a/plugin", "spec"])),
    })) as Record<string, unknown>;
    expect(blob.value).toBe("{}");
  });

  it("imports every existing legacy scope from the global local database", async () => {
    const sqlitePath = join(workDir, "data.db");
    const db = new Database(sqlitePath);
    db.exec(`
      CREATE TABLE source (
        scope_id TEXT NOT NULL,
        id TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        url TEXT,
        can_remove INTEGER NOT NULL,
        can_refresh INTEGER NOT NULL,
        can_edit INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope_id, id)
      );
    `);
    const insert = db.prepare(
      `INSERT INTO source (
        scope_id, id, plugin_id, kind, name, url, can_remove, can_refresh, can_edit, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      "scope_a",
      "src_a",
      "plugin",
      "remote",
      "Scope A",
      null,
      1,
      0,
      1,
      1_700_000_000_000,
      1_700_000_001_000,
    );
    insert.run(
      "scope_b",
      "src_b",
      "plugin",
      "remote",
      "Scope B",
      null,
      1,
      0,
      1,
      1_700_000_000_000,
      1_700_000_001_000,
    );
    db.close();

    const tables = collectTables([]);
    const legacyScopeIds = readLegacySqliteScopeIds({
      sqlitePath,
      tables,
      scopeId: "scope_a",
    });
    expect([...legacyScopeIds].sort()).toEqual(["scope_a", "scope_b"]);

    sqlite = await createSqliteFumaDb({
      tables,
      namespace: "executor_local_test",
      path: join(workDir, "target.db"),
    });
    await importSqliteDataToFuma({
      sqlitePath,
      target: withQueryContext(sqlite.db, { allowedScopeIds: legacyScopeIds }),
      tables,
      scopeId: "scope_a",
    });

    await expect(
      withQueryContext(sqlite.db, { allowedScopeIds: new Set(["scope_a"]) }).findMany("source", {
        select: ["id", "scope_id", "name"],
        orderBy: ["id", "asc"],
      }),
    ).resolves.toEqual([{ id: "src_a", scope_id: "scope_a", name: "Scope A" }]);
    await expect(
      withQueryContext(sqlite.db, { allowedScopeIds: new Set(["scope_b"]) }).findMany("source", {
        select: ["id", "scope_id", "name"],
        orderBy: ["id", "asc"],
      }),
    ).resolves.toEqual([{ id: "src_b", scope_id: "scope_b", name: "Scope B" }]);
  });

  it("writes the import marker only after the replacement database is in place", async () => {
    const sqlitePath = join(workDir, "data.db");
    const markerPath = join(workDir, "fumadb-sqlite-imported");
    seedMigratedSqlite(sqlitePath);

    const tables = collectTables([]);
    const result = await importLegacySqliteIfNeeded({
      storage: {
        dataDir: workDir,
        sqlitePath,
        importMarkerPath: markerPath,
      },
      tables,
      scopeId: "scope_a",
    });

    expect(result.imported).toBe(true);
    expect(existsSync(markerPath)).toBe(true);
    expect(existsSync(sqlitePath)).toBe(true);
    expect(result.backupPath && existsSync(result.backupPath)).toBe(true);

    sqlite = await createSqliteFumaDb({
      tables,
      namespace: "executor_local",
      path: sqlitePath,
    });
    await expect(
      withQueryContext(sqlite.db, { allowedScopeIds: new Set(["scope_a"]) }).findFirst("source", {
        where: (b) => b("id", "=", "src_1"),
      }),
    ).resolves.toMatchObject({ id: "src_1", scope_id: "scope_a" });
  });

  it("imports an existing legacy schema with divergent Drizzle migration history", async () => {
    const sqlitePath = join(workDir, "data.db");
    const markerPath = join(workDir, "fumadb-sqlite-imported");
    seedMigratedSqlite(sqlitePath, {
      migrationHashes: ["different-branch-migration", "newer-branch-migration"],
    });

    const tables = collectTables([]);
    const result = await importLegacySqliteIfNeeded({
      storage: {
        dataDir: workDir,
        sqlitePath,
        importMarkerPath: markerPath,
      },
      tables,
      scopeId: "scope_a",
    });

    expect(result.imported).toBe(true);
    expect(result.importedRows).toBe(2);
    expect(result.importedTables).toEqual(["source", "blob"]);
    expect(existsSync(markerPath)).toBe(true);

    sqlite = await createSqliteFumaDb({
      tables,
      namespace: "executor_local",
      path: sqlitePath,
    });
    await expect(
      withQueryContext(sqlite.db, { allowedScopeIds: new Set(["scope_a"]) }).findFirst("source", {
        where: (b) => b("id", "=", "src_1"),
      }),
    ).resolves.toMatchObject({ id: "src_1", scope_id: "scope_a" });
  });

  it("imports newly-loaded plugin tables from the original backup after the first cutover", async () => {
    const sqlitePath = join(workDir, "data.db");
    const markerPath = join(workDir, "fumadb-sqlite-imported");
    seedMigratedSqlite(sqlitePath);

    const legacy = new Database(sqlitePath);
    legacy.exec(`
      CREATE TABLE late_item (
        scope_id TEXT NOT NULL,
        id TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (scope_id, id)
      );
    `);
    legacy
      .prepare("INSERT INTO late_item (scope_id, id, value) VALUES (?, ?, ?)")
      .run("scope_a", "late_1", "from-backup");
    legacy.close();

    const firstTables = collectTables([]);
    const firstResult = await importLegacySqliteIfNeeded({
      storage: {
        dataDir: workDir,
        sqlitePath,
        importMarkerPath: markerPath,
      },
      tables: firstTables,
      scopeId: "scope_a",
    });
    expect(firstResult.importedTables).not.toContain("late_item");

    const allTables = collectTables([latePlugin]);
    const secondResult = await importLegacySqliteIfNeeded({
      storage: {
        dataDir: workDir,
        sqlitePath,
        importMarkerPath: markerPath,
      },
      tables: allTables,
      scopeId: "scope_a",
    });

    expect(secondResult.imported).toBe(true);
    expect(secondResult.importedTables).toEqual(["late_item"]);

    sqlite = await createSqliteFumaDb({
      tables: allTables,
      namespace: "executor_local",
      path: sqlitePath,
    });
    await expect(
      withQueryContext(sqlite.db, { allowedScopeIds: new Set(["scope_a"]) }).findMany("late_item", {
        select: ["id", "value"],
      }),
    ).resolves.toEqual([{ id: "late_1", value: "from-backup" }]);
  });
});
