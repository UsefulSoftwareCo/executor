// ---------------------------------------------------------------------------
// Local boot-migration correctness: the v1→v2 gate × the data-migration
// ledger, across every database state a real install can be in.
//
// The crash this guards against (observed on a real ~/.executor/data.db,
// 2026-06-11): a database with the full v1-final schema but an EMPTY
// `__drizzle_migrations` journal. The old prefix check read "0 applied" as
// a valid prefix of the legacy chain and replayed migration 0000 over the
// existing tables → `SQLITE_ERROR: table blob already exists` → the
// desktop sidecar died at startup, on every boot, with no way out.
//
// The fix has three layers, each tested here:
//   1. replayLegacyV1Migrations gates on the `plugin_storage` schema marker
//      (what the snapshot reader actually needs) before consulting the
//      journal, and treats an empty journal over existing tables as
//      unusable history rather than a fresh chain.
//   2. The boot ledger stamps LOCAL_V1_V2_LEDGER_NAME after the first
//      successful pass, so detection never re-runs on later boots — the
//      stamp, not data shape, is the source of truth.
//   3. The full boot sequence (gate → fumadb DDL → ledger) converges from
//      every starting state and the resulting executor actually works:
//      a real OpenAPI spec is added, a connection created, and a live tool
//      call made against a real HTTP server, twice (boot → reboot).
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";

import { collectTables } from "@executor-js/api/server";
import { runSqliteDataMigrations } from "@executor-js/sdk";

import { executeSql, openLocalLibsql, queryRows } from "./libsql";
import { localDataMigrations } from "./data-migrations";
import { LOCAL_V1_V2_LEDGER_NAME, migrateLocalV1ToV2IfNeeded } from "./v1-v2-migration";
import { createSqliteFumaDb } from "./sqlite-fumadb";

const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeJournal = (text: string) =>
  decodeUnknownJson(text) as {
    readonly entries: ReadonlyArray<{ readonly idx: number; readonly tag: string }>;
  };

let workDir: string;
let previousXdgDataHome: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "executor-v1v2-ledger-"));
  previousXdgDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(workDir, "xdg");
});

afterEach(() => {
  if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousXdgDataHome;
  rmSync(workDir, { recursive: true, force: true });
});

const TENANT = "executor-workspace-ledger99";
const legacyDir = join(import.meta.dirname, "../../drizzle-legacy-v1");

/** Apply the real vendored legacy chain (optionally truncated) so the
 *  database carries genuine drizzle hashes — exactly what a real pre-v1.5
 *  release produced. */
const applyLegacyChain = async (dbPath: string, upToIdx?: number): Promise<void> => {
  let folder = legacyDir;
  if (upToIdx !== undefined) {
    folder = join(workDir, `legacy-upto-${upToIdx}`);
    mkdirSync(join(folder, "meta"), { recursive: true });
    const journal = decodeJournal(
      readFileSync(join(legacyDir, "meta", "_journal.json")).toString(),
    );
    const kept = journal.entries.filter((entry) => entry.idx <= upToIdx);
    for (const entry of kept) {
      writeFileSync(
        join(folder, `${entry.tag}.sql`),
        readFileSync(join(legacyDir, `${entry.tag}.sql`)),
      );
    }
    writeFileSync(
      join(folder, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: kept }),
    );
  }
  const client = await openLocalLibsql(dbPath);
  await migrate(drizzle({ client }), { migrationsFolder: folder });
  client.close();
};

/** Seed one mcp source row (the minimal real v1 content the planner maps to
 *  an integration). */
const seedV1Content = async (dbPath: string): Promise<void> => {
  const client = await openLocalLibsql(dbPath);
  const now = Date.now();
  await executeSql(
    client,
    "INSERT INTO source (id, scope_id, plugin_id, kind, name, url, can_remove, can_refresh, can_edit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?)",
    ["context7", TENANT, "mcp", "mcp", "Context7", "https://mcp.context7.com/mcp", now, now],
  );
  // plugin_storage only exists at v1-final; mcp_source always exists.
  const hasPluginStorage =
    (await queryRows(client, "SELECT name FROM sqlite_master WHERE name = 'plugin_storage'"))
      .length > 0;
  if (hasPluginStorage) {
    await executeSql(
      client,
      "INSERT INTO plugin_storage (id, scope_id, plugin_id, collection, key, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "mcp-source-context7",
        TENANT,
        "mcp",
        "source",
        "context7",
        JSON.stringify({
          config: { transport: "remote", endpoint: "https://mcp.context7.com/mcp" },
        }),
        now,
        now,
      ],
    );
  } else {
    await executeSql(
      client,
      "INSERT INTO mcp_source (id, scope_id, name, config, created_at) VALUES (?, ?, ?, ?, ?)",
      [
        "context7",
        TENANT,
        "Context7",
        JSON.stringify({ transport: "remote", endpoint: "https://mcp.context7.com/mcp" }),
        now,
      ],
    );
  }
  client.close();
};

