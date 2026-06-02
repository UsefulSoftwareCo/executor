import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { type Client } from "@libsql/client";
import { Schema } from "effect";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectTables } from "@executor-js/api/server";
import {
  boolColumn,
  dateColumn,
  jsonColumn,
  nullableBigintColumn,
  nullableTextColumn,
  scopedExecutorTable,
  textColumn,
  type FumaTables,
} from "@executor-js/sdk";
import { withQueryContext } from "fumadb/query";

import { openTestClient, openTestDb } from "../testing/libsql-test-db";
import { importLegacySqliteIfNeeded, readBundledDrizzleMigrationHashes } from "../executor";
import { importSqliteDataToFuma, readLegacySqliteScopeIds } from "./sqlite-import";
import { createSqliteFumaDb, type SqliteFumaDb } from "./sqlite-fumadb";

let workDir: string;
let sqlite: SqliteFumaDb | null;
let heldReader: Client | null;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "executor-sqlite-import-"));
  sqlite = null;
  heldReader = null;
});

afterEach(async () => {
  heldReader?.close();
  await sqlite?.close();
  rmSync(workDir, { recursive: true, force: true });
});

const seedSqlite = async (path: string) => {
  const db = openTestDb(path);
  await db.exec(`
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
  await db
    .prepare(
      `INSERT INTO source (
      id, plugin_id, kind, name, url, can_remove, can_refresh, can_edit, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
  await db
    .prepare("INSERT INTO blob (namespace, key, value) VALUES (?, ?, ?)")
    .run("scope_a/plugin", "spec", "{}");
  db.close();
};

const seedDrizzleMigrationHistory = async (
  db: ReturnType<typeof openTestDb>,
  hashes: ReadonlyArray<string> = readBundledDrizzleMigrationHashes(
    join(import.meta.dirname, "../../drizzle"),
  ),
) => {
  await db.exec(`
    CREATE TABLE "__drizzle_migrations" (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      hash text NOT NULL,
      created_at numeric
    );
  `);
  const insert = await db.prepare(
    `INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)`,
  );
  for (const hash of hashes) {
    await insert.run(hash, Date.now());
  }
};

const seedMigratedSqlite = async (
  path: string,
  options?: {
    readonly migrationHashes?: ReadonlyArray<string>;
  },
) => {
  const db = openTestDb(path);
  await db.exec(`
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
  await seedDrizzleMigrationHistory(db, options?.migrationHashes);
  await db
    .prepare(
      `INSERT INTO source (
      scope_id, id, plugin_id, kind, name, url, can_remove, can_refresh, can_edit, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
  await db
    .prepare("INSERT INTO blob (namespace, key, value) VALUES (?, ?, ?)")
    .run("scope_a/plugin", "spec", "{}");
  db.close();
};

const lateSchema = {
  late_item: scopedExecutorTable("late_item", {
    value: textColumn("value"),
  }),
};

const ImportMarkerForTest = Schema.Struct({
  importedTables: Schema.Array(Schema.String),
});
const decodeImportMarkerForTest = Schema.decodeUnknownSync(
  Schema.fromJsonString(ImportMarkerForTest),
);

const legacyShapeSchema = {
  legacy_shape: scopedExecutorTable("legacy_shape", {
    payload: jsonColumn("payload"),
    enabled: boolColumn("enabled", false),
    retry_after_ms: nullableBigintColumn("retry_after_ms"),
    discovered_at: dateColumn("discovered_at"),
    note: nullableTextColumn("note"),
  }),
};

describe("importSqliteDataToFuma", () => {
  it("imports current SQLite rows into FumaDB SQLite without replacing source files", async () => {
    const sqlitePath = join(workDir, "data.db");
    const markerPath = join(workDir, "fumadb-sqlite-imported");
    await seedSqlite(sqlitePath);

    const tables = collectTables();
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
    const db = openTestDb(sqlitePath);
    await db.exec(`
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
    const insert = await db.prepare(
      `INSERT INTO source (
        scope_id, id, plugin_id, kind, name, url, can_remove, can_refresh, can_edit, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    await insert.run(
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
    await insert.run(
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

    const tables = collectTables();
    const legacyScopeIds = await readLegacySqliteScopeIds({
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

  it("normalizes plugin table values when importing legacy SQLite rows", async () => {
    const sqlitePath = join(workDir, "data.db");
    const db = openTestDb(sqlitePath);
    await db.exec(`
      CREATE TABLE legacy_shape (
        scope_id TEXT NOT NULL,
        id TEXT NOT NULL,
        payload TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        retry_after_ms TEXT,
        discovered_at INTEGER NOT NULL,
        note TEXT,
        PRIMARY KEY (scope_id, id)
      );
    `);
    await db
      .prepare(
        `INSERT INTO legacy_shape (
        scope_id, id, payload, enabled, retry_after_ms, discovered_at, note
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "scope_a",
        "shape_1",
        JSON.stringify({ auth: { type: "oauth2" }, paths: ["/v1/items"] }),
        1,
        "9007199254740993",
        1_700_000_000_000,
        null,
      );
    db.close();

    const tables: FumaTables = {
      ...collectTables(),
      ...legacyShapeSchema,
    };
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

    expect(result.importedTables).toEqual(["legacy_shape"]);
    expect(result.importedRows).toBe(1);

    const row = await scopedDb.findFirst("legacy_shape", {
      where: (b) => b("id", "=", "shape_1"),
    });
    expect(row).toMatchObject({
      id: "shape_1",
      scope_id: "scope_a",
      payload: { auth: { type: "oauth2" }, paths: ["/v1/items"] },
      enabled: true,
      note: null,
    });
    expect(row?.retry_after_ms).toBe(9_007_199_254_740_993n);
    expect(row?.discovered_at).toEqual(new Date(1_700_000_000_000));
  });

  it("writes the import marker only after the replacement database is in place", async () => {
    const sqlitePath = join(workDir, "data.db");
    const markerPath = join(workDir, "fumadb-sqlite-imported");
    await seedMigratedSqlite(sqlitePath);

    const tables = collectTables();
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
    await seedMigratedSqlite(sqlitePath, {
      migrationHashes: ["different-branch-migration", "newer-branch-migration"],
    });

    const tables = collectTables();
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

  it("imports a checkpointed legacy WAL database even when DELETE journal mode is busy", async () => {
    const sqlitePath = join(workDir, "data.db");
    const markerPath = join(workDir, "fumadb-sqlite-imported");
    await seedMigratedSqlite(sqlitePath);

    const writer = openTestClient(sqlitePath);
    await writer.execute("PRAGMA journal_mode = WAL");
    writer.close();

    // Hold a concurrent read on a SEPARATE libSQL connection so the importer's
    // WAL checkpoint must contend with an open reader (busy_timeout handling).
    heldReader = openTestClient(sqlitePath);
    await heldReader.execute("BEGIN");
    await heldReader.execute("SELECT * FROM source");

    const tables = collectTables();
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

  it("imports newly-available tables from the original backup after the first cutover", async () => {
    const sqlitePath = join(workDir, "data.db");
    const markerPath = join(workDir, "fumadb-sqlite-imported");
    await seedMigratedSqlite(sqlitePath);

    const legacy = openTestDb(sqlitePath);
    await legacy.exec(`
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

    const firstTables = collectTables();
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

    const allTables: FumaTables = {
      ...collectTables(),
      ...lateSchema,
    };
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

  it("marks newly-available empty tables so startup does not retry backup imports", async () => {
    const sqlitePath = join(workDir, "data.db");
    const markerPath = join(workDir, "fumadb-sqlite-imported");
    await seedMigratedSqlite(sqlitePath);

    const firstResult = await importLegacySqliteIfNeeded({
      storage: {
        dataDir: workDir,
        sqlitePath,
        importMarkerPath: markerPath,
      },
      tables: collectTables(),
      scopeId: "scope_a",
    });
    expect(firstResult.importedTables).not.toContain("late_item");

    const allTables: FumaTables = {
      ...collectTables(),
      ...lateSchema,
    };
    const secondResult = await importLegacySqliteIfNeeded({
      storage: {
        dataDir: workDir,
        sqlitePath,
        importMarkerPath: markerPath,
      },
      tables: allTables,
      scopeId: "scope_a",
    });

    expect(secondResult.imported).toBe(false);
    expect(secondResult.importedRows).toBe(0);
    expect(decodeImportMarkerForTest(readFileSync(markerPath, "utf8")).importedTables).toContain(
      "late_item",
    );

    const thirdResult = await importLegacySqliteIfNeeded({
      storage: {
        dataDir: workDir,
        sqlitePath,
        importMarkerPath: markerPath,
      },
      tables: allTables,
      scopeId: "scope_a",
    });
    expect(thirdResult.imported).toBe(false);
  });
});
