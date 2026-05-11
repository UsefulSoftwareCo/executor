import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import {
  LocalDatabaseMigrationHistoryMismatch,
  LocalDatabaseSchemaTooNew,
  checkDrizzleMigrationCompatibility,
  readAppliedDrizzleMigrationHashes,
  readBundledDrizzleMigrationHashes,
} from "./executor";

const MIGRATIONS_FOLDER = join(import.meta.dirname, "../../drizzle");

const workDirs: string[] = [];
const openDbs: Database[] = [];

const tempDb = (): { db: Database; path: string; dataDir: string } => {
  const dir = mkdtempSync(join(tmpdir(), "executor-schema-compat-"));
  workDirs.push(dir);
  const path = join(dir, "data.db");
  const db = new Database(path);
  openDbs.push(db);
  return { db, path, dataDir: dir };
};

const createMigrationTable = (db: Database): void => {
  db.exec(`
    CREATE TABLE __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at NUMERIC
    )
  `);
};

const insertMigrationHashes = (db: Database, hashes: ReadonlyArray<string>): void => {
  const stmt = db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)");
  for (const [index, hash] of hashes.entries()) {
    stmt.run(hash, index + 1);
  }
};

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    db.close();
  }
  for (const dir of workDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Drizzle migration compatibility preflight", () => {
  it.effect("allows a fresh DB without __drizzle_migrations", () =>
    Effect.gen(function* () {
      const { db, path, dataDir } = tempDb();

      yield* checkDrizzleMigrationCompatibility({
        sqlite: db,
        dbPath: path,
        dataDir,
        migrationsFolder: MIGRATIONS_FOLDER,
      });
    }),
  );

  it.effect("allows an existing but empty __drizzle_migrations table", () =>
    Effect.gen(function* () {
      const { db, path, dataDir } = tempDb();
      createMigrationTable(db);

      yield* checkDrizzleMigrationCompatibility({
        sqlite: db,
        dbPath: path,
        dataDir,
        migrationsFolder: MIGRATIONS_FOLDER,
      });
    }),
  );

  it("computes bundled hashes that exactly match hashes written by Drizzle", () => {
    const { db } = tempDb();
    migrate(drizzle(db), { migrationsFolder: MIGRATIONS_FOLDER });

    expect(readAppliedDrizzleMigrationHashes(db)).toEqual(
      readBundledDrizzleMigrationHashes(MIGRATIONS_FOLDER),
    );
  });

  it.effect("fails with LocalDatabaseSchemaTooNew when the DB has more migrations", () =>
    Effect.gen(function* () {
      const { db, path, dataDir } = tempDb();
      const bundled = readBundledDrizzleMigrationHashes(MIGRATIONS_FOLDER);
      createMigrationTable(db);
      insertMigrationHashes(db, [...bundled, "future-migration-hash"]);

      const error = yield* checkDrizzleMigrationCompatibility({
        sqlite: db,
        dbPath: path,
        dataDir,
        migrationsFolder: MIGRATIONS_FOLDER,
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(LocalDatabaseSchemaTooNew);
      expect(error).toMatchObject({
        message: expect.stringContaining("This Executor binary is older than the schema"),
      });
      expect(error).toMatchObject({
        message: expect.stringContaining("Use a newer Executor binary"),
      });
    }),
  );

  it.effect("fails with LocalDatabaseMigrationHistoryMismatch when hashes diverge", () =>
    Effect.gen(function* () {
      const { db, path, dataDir } = tempDb();
      const bundled = readBundledDrizzleMigrationHashes(MIGRATIONS_FOLDER);
      createMigrationTable(db);
      insertMigrationHashes(db, ["different-migration-hash", ...bundled.slice(1)]);

      const error = yield* checkDrizzleMigrationCompatibility({
        sqlite: db,
        dbPath: path,
        dataDir,
        migrationsFolder: MIGRATIONS_FOLDER,
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(LocalDatabaseMigrationHistoryMismatch);
      expect(error).toMatchObject({
        message: expect.stringContaining("does not match this Executor build"),
      });
      expect(error).toMatchObject({ message: expect.stringContaining("restore a backup") });
    }),
  );

  it.effect("allows an older DB whose migration history is a bundled prefix", () =>
    Effect.gen(function* () {
      const { db, path, dataDir } = tempDb();
      const bundled = readBundledDrizzleMigrationHashes(MIGRATIONS_FOLDER);
      createMigrationTable(db);
      insertMigrationHashes(db, bundled.slice(0, 1));

      yield* checkDrizzleMigrationCompatibility({
        sqlite: db,
        dbPath: path,
        dataDir,
        migrationsFolder: MIGRATIONS_FOLDER,
      });
    }),
  );
});
