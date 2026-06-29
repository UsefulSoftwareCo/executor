import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  runCodeMigrations,
  type CodeMigration,
  type CodeMigrationSql,
} from "../../scripts/code-migrations/runner";

const makeFakeSql = (options: { readonly ledgerExists?: boolean; readonly stamped?: string[] }) => {
  const log: { readonly query: string; readonly params?: readonly unknown[] }[] = [];
  const stamped = [...(options.stamped ?? [])];
  const sql: CodeMigrationSql = {
    unsafe: (query, params) => {
      log.push({ query, params });
      if (query.includes("to_regclass")) {
        const rows = [
          { ledger_table: options.ledgerExists === false ? null : "cloud_code_migration" },
        ];
        return Promise.resolve(rows as never);
      }
      if (query.includes('SELECT "name" FROM "cloud_code_migration"')) {
        return Promise.resolve(stamped.map((name) => ({ name })) as never);
      }
      if (query.includes('INSERT INTO "cloud_code_migration"')) {
        stamped.push(String(params?.[0]));
      }
      return Promise.resolve([] as never);
    },
  };
  return { sql, log, stamped };
};

const migrationSpy = (name: string): { migration: CodeMigration; calls: boolean[] } => {
  const calls: boolean[] = [];
  return {
    calls,
    migration: {
      name,
      run: async ({ dryRun }) => {
        calls.push(dryRun);
        return { summary: `${name} done` };
      },
    },
  };
};

describe("runCodeMigrations", () => {
  it.effect("runs pending migrations and stamps them", () =>
    Effect.promise(async () => {
      const { sql, stamped } = makeFakeSql({});
      const a = migrationSpy("2026-06-20-a");
      const b = migrationSpy("2026-06-21-b");

      const applied = await runCodeMigrations(sql, [a.migration, b.migration], { log: () => {} });

      expect(applied).toEqual(["2026-06-20-a", "2026-06-21-b"]);
      expect(a.calls).toEqual([false]);
      expect(b.calls).toEqual([false]);
      expect(stamped).toEqual(["2026-06-20-a", "2026-06-21-b"]);
    }),
  );

  it.effect("dry run plans pending migrations without creating or stamping the ledger", () =>
    Effect.promise(async () => {
      const { sql, log, stamped } = makeFakeSql({ ledgerExists: false });
      const migration = migrationSpy("2026-06-20-a");

      const applied = await runCodeMigrations(sql, [migration.migration], {
        dryRun: true,
        log: () => {},
      });

      expect(applied).toEqual(["2026-06-20-a"]);
      expect(migration.calls).toEqual([true]);
      expect(stamped).toEqual([]);
      expect(log.some((entry) => entry.query.includes("CREATE TABLE"))).toBe(false);
      expect(log.some((entry) => entry.query.includes("INSERT INTO"))).toBe(false);
    }),
  );

  it.effect("skips stamped migrations", () =>
    Effect.promise(async () => {
      const { sql } = makeFakeSql({ stamped: ["2026-06-20-a"] });
      const a = migrationSpy("2026-06-20-a");
      const b = migrationSpy("2026-06-21-b");

      const applied = await runCodeMigrations(sql, [a.migration, b.migration], { log: () => {} });

      expect(applied).toEqual(["2026-06-21-b"]);
      expect(a.calls).toEqual([]);
      expect(b.calls).toEqual([false]);
    }),
  );

  it.effect("rejects duplicate names before touching the database", () =>
    Effect.promise(async () => {
      const { sql, log } = makeFakeSql({});
      const a = migrationSpy("2026-06-20-a");

      await expect(runCodeMigrations(sql, [a.migration, a.migration])).rejects.toThrow(
        "Duplicate code migration name",
      );
      expect(log).toEqual([]);
    }),
  );
});
