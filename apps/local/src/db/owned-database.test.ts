/* oxlint-disable executor/no-try-catch-or-throw -- boundary: DB ownership tests must tear down held DB/lock handles and child processes even when assertions fail */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { collectTables } from "@executor-js/api/server";

import { acquireDataDirOwnership, DataDirOwnershipHeld } from "./data-dir-ownership";
import { executeSql, openLocalLibsql } from "./libsql";
import { openOwnedLocalDatabase, type OwnedLocalDatabase } from "./owned-database";

const LOCK_DATABASE_FILENAME = "data.db.owner-lock";
const TEST_NAMESPACE = "executor_local_owned_database_test";
const appRoot = join(import.meta.dirname, "../..");

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const makeOwnedTestDatabase = (dataDir: string, namespace = TEST_NAMESPACE) =>
  openOwnedLocalDatabase({
    dataDir,
    tables: collectTables(),
    namespace,
    tenantId: "owned-database-test-tenant",
  });

const makeWorkDir = (prefix: string): string =>
  mkdtempSync(join(tmpdir(), `executor-owned-database-${prefix}-`));

// data.db exists only after the sole owner opens it, so it is the witness that a
// non-owner never wrote anything: an ownership loser must fail before any DB I/O.
const servingDbPath = (dataDir: string): string => join(realpathSync(dataDir), "data.db");

