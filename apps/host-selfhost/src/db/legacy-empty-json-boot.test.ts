// ---------------------------------------------------------------------------
// Boot-level proof for issue #2092: a self-host database holding `''` in a
// nullable `json` column of `connection` cannot list connections, and the
// self-host boot sequence heals it.
//
// The migration body is unit-tested in the SDK. What this pins is the WIRING:
// that `selfHostDataMigrations` carries the entry, so the `connections.list`
// every toolkit MCP session runs on `initialize` sees repaired rows.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { withQueryContext } from "@executor-js/fumadb/query";

import { runSqliteDataMigrations } from "@executor-js/sdk";

import { selfHostDataMigrations } from "./data-migrations";
import { createSelfHostDb } from "./self-host-db";

const TENANT = "executor-workspace-2092";
const SUBJECT = "user_a";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "executor-legacy-empty-json-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Write the row an older build left behind: `''` rather than NULL in the
 *  nullable `json` columns of `connection`. */
const seedLegacyConnection = async (dbPath: string): Promise<void> => {
  const sqlite = await createSelfHostDb({ path: dbPath });
  await sqlite.client.execute({
    sql: `INSERT INTO connection
      (row_id, tenant, owner, subject, integration, name, template, provider, item_ids,
       credential_write, last_health, provider_state, created_at, updated_at)
      VALUES ('c1', ?, 'user', ?, 'acme', 'default', 'oauth2', 'file', ?, '', '', '', ?, ?)`,
    args: [
      TENANT,
      SUBJECT,
      JSON.stringify({ token: "item_1" }),
      Math.floor(Date.now() / 1000),
      Math.floor(Date.now() / 1000),
    ],
  });
  await sqlite.close();
};

describe("self-host boot over legacy empty json columns", () => {
  it("cannot read the connection table before the migrations run", async () => {
    const dbPath = join(workDir, "data.db");
    await seedLegacyConnection(dbPath);

    const sqlite = await createSelfHostDb({ path: dbPath });
    const scoped = withQueryContext(sqlite.db, { tenant: TENANT, subject: SUBJECT });
    await expect(scoped.findMany("connection", {})).rejects.toThrow(/JSON/);
    await sqlite.close();
  });

  it("heals it through the self-host data-migration registry", async () => {
    const dbPath = join(workDir, "data.db");
    await seedLegacyConnection(dbPath);

    const sqlite = await createSelfHostDb({ path: dbPath });
    const applied = await Effect.runPromise(
      runSqliteDataMigrations(sqlite.client, selfHostDataMigrations),
    );
    expect(applied).toContain("2026-09-24-empty-json-columns");

    const scoped = withQueryContext(sqlite.db, { tenant: TENANT, subject: SUBJECT });
    const rows = await scoped.findMany("connection", {});
    expect(
      rows.map((row) => [
        row.name,
        row.credential_write ?? null,
        row.last_health ?? null,
        row.provider_state ?? null,
      ]),
    ).toEqual([["default", null, null, null]]);
    await sqlite.close();
  });
});