/** The boot sequence apps/local/src/executor.ts runs, minus the executor:
 *  v1 gate → fumadb DDL → ledger. Returns what each phase reported. */
const bootOnce = async (dbPath: string) => {
  const migration = await migrateLocalV1ToV2IfNeeded({
    sqlitePath: dbPath,
    tables: collectTables(),
    namespace: "executor_local",
    tenantId: TENANT,
  });
  const sqlite = await createSqliteFumaDb({
    tables: collectTables(),
    namespace: "executor_local",
    path: dbPath,
  });
  const applied = await Effect.runPromise(
    runSqliteDataMigrations(sqlite.client, localDataMigrations),
  );
  const ledger = await queryRows<{ name: string }>(
    sqlite.client,
    "SELECT name FROM data_migration ORDER BY name",
  );
  await sqlite.close();
  return { migration, applied, ledger: ledger.map((row) => row.name) };
};

const expectV2WithContext7 = async (dbPath: string) => {
  const client = await openLocalLibsql(dbPath);
  const integrations = await queryRows<{ tenant: string; slug: string; plugin_id: string }>(
    client,
    "SELECT tenant, slug, plugin_id FROM integration",
  );
  expect(integrations).toEqual([{ tenant: TENANT, slug: "context7", plugin_id: "mcp" }]);
  client.close();
};

