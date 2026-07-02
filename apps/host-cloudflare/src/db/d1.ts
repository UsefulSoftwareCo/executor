import { drizzle } from "drizzle-orm/d1";
import {
  createDrizzleRuntimeSchemaFromTables,
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
import { runCloudflareDataMigrations } from "./data-migrations";

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
  // exposes one. The bring-up is idempotent `CREATE TABLE IF NOT EXISTS`, so run
  // it WITHOUT a transaction by handing the ensure a run-only view of the handle.
  await ensureDrizzleRuntimeSchemaFromTables({ run: (query) => drizzleDb.run(query) }, options);
  await runCloudflareDataMigrations(db, blobs);

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
