import { drizzle } from "drizzle-orm/d1";
import {
  createDrizzleRuntimeSchemaFromTables,
  createDrizzleRuntimeSchemaSqlFromTables,
  ensureDrizzleRuntimeSchemaFromTables,
} from "@executor-js/fumadb/adapters/drizzle";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

import {
  collectTables,
  createExecutorFumaDb,
  type ExecutorDbHandle,
} from "@executor-js/api/server";
import { makeR2BlobStore } from "@executor-js/cloudflare/blob-store";

import { CLOUDFLARE_NAMESPACE, CLOUDFLARE_SCHEMA_VERSION } from "../config";
import { prepareCloudflareD1Data } from "./data-migrations";

const SCHEMA_FINGERPRINT_TABLE = `private_${CLOUDFLARE_NAMESPACE}_schema_fingerprint`;
const SCHEMA_FINGERPRINT_ID = "runtime-schema";

const schemaFingerprint = async (statements: readonly string[]): Promise<string> => {
  const bytes = new TextEncoder().encode(statements.join("\0"));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const isMissingFingerprintTable = (error: unknown): boolean => {
  for (let current = error, depth = 0; current != null && depth < 8; depth += 1) {
    const record =
      typeof current === "object" ? (current as { message?: unknown; cause?: unknown }) : null;
    const message = typeof record?.message === "string" ? record.message : String(current);
    if (/no such table/i.test(message) && message.includes(SCHEMA_FINGERPRINT_TABLE)) return true;
    current = record?.cause ?? null;
  }
  return false;
};

const readPreparedSchemaFingerprint = async (db: D1Database): Promise<string | null> => {
  const session = db.withSession("first-primary");
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a missing marker table is the expected first-boot signal; every other D1 failure must still reject startup
  try {
    const result = await session
      .prepare(`SELECT fingerprint FROM "${SCHEMA_FINGERPRINT_TABLE}" WHERE id = ?`)
      .bind(SCHEMA_FINGERPRINT_ID)
      .all<{ readonly fingerprint?: unknown }>();
    const value = result.results[0]?.fingerprint;
    return typeof value === "string" ? value : null;
  } catch (error) {
    if (isMissingFingerprintTable(error)) return null;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: preserve the original D1 adapter rejection for every failure except the expected absent first-boot marker
    throw error;
  }
};

const storePreparedSchemaFingerprint = async (
  db: D1Database,
  fingerprint: string,
): Promise<void> => {
  const session = db.withSession("first-primary");
  await session
    .prepare(
      `CREATE TABLE IF NOT EXISTS "${SCHEMA_FINGERPRINT_TABLE}" (id text PRIMARY KEY NOT NULL, fingerprint text NOT NULL)`,
    )
    .run();
  await session
    .prepare(
      `INSERT INTO "${SCHEMA_FINGERPRINT_TABLE}" (id, fingerprint)
       VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET fingerprint = excluded.fingerprint`,
    )
    .bind(SCHEMA_FINGERPRINT_ID, fingerprint)
    .run();
};

// ---------------------------------------------------------------------------
// D1 DbProvider handle — the CF-native swap for self-host's libSQL handle.
//
// D1 is SQLite, so this reuses the SAME shared FumaDB assembly self-host uses:
// build the runtime schema from the fixed executor table set, open drizzle over the D1
// binding (drizzle-orm/d1), run the idempotent `ensureDrizzleRuntimeSchemaFrom-
// Tables` bring-up (generic CREATE TABLE IF NOT EXISTS over D1), and assemble
// `createExecutorFumaDb`. No driver to open (the binding is the connection), no
// PRAGMAs, no `close` teardown.
// ---------------------------------------------------------------------------

export const createD1ExecutorDb = async (
  db: D1Database,
  blobs: R2Bucket | undefined,
): Promise<ExecutorDbHandle> => {
  const options = {
    tables: collectTables(),
    namespace: CLOUDFLARE_NAMESPACE,
    version: CLOUDFLARE_SCHEMA_VERSION,
    provider: "sqlite" as const,
  };

  const schema = createDrizzleRuntimeSchemaFromTables(options);
  const drizzleDb = drizzle(db, { schema });

  // D1 rejects SQL `BEGIN TRANSACTION` / `SAVEPOINT` (it requires the JS batch
  // API), and the shared ensure wraps its DDL in a transaction when the handle
  // exposes one. A generated fingerprint lets every Worker/DO isolate prove the
  // expected generated schema was already prepared with one primary read instead of
  // replaying dozens of idempotent CREATE/ALTER statements on every database
  // open. The marker is stored only after the ensure, data migrations, and any
  // required post-compatibility ensure succeed. Data migrations retain their
  // own ledger and still run below on every open.
  const expectedFingerprint = await schemaFingerprint(
    createDrizzleRuntimeSchemaSqlFromTables(options),
  );
  const preparedFingerprint = await readPreparedSchemaFingerprint(db);
  const requiresSchemaPreparation = preparedFingerprint !== expectedFingerprint;
  if (requiresSchemaPreparation) {
    await ensureDrizzleRuntimeSchemaFromTables({ run: (query) => drizzleDb.run(query) }, options);
  }
  const migrationResult = await prepareCloudflareD1Data(db, blobs);
  if (requiresSchemaPreparation) {
    // Compatibility migrations can rebuild a legacy table. Re-run the
    // idempotent ensure before stamping so the database matches the generated
    // schema after migration, including newer nullable columns the legacy
    // rebuild did not know about.
    if (migrationResult.schemaChanged) {
      await ensureDrizzleRuntimeSchemaFromTables({ run: (query) => drizzleDb.run(query) }, options);
    }
    await storePreparedSchemaFingerprint(db, expectedFingerprint);
  }

  // `interactiveTransactions: false` — D1 rejects interactive transactions, so
  // the fuma adapter runs transaction callbacks directly (auto-commit per
  // statement). Without this, every runtime write that wraps in a transaction
  // (adding a source, etc.) emits `BEGIN` and 500s. libSQL keeps real
  // transactions; D1 (same `provider: "sqlite"`) opts out here.
  const { db: fumaDb, fuma } = createExecutorFumaDb(drizzleDb, {
    ...options,
    interactiveTransactions: false,
    // D1 caps bound parameters at 100 per query; createMany batches to fit
    // (otherwise a wide table like `tool` overflows with "too many SQL
    // variables" when a source derives many tools).
    maxBoundParameters: 100,
  });

  return {
    db: fumaDb,
    fuma,
    // The D1 binding owns its own lifecycle; nothing to release.
    close: async () => {},
    // Multi-MB values (resolved OpenAPI specs, introspection snapshots) go
    // through the blob seam straight to R2 — they never enter D1, which caps
    // a value at ~1-2MB. Without a bucket bound, the executor falls back to
    // the FumaDB blob table (small values only).
    blobs: blobs ? makeR2BlobStore(blobs) : undefined,
  };
};