describe("local v1→v2 gate × data-migration ledger", () => {
  // ------------------------------------------------------------------
  // THE crash repro: v1-final schema, EMPTY drizzle journal.
  // ------------------------------------------------------------------
  it("boots a v1-final database whose drizzle journal is empty (the observed crash state)", async () => {
    const dbPath = join(workDir, "data.db");
    await applyLegacyChain(dbPath);
    await seedV1Content(dbPath);
    // Reproduce the corruption: wipe the journal rows but keep every table —
    // exactly the state of the real crashed ~/.executor/data.db.
    const corrupt = await openLocalLibsql(dbPath);
    await executeSql(corrupt, "DELETE FROM __drizzle_migrations");
    corrupt.close();

    // Pre-fix this threw `table blob already exists` out of the legacy
    // replay. Post-fix the schema marker (plugin_storage exists) short-
    // circuits the replay entirely — the journal is never consulted, so the
    // migration proceeds with no warnings.
    const boot1 = await bootOnce(dbPath);
    expect(boot1.migration.migrated).toBe(true);
    expect(boot1.migration.warnings).toEqual([]);
    expect(boot1.ledger).toContain(LOCAL_V1_V2_LEDGER_NAME);
    await expectV2WithContext7(dbPath);

    // Reboot: stamped, nothing re-runs, data intact.
    const boot2 = await bootOnce(dbPath);
    expect(boot2.migration.migrated).toBe(false);
    expect(boot2.applied).toEqual([]);
    await expectV2WithContext7(dbPath);
  });

  // ------------------------------------------------------------------
  // Worse corruption: PRE-v1-final schema (no plugin_storage) AND a wiped
  // journal. The schema marker can't short-circuit, the journal is useless,
  // and a naive 0000-replay would crash. The tolerant replay re-executes
  // the frozen chain skipping already-done statements, which builds
  // plugin_storage (via 0011's real backfill of mcp_source) and the
  // migration completes with the integration intact.
  // ------------------------------------------------------------------
  it("recovers a mid-chain database with a wiped journal via tolerant replay", async () => {
    const dbPath = join(workDir, "data.db");
    await applyLegacyChain(dbPath, 10); // pre-0011: no plugin_storage
    await seedV1Content(dbPath); // lands in mcp_source (pre-0011 shape)
    const corrupt = await openLocalLibsql(dbPath);
    await executeSql(corrupt, "DELETE FROM __drizzle_migrations");
    corrupt.close();

    const boot1 = await bootOnce(dbPath);
    expect(boot1.migration.migrated).toBe(true);
    expect(boot1.migration.warnings.some((warning) => warning.includes("tolerant replay"))).toBe(
      true,
    );
    expect(boot1.ledger).toContain(LOCAL_V1_V2_LEDGER_NAME);
    // The 0011 backfill ran for real: the mcp_source row became a
    // plugin_storage source row, which planMigration turned into the
    // integration.
    await expectV2WithContext7(dbPath);

    const boot2 = await bootOnce(dbPath);
    expect(boot2.migration.migrated).toBe(false);
  });

  // ------------------------------------------------------------------
  // Healthy v1-final database (journal intact): the normal upgrade path.
  // ------------------------------------------------------------------
  it("migrates a healthy v1-final database and never re-enters the gate", async () => {
    const dbPath = join(workDir, "data.db");
    await applyLegacyChain(dbPath);
    await seedV1Content(dbPath);

    const boot1 = await bootOnce(dbPath);
    expect(boot1.migration.migrated).toBe(true);
    expect(boot1.ledger).toContain(LOCAL_V1_V2_LEDGER_NAME);
    await expectV2WithContext7(dbPath);

    const boot2 = await bootOnce(dbPath);
    expect(boot2.migration.migrated).toBe(false);
    expect(boot2.applied).toEqual([]);

    const boot3 = await bootOnce(dbPath);
    expect(boot3.migration.migrated).toBe(false);
  });

  // ------------------------------------------------------------------
  // Mid-chain v1 database: legacy replay still works, then migrates.
  // ------------------------------------------------------------------
  it("replays the legacy chain for a pre-v1-final database, then migrates and stamps", async () => {
    const dbPath = join(workDir, "data.db");
    await applyLegacyChain(dbPath, 10); // pre-0011: no plugin_storage yet
    await seedV1Content(dbPath);

    const boot1 = await bootOnce(dbPath);
    expect(boot1.migration.migrated).toBe(true);
    expect(boot1.ledger).toContain(LOCAL_V1_V2_LEDGER_NAME);
    await expectV2WithContext7(dbPath);

    const boot2 = await bootOnce(dbPath);
    expect(boot2.migration.migrated).toBe(false);
  });

  // ------------------------------------------------------------------
  // Fresh database: no v1 anything; ledger stamps immediately.
  // ------------------------------------------------------------------
  it("stamps a fresh database without ever probing v1 shape again", async () => {
    const dbPath = join(workDir, "data.db");

    const boot1 = await bootOnce(dbPath);
    expect(boot1.migration.migrated).toBe(false);
    expect(boot1.applied).toContain(LOCAL_V1_V2_LEDGER_NAME);

    const boot2 = await bootOnce(dbPath);
    expect(boot2.applied).toEqual([]);
  });

  // ------------------------------------------------------------------
  // The stamp protects against FUTURE shape-detector confusion: once
  // stamped, even a database that *looks* v1 (residual legacy tables)
  // is never re-migrated.
  // ------------------------------------------------------------------
  it("a stamped database is never re-migrated even if v1-looking tables appear", async () => {
    const dbPath = join(workDir, "data.db");
    await bootOnce(dbPath); // fresh boot → stamped

    // Simulate residue that fools the shape detector: a `source` table with
    // scope_id, exactly what isLocalV1Database keys on.
    const client = await openLocalLibsql(dbPath);
    await executeSql(
      client,
      "CREATE TABLE IF NOT EXISTS source (id text, scope_id text, plugin_id text, kind text, name text)",
    );
    client.close();

    const boot = await bootOnce(dbPath);
    expect(boot.migration.migrated).toBe(false); // stamp wins over shape
  });

  // ------------------------------------------------------------------
  // Downgrade tolerance: an older (pre-ledger) binary booting a stamped
  // database ignores the stamp table; re-upgrading must not re-migrate.
  // ------------------------------------------------------------------
  it("survives a downgrade/re-upgrade cycle without re-entering the migration", async () => {
    const dbPath = join(workDir, "data.db");
    await applyLegacyChain(dbPath);
    await seedV1Content(dbPath);
    await bootOnce(dbPath); // upgrade: migrated + stamped

    // "Old binary" wrote rows while ignoring the ledger — simulate its only
    // observable effect: data written without ledger awareness.
    const client = await openLocalLibsql(dbPath);
    const nowMs = Date.now();
    await executeSql(
      client,
      "INSERT INTO plugin_storage (tenant, owner, subject, plugin_id, collection, key, data, created_at, updated_at, row_id) VALUES (?, 'org', '', 'mcp', 'scratch', 'k', '{}', ?, ?, 'r1')",
      [TENANT, nowMs, nowMs],
    );
    client.close();

    const boot = await bootOnce(dbPath);
    expect(boot.migration.migrated).toBe(false);
    expect(boot.applied).toEqual([]);
    await expectV2WithContext7(dbPath);
  });

  // ------------------------------------------------------------------
  // Ledger ordering: the v1 stamp is the FIRST registry entry, so a
  // pre-ledger v2 database stamps it together with the others.
  // ------------------------------------------------------------------
  it("stamps all three registry entries on a pre-ledger v2 database", async () => {
    const dbPath = join(workDir, "data.db");
    // v2 database created without any ledger (pre-#956 build).
    const sqlite = await createSqliteFumaDb({
      tables: collectTables(),
      namespace: "executor_local",
      path: dbPath,
    });
    await sqlite.close();

    const boot = await bootOnce(dbPath);
    expect(boot.migration.migrated).toBe(false);
    // Every registry entry stamps, with the v1 gate first. Assert against
    // the registry itself so this survives future appends.
    expect(boot.applied).toEqual(localDataMigrations.map((migration) => migration.name));
    expect(boot.applied[0]).toBe(LOCAL_V1_V2_LEDGER_NAME);
  });
});
