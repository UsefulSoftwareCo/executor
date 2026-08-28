// ---------------------------------------------------------------------------
// Boot-level proof for issue #1771: a local database holding a legacy INTEGER
// `connection.expires_at` is unreadable, and the local boot sequence heals it.
//
// The migration body is unit-tested in the SDK. What this pins is the WIRING —
// that `localDataMigrations` actually carries the entry, early enough that the
// catalog reads which follow the ledger run see repaired rows. That wiring is
// the part that recovers a user's install; a correct migration nobody runs
// would leave the gateway just as empty.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { withQueryContext } from "@executor-js/fumadb/query";

import { collectTables } from "@executor-js/api/server";
import { runSqliteDataMigrations } from "@executor-js/sdk";

import { localDataMigrations } from "./data-migrations";
import { createSqliteFumaDb } from "./sqlite-fumadb";

const TENANT = "executor-workspace-1771";
const SUBJECT = "local";
// Epoch millis, the shape an OAuth token expiry takes.
const LEGACY_EXPIRES_AT = 1787321623456;

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "executor-legacy-bigint-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const openDb = (dbPath: string) =>
  createSqliteFumaDb({
    tables: collectTables(),
    namespace: "executor_local",
    path: dbPath,
  });

/** Write the row a pre-`bigint` build left behind: `expires_at` as a bare
 *  integer literal, which SQLite keeps in the INTEGER storage class. */
const seedLegacyConnection = async (dbPath: string): Promise<void> => {
  const sqlite = await openDb(dbPath);
  await sqlite.client.execute({
    sql: `INSERT INTO connection
      (row_id, tenant, owner, subject, integration, name, template, provider, item_ids,
       expires_at, created_at, updated_at)
      VALUES ('c1', ?, 'user', ?, 'acme', 'default', 'oauth2', 'file', ?,
       ${LEGACY_EXPIRES_AT}, ?, ?)`,
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

describe("local boot over a legacy bigint database", () => {
  it("cannot read the connection table before the migrations run", async () => {
    const dbPath = join(workDir, "data.db");
    await seedLegacyConnection(dbPath);

    const sqlite = await openDb(dbPath);
    const scoped = withQueryContext(sqlite.db, { tenant: TENANT, subject: SUBJECT });
    // The reported symptom: not a wrong value, a throw — so the gateway lost
    // every saved integration at once.
    await expect(scoped.findMany("connection", {})).rejects.toThrow(/type number/);
    await sqlite.close();
  });

  it("heals it through the local data-migration registry", async () => {
    const dbPath = join(workDir, "data.db");
    await seedLegacyConnection(dbPath);

    const sqlite = await openDb(dbPath);
    const applied = await Effect.runPromise(
      runSqliteDataMigrations(sqlite.client, localDataMigrations),
    );
    expect(applied).toContain("2026-08-28-bigint-storage-class");

    const scoped = withQueryContext(sqlite.db, { tenant: TENANT, subject: SUBJECT });
    const rows = await scoped.findMany("connection", {});
    expect(rows.map((row) => [row.name, Number(row.expires_at)])).toEqual([
      ["default", LEGACY_EXPIRES_AT],
    ]);
    await sqlite.close();
  });

  it("stays readable across a reboot", async () => {
    const dbPath = join(workDir, "data.db");
    await seedLegacyConnection(dbPath);

    const first = await openDb(dbPath);
    await Effect.runPromise(runSqliteDataMigrations(first.client, localDataMigrations));
    await first.close();

    // Second boot: the entry is stamped, so it is skipped — the data must
    // already be in the shape the mapper reads.
    const second = await openDb(dbPath);
    const applied = await Effect.runPromise(
      runSqliteDataMigrations(second.client, localDataMigrations),
    );
    expect(applied).not.toContain("2026-08-28-bigint-storage-class");

    const scoped = withQueryContext(second.db, { tenant: TENANT, subject: SUBJECT });
    const rows = await scoped.findMany("connection", {});
    expect(rows.map((row) => Number(row.expires_at))).toEqual([LEGACY_EXPIRES_AT]);
    await second.close();
  });
});
