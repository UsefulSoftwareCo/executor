import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";

import {
  DataMigrationError,
  runSqliteDataMigrations,
  sqliteDataMigration,
  type SqliteDataMigration,
  type SqliteDataMigrationClient,
} from "./sqlite-data-migrations";

// A tiny scripted fake standing in for a libSQL client: tracks statements
// and simulates the ledger table.
const makeFakeClient = (stampedNames: string[]) => {
  const log: unknown[] = [];
  const stamps = [...stampedNames];
  const client: SqliteDataMigrationClient = {
    execute: (stmt) => {
      log.push(stmt);
      if (typeof stmt === "string" && stmt.startsWith("SELECT name FROM data_migration")) {
        return Promise.resolve({ rows: stamps.map((name) => ({ name })) });
      }
      if (typeof stmt === "object" && stmt.sql.startsWith("INSERT INTO data_migration")) {
        stamps.push(String(stmt.args[0]));
      }
      return Promise.resolve({ rows: [] });
    },
  };
  return { client, log, stamps };
};

const migrationSpy = (name: string) => {
  const calls: number[] = [];
  const migration: SqliteDataMigration = {
    name,
    run: () => Effect.sync(() => void calls.push(calls.length)),
  };
  return { migration, calls };
};

describe("runSqliteDataMigrations", () => {
  it.effect("runs pending migrations in order and stamps them", () =>
    Effect.gen(function* () {
      const { client, log, stamps } = makeFakeClient([]);
      const a = migrationSpy("2026-06-05-a");
      const b = migrationSpy("2026-06-11-b");
      const applied = yield* runSqliteDataMigrations(client, [a.migration, b.migration]);
      expect(applied).toEqual(["2026-06-05-a", "2026-06-11-b"]);
      expect(a.calls.length).toBe(1);
      expect(b.calls.length).toBe(1);
      expect(stamps).toEqual(["2026-06-05-a", "2026-06-11-b"]);
      expect(String(log[0])).toContain("CREATE TABLE IF NOT EXISTS data_migration");
    }),
  );

  it.effect("skips stamped migrations without running them", () =>
    Effect.gen(function* () {
      const { client } = makeFakeClient(["2026-06-05-a"]);
      const a = migrationSpy("2026-06-05-a");
      const b = migrationSpy("2026-06-11-b");
      const applied = yield* runSqliteDataMigrations(client, [a.migration, b.migration]);
      expect(applied).toEqual(["2026-06-11-b"]);
      expect(a.calls.length).toBe(0);
      expect(b.calls.length).toBe(1);
    }),
  );

  it.effect("is a no-op once everything is stamped", () =>
    Effect.gen(function* () {
      const { client } = makeFakeClient([]);
      const a = migrationSpy("2026-06-05-a");
      yield* runSqliteDataMigrations(client, [a.migration]);
      const applied = yield* runSqliteDataMigrations(client, [a.migration]);
      expect(applied).toEqual([]);
      expect(a.calls.length).toBe(1);
    }),
  );

  it.effect("a failing migration leaves no stamp and surfaces the failure", () =>
    Effect.gen(function* () {
      const { client, stamps } = makeFakeClient([]);
      const boom: SqliteDataMigration = {
        name: "2026-06-11-boom",
        run: () =>
          Effect.fail(new DataMigrationError({ migration: "2026-06-11-boom", cause: "nope" })),
      };
      const after = migrationSpy("2026-06-12-after");
      const failure = yield* runSqliteDataMigrations(client, [boom, after.migration]).pipe(
        Effect.flip,
      );
      expect(Predicate.isTagged(failure, "DataMigrationError")).toBe(true);
      expect(stamps).toEqual([]);
      expect(after.calls.length).toBe(0);
    }),
  );

  it.effect("rejects duplicate names before touching the database", () =>
    Effect.gen(function* () {
      const { client, log } = makeFakeClient([]);
      const a1 = migrationSpy("2026-06-05-a");
      const a2 = migrationSpy("2026-06-05-a");
      const failure = yield* runSqliteDataMigrations(client, [a1.migration, a2.migration]).pipe(
        Effect.flip,
      );
      expect(Predicate.isTagged(failure, "DuplicateDataMigrationError")).toBe(true);
      expect(log).toEqual([]);
    }),
  );

  it.effect("sqliteDataMigration adapts promise-shaped bodies with typed failures", () =>
    Effect.gen(function* () {
      const { client, stamps } = makeFakeClient([]);
      let ran = 0;
      const ok = sqliteDataMigration("2026-06-05-promise", () => {
        ran++;
        return Promise.resolve(42);
      });
      yield* runSqliteDataMigrations(client, [ok]);
      expect(ran).toBe(1);
      expect(stamps).toEqual(["2026-06-05-promise"]);

      // oxlint-disable-next-line executor/no-promise-reject -- simulates a raw driver rejection at the adapter boundary under test
      const bad = sqliteDataMigration("2026-06-12-bad", () => Promise.reject("disk full"));
      const failure = yield* runSqliteDataMigrations(client, [ok, bad]).pipe(Effect.flip);
      expect(Predicate.isTagged(failure, "DataMigrationError")).toBe(true);
      expect((failure as DataMigrationError).migration).toBe("2026-06-12-bad");
      expect(ran).toBe(1);
    }),
  );
});