describe("openOwnedLocalDatabase", () => {
  it("holds data-dir ownership until the serving database is closed", async () => {
    const workDir = makeWorkDir("lifetime");
    const dataDir = join(workDir, "data");
    let owned: OwnedLocalDatabase | null = null;

    try {
      owned = await makeOwnedTestDatabase(dataDir);
      const realDataDir = realpathSync(dataDir);
      const expectedLockPath = join(realDataDir, LOCK_DATABASE_FILENAME);

      expect(owned).toMatchObject({
        dataDir: realDataDir,
        sqlitePath: join(realDataDir, "data.db"),
        lockPath: expectedLockPath,
        migration: { migrated: false, warnings: [] },
      });

      await expect(acquireDataDirOwnership(dataDir)).rejects.toBeInstanceOf(DataDirOwnershipHeld);

      await owned.close();
      owned = null;

      const ownership = await acquireDataDirOwnership(dataDir);
      try {
        expect(ownership.lockPath).toBe(expectedLockPath);
      } finally {
        await ownership.release();
      }
    } finally {
      if (owned) await owned.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("refuses to open (and never creates data.db) when ownership is already held", async () => {
    const workDir = makeWorkDir("gate-order");
    const dataDir = join(workDir, "data");
    const ownership = await acquireDataDirOwnership(dataDir);

    try {
      await expect(makeOwnedTestDatabase(dataDir)).rejects.toBeInstanceOf(DataDirOwnershipHeld);
      // The gate runs before any migration or createSqliteFumaDb work, so the
      // loser cannot have written the serving database.
      expect(existsSync(servingDbPath(dataDir))).toBe(false);
    } finally {
      await ownership.release();
    }

    // Once the owner releases, a fresh open succeeds and creates data.db.
    const owned = await makeOwnedTestDatabase(dataDir);
    try {
      expect(existsSync(owned.sqlitePath)).toBe(true);
    } finally {
      await owned.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("keeps the gate independent of a deleted or corrupt server.json hint", async () => {
    const workDir = makeWorkDir("hint");
    const dataDir = join(workDir, "data");
    const owned = await makeOwnedTestDatabase(dataDir);

    try {
      // server.json is only a coordination hint. A garbage manifest must not let
      // a second process open the DB while the real owner is alive.
      const serverControlDir = join(realpathSync(dataDir), "server-control");
      mkdirSync(serverControlDir, { recursive: true });
      const manifestPath = join(serverControlDir, "server.json");
      writeFileSync(manifestPath, "{ this is not valid json");
      await expect(makeOwnedTestDatabase(dataDir)).rejects.toBeInstanceOf(DataDirOwnershipHeld);

      // Deleting the hint entirely changes nothing: the kernel lock is the gate.
      rmSync(manifestPath, { force: true });
      await expect(makeOwnedTestDatabase(dataDir)).rejects.toBeInstanceOf(DataDirOwnershipHeld);
    } finally {
      await owned.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("collides on one ownership lock across symlinked data dirs", async () => {
    const workDir = makeWorkDir("symlink");
    const realDir = join(workDir, "real");
    const linkDir = join(workDir, "link");
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, linkDir, "dir");

    const owned = await makeOwnedTestDatabase(realDir);
    try {
      const expectedLockPath = join(realpathSync(realDir), LOCK_DATABASE_FILENAME);
      expect(owned.lockPath).toBe(expectedLockPath);

      // The symlinked path resolves to the same real inode, so it must lose the
      // ownership race rather than open a second handle on the same data.db.
      await expect(acquireDataDirOwnership(linkDir)).rejects.toMatchObject({
        _tag: "DataDirOwnershipHeld",
        lockPath: expectedLockPath,
      });
    } finally {
      await owned.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("opens distinct real data dirs independently", async () => {
    const workDir = makeWorkDir("distinct");
    const dataDirA = join(workDir, "a");
    const dataDirB = join(workDir, "b");

    const [ownedA, ownedB] = await Promise.all([
      makeOwnedTestDatabase(dataDirA),
      makeOwnedTestDatabase(dataDirB),
    ]);
    try {
      expect(ownedA.lockPath).not.toBe(ownedB.lockPath);
      expect(existsSync(ownedA.sqlitePath)).toBe(true);
      expect(existsSync(ownedB.sqlitePath)).toBe(true);
    } finally {
      await Promise.all([ownedA.close(), ownedB.close()]);
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("recovers a v1->v2 migration killed mid-flip under ownership", async () => {
    const workDir = makeWorkDir("migration");
    const dataDir = join(workDir, "data");
    mkdirSync(dataDir, { recursive: true });
    const realDataDir = realpathSync(dataDir);
    const sqlitePath = join(realDataDir, "data.db");
    const journalPath = `${sqlitePath}.v1-v2-migration.json`;
    const tenantId = "owned-migration-workspace";
    const marker = join(workDir, "paused-flip");

    await seedMinimalV1Db(sqlitePath, tenantId);

    // Pause mid-flip: at "canonical-moved" the original data.db has already been
    // moved aside to the backup and the staged v2 DB has not been swapped in
    // yet, so a SIGKILL here leaves a journal the next owner must RESUME (via
    // completeJournaledFlip) rather than re-run from scratch.
    const child = spawnOpenOwnedChild({
      dataDir,
      tenantId,
      pauseAt: "canonical-moved",
      pauseFile: marker,
    });

    try {
      // Wait until the flip is mid-way under the child's ownership lock.
      const paused = await waitForMarker(marker, child, 30_000);
      expect(
        paused.markerFound,
        `child never reached the flip pause:\nstdout: ${child.stdout}\nstderr: ${child.stderr}`,
      ).toBe(true);
      // Mid-flip witness: the canonical data.db has been moved to the backup and
      // the staged copy is not yet installed.
      expect(existsSync(sqlitePath)).toBe(false);

      // SIGKILL the holder so the OS releases the ownership lock mid-flip.
      child.child.kill("SIGKILL");
      await waitForChildClose(child, 5_000);
      expect(child.child.signalCode).toBe("SIGKILL");

      // The journal proves the flip was interrupted; ownership must now be free
      // because the holder died.
      expect(existsSync(journalPath)).toBe(true);
      const reclaimed = await acquireDataDirOwnership(dataDir);
      await reclaimed.release();

      // The next sole owner resumes the journaled flip during open (recovery
      // runs completeJournaledFlip before the serving connection opens). The
      // steady-state migrate then sees an already-v2 DB, so migration.migrated
      // is false even though the on-disk DB is now v2 — the cleared journal and
      // the v2 rows are the real proof.
      const owned = await openOwnedLocalDatabase({
        dataDir,
        tables: collectTables(),
        namespace: "executor_local",
        tenantId,
      });
      try {
        expect(existsSync(journalPath)).toBe(false);
        const integrations = await owned.db.client.execute("SELECT tenant, slug FROM integration");
        expect(integrations.rows).toEqual([{ tenant: tenantId, slug: "stripe_api" }]);
      } finally {
        await owned.close();
      }
    } finally {
      if (child.child.exitCode === null && child.child.signalCode === null) {
        child.child.kill("SIGKILL");
        await waitForChildClose(child, 5_000);
      }
      child.child.stdout.destroy();
      child.child.stderr.destroy();
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Minimal v1 fixture + child-process harness
// ---------------------------------------------------------------------------

// A purpose-built v1-final database with exactly the tables readV1Snapshot
// reads. plugin_storage is present so the legacy schema replay is skipped, and
// a single openapi source makes isLocalV1Database return true and gives the
// migration real content to carry into v2.
const seedMinimalV1Db = async (dbPath: string, scopeId: string): Promise<void> => {
  const client = await openLocalLibsql(dbPath);
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: close the SQLite client even if seeding fails
  try {
    await client.execute("PRAGMA foreign_keys = OFF");
    await client.execute(
      "CREATE TABLE source (id text NOT NULL, scope_id text NOT NULL, plugin_id text NOT NULL, kind text NOT NULL, name text NOT NULL, PRIMARY KEY(scope_id, id))",
    );
    await client.execute(
      "CREATE TABLE plugin_storage (id text NOT NULL, scope_id text NOT NULL, plugin_id text NOT NULL, collection text NOT NULL, key text NOT NULL, data text NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL, PRIMARY KEY(scope_id, id))",
    );
    await client.execute(
      "CREATE TABLE credential_binding (id text NOT NULL, scope_id text NOT NULL, plugin_id text NOT NULL, source_id text NOT NULL, source_scope_id text NOT NULL, slot_key text NOT NULL, kind text NOT NULL, text_value text, secret_id text, connection_id text, created_at integer NOT NULL, updated_at integer NOT NULL, PRIMARY KEY(scope_id, id))",
    );
    await client.execute(
      "CREATE TABLE secret (id text NOT NULL, scope_id text NOT NULL, name text NOT NULL, provider text NOT NULL, owned_by_connection_id text, created_at integer NOT NULL, PRIMARY KEY(scope_id, id))",
    );
    await client.execute(
      "CREATE TABLE connection (id text NOT NULL, scope_id text NOT NULL, provider text NOT NULL, identity_label text, access_token_secret_id text, refresh_token_secret_id text, expires_at integer, provider_state text, PRIMARY KEY(scope_id, id))",
    );
    await client.execute(
      "CREATE TABLE tool_policy (id text NOT NULL, scope_id text NOT NULL, pattern text NOT NULL, action text NOT NULL, position text NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL, PRIMARY KEY(scope_id, id))",
    );
    await client.execute(
      "CREATE TABLE tool (id text NOT NULL, scope_id text NOT NULL, source_id text NOT NULL, plugin_id text NOT NULL, name text NOT NULL, description text NOT NULL, input_schema text, output_schema text, created_at integer NOT NULL, updated_at integer NOT NULL, PRIMARY KEY(scope_id, id))",
    );

    const now = Date.now();
    await executeSql(
      client,
      "INSERT INTO source (id, scope_id, plugin_id, kind, name) VALUES (?, ?, ?, ?, ?)",
      ["stripe_api", scopeId, "openapi", "openapi", "Stripe"],
    );
    await executeSql(
      client,
      "INSERT INTO plugin_storage (id, scope_id, plugin_id, collection, key, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "openapi-source-stripe",
        scopeId,
        "openapi",
        "source",
        "stripe_api",
        JSON.stringify({
          config: {
            spec: "{}",
            headers: {
              Authorization: { kind: "binding", slot: "header:authorization", prefix: "Bearer " },
            },
          },
        }),
        now,
        now,
      ],
    );
    await executeSql(
      client,
      "INSERT INTO credential_binding (id, scope_id, plugin_id, source_id, source_scope_id, slot_key, kind, text_value, secret_id, connection_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "stripe-auth",
        scopeId,
        "openapi",
        "stripe_api",
        scopeId,
        "header:authorization",
        "secret",
        null,
        "stripe-key",
        null,
        now,
        now,
      ],
    );
    await executeSql(
      client,
      "INSERT INTO secret (id, scope_id, name, provider, owned_by_connection_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["stripe-key", scopeId, "Stripe key", "file", null, now],
    );
  } finally {
    client.close();
  }
};

interface OwnedChild {
  readonly child: ChildProcessWithoutNullStreams;
  stdout: string;
  stderr: string;
}

interface ChildCloseResult {
  readonly markerFound: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
}

const spawnOpenOwnedChild = (input: {
  readonly dataDir: string;
  readonly tenantId: string;
  readonly pauseAt: string;
  readonly pauseFile: string;
}): OwnedChild => {
  const code = `
    import { collectTables } from "@executor-js/api/server";
    import { openOwnedLocalDatabase } from "./src/db/owned-database.ts";
    const owned = await openOwnedLocalDatabase({
      dataDir: process.env.EXECUTOR_TEST_DATA_DIR,
      tables: collectTables(),
      namespace: "executor_local",
      tenantId: process.env.EXECUTOR_TEST_TENANT,
    });
    console.log("OPENED");
    await owned.close();
  `;
  const child = spawn(process.execPath, ["-e", code], {
    cwd: appRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      EXECUTOR_TEST_DATA_DIR: input.dataDir,
      EXECUTOR_TEST_TENANT: input.tenantId,
      EXECUTOR_V1_V2_MIGRATION_PAUSE_AT: input.pauseAt,
      EXECUTOR_V1_V2_MIGRATION_PAUSE_FILE: input.pauseFile,
    },
    stdio: "pipe",
  });
  child.unref();

  const owned: OwnedChild = { child, stdout: "", stderr: "" };
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    owned.stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    owned.stderr += chunk;
  });
  return owned;
};

const waitForMarker = async (
  markerPath: string,
  owned: OwnedChild,
  timeoutMs: number,
): Promise<ChildCloseResult> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(markerPath)) {
      return {
        markerFound: true,
        exitCode: owned.child.exitCode,
        signalCode: owned.child.signalCode,
      };
    }
    if (owned.child.exitCode !== null || owned.child.signalCode !== null) {
      return {
        markerFound: false,
        exitCode: owned.child.exitCode,
        signalCode: owned.child.signalCode,
      };
    }
    await delay(25);
  }
  return { markerFound: false, exitCode: owned.child.exitCode, signalCode: owned.child.signalCode };
};

const waitForChildClose = async (owned: OwnedChild, timeoutMs: number): Promise<void> =>
  new Promise((resolve) => {
    if (owned.child.exitCode !== null || owned.child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      owned.child.off("close", onClose);
      resolve();
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolve();
    };
    owned.child.once("close", onClose);
  });
