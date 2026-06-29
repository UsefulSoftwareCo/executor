import { describe, expect, it } from "@effect/vitest";

import {
  planAuthConfigMigration,
  runSqliteAuthConfigMigration,
  type AuthConfigTransform,
  type SqliteAuthConfigClient,
} from "./migrate";

const transforms: Record<string, AuthConfigTransform> = {
  mcp: (config) => {
    const blob = config as { legacy?: boolean };
    return blob.legacy ? { migrated: true } : null;
  },
};

describe("planAuthConfigMigration", () => {
  it("plans rewrites only for known plugins whose transform rewrites", () => {
    const updates = planAuthConfigMigration(
      [
        { rowId: "a", pluginId: "mcp", config: { legacy: true } },
        { rowId: "b", pluginId: "mcp", config: { legacy: false } },
        { rowId: "c", pluginId: "keychain", config: { legacy: true } },
      ],
      transforms,
    );
    expect(updates).toEqual([{ rowId: "a", config: { migrated: true } }]);
  });
});

// A tiny scripted fake standing in for a libSQL client.
const makeFakeClient = (rows: Record<string, unknown>[]) => {
  const log: unknown[] = [];
  const client: SqliteAuthConfigClient = {
    execute: (stmt) => {
      log.push(stmt);
      if (typeof stmt === "string" && stmt.includes("sqlite_master")) {
        return Promise.resolve({ rows: [{ name: "integration" }] });
      }
      if (typeof stmt === "string" && stmt.startsWith("SELECT row_id")) {
        return Promise.resolve({ rows });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  return { client, log };
};

describe("runSqliteAuthConfigMigration", () => {
  it("rewrites legacy rows in a transaction and reports the count", async () => {
    const { client, log } = makeFakeClient([
      { row_id: "a", plugin_id: "mcp", config: JSON.stringify({ legacy: true }) },
      { row_id: "b", plugin_id: "mcp", config: JSON.stringify({ legacy: false }) },
      { row_id: "c", plugin_id: "mcp", config: "not json" },
    ]);
    const count = await runSqliteAuthConfigMigration(client, transforms);
    expect(count).toBe(1);
    expect(log).toContainEqual("BEGIN");
    expect(log).toContainEqual({
      sql: "UPDATE integration SET config = ? WHERE row_id = ?",
      args: [JSON.stringify({ migrated: true }), "a"],
    });
    expect(log).toContainEqual("COMMIT");
  });

  it("plans nothing on a canonical database (idempotent re-run)", async () => {
    const { client, log } = makeFakeClient([
      { row_id: "a", plugin_id: "mcp", config: JSON.stringify({ legacy: false }) },
    ]);
    expect(await runSqliteAuthConfigMigration(client, transforms)).toBe(0);
    expect(log).not.toContainEqual("BEGIN");
  });

  it("treats a database without the integration table as nothing to migrate", async () => {
    const client: SqliteAuthConfigClient = {
      execute: () => Promise.resolve({ rows: [] }),
    };
    expect(await runSqliteAuthConfigMigration(client, transforms)).toBe(0);
  });
});
