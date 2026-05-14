import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectTables, withQueryContext } from "@executor-js/sdk";

import { importSqliteDataToFuma } from "./sqlite-import";
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

describe("importSqliteDataToFuma", () => {
  it("imports current SQLite rows into FumaDB SQLite and moves the old DB aside", async () => {
    const sqlitePath = join(workDir, "data.db");
    const markerPath = join(workDir, "fumadb-sqlite-imported");
    seedSqlite(sqlitePath);

    const tables = collectTables([]);
    sqlite = await createSqliteFumaDb({
      tables,
      namespace: "executor_local_test",
      path: join(workDir, "target.db"),
    });

    const result = await importSqliteDataToFuma({
      sqlitePath,
      markerPath,
      db: sqlite.db,
      tables,
      scopeId: "scope_a",
    });

    expect(result.imported).toBe(true);
    expect(result.importedRows).toBe(2);
    expect(result.importedTables).toEqual(["source", "blob"]);
    expect(existsSync(markerPath)).toBe(true);
    expect(existsSync(sqlitePath)).toBe(false);
    expect(result.backupPath && existsSync(result.backupPath)).toBe(true);

    const db = withQueryContext(sqlite.db, { allowedScopeIds: new Set(["scope_a"]) });

    const source = (await db.findFirst("source", {
      where: (b) => b("id", "=", "src_1"),
    })) as Record<string, unknown>;
    expect(source.scope_id).toBe("scope_a");
    expect(source.can_remove).toBe(true);
    expect(source.can_refresh).toBe(false);
    expect(source.can_edit).toBe(true);
    expect(source.created_at).toBeInstanceOf(Date);

    const blob = (await db.findFirst("blob", {
      where: (b) => b("id", "=", JSON.stringify(["scope_a/plugin", "spec"])),
    })) as Record<string, unknown>;
    expect(blob.value).toBe("{}");
  });
});
