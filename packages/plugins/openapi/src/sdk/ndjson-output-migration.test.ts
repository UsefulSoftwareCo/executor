import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { SqliteDataMigrationClient } from "@executor-js/sdk/core";

import { runSqliteNdjsonOutputMigration } from "./ndjson-output-migration";

// A tiny scripted fake standing in for a libSQL client.
const makeFakeClient = (
  operationRows: Record<string, unknown>[],
  options?: { readonly missingTable?: string },
) => {
  const log: (string | { readonly sql: string; readonly args: readonly unknown[] })[] = [];
  const client: SqliteDataMigrationClient = {
    execute: (stmt) => {
      log.push(stmt);
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      if (sql.includes("sqlite_master")) {
        const table = typeof stmt === "string" ? "" : String(stmt.args[0]);
        return Promise.resolve({
          rows: table === options?.missingTable ? [] : [{ name: table }],
        });
      }
      if (sql.includes("SELECT DISTINCT")) {
        return Promise.resolve({ rows: operationRows });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  return { client, log };
};

describe("runSqliteNdjsonOutputMigration", () => {
  it.effect("stale-marks each affected integration's connections", () =>
    Effect.gen(function* () {
      const { client, log } = makeFakeClient([
        { tenant: "t1", integration: "vercel_api" },
        { tenant: "t2", integration: "logs_api" },
      ]);
      const marked = yield* runSqliteNdjsonOutputMigration(client);
      expect(marked).toBe(2);

      const updates = log.filter(
        (stmt) => typeof stmt !== "string" && stmt.sql.includes("tools_synced_at = NULL"),
      );
      expect(updates.map((stmt) => (typeof stmt === "string" ? [] : stmt.args))).toEqual([
        ["t1", "vercel_api"],
        ["t2", "logs_api"],
      ]);
    }),
  );

  it.effect("skips malformed rows and marks nothing when no operation is NDJSON", () =>
    Effect.gen(function* () {
      const { client, log } = makeFakeClient([{ tenant: null, integration: "broken" }]);
      const marked = yield* runSqliteNdjsonOutputMigration(client);
      expect(marked).toBe(0);
      expect(
        log.some((stmt) => typeof stmt !== "string" && stmt.sql.includes("tools_synced_at")),
      ).toBe(false);
    }),
  );

  it.effect("treats a fresh database (missing tables) as nothing to migrate", () =>
    Effect.gen(function* () {
      for (const missingTable of ["connection", "plugin_storage"]) {
        const { client } = makeFakeClient([{ tenant: "t1", integration: "vercel_api" }], {
          missingTable,
        });
        expect(yield* runSqliteNdjsonOutputMigration(client)).toBe(0);
      }
    }),
  );
});
