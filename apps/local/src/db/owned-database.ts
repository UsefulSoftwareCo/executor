/* oxlint-disable executor/no-try-catch-or-throw -- boundary: owned local database open composes the lifetime SQLite lock, crash-resumable migration, and serving DB handle */
import { dirname, join } from "node:path";

import type { FumaTables } from "@executor-js/sdk";

import { acquireDataDirOwnership } from "./data-dir-ownership";
import { createSqliteFumaDb, type SqliteFumaDb } from "./sqlite-fumadb";
import {
  migrateLocalV1ToV2IfNeeded,
  type LocalV1V2MigrationOptions,
  type LocalV1V2MigrationResult,
} from "./v1-v2-migration";

export interface OpenOwnedLocalDatabaseOptions<TTables extends FumaTables = FumaTables> {
  readonly dataDir: string;
  readonly tables: TTables;
  readonly namespace: string;
  readonly tenantId: string;
  readonly version?: string;
  readonly oauthMetadataFetch?: LocalV1V2MigrationOptions["oauthMetadataFetch"];
  readonly oauthMetadataTimeoutMs?: LocalV1V2MigrationOptions["oauthMetadataTimeoutMs"];
}

export interface OwnedLocalDatabase<TTables extends FumaTables = FumaTables> {
  /** Real data directory that owns this handle. Symlinked input paths collapse here. */
  readonly dataDir: string;
  readonly sqlitePath: string;
  readonly lockPath: string;
  readonly db: SqliteFumaDb<TTables>;
  readonly migration: LocalV1V2MigrationResult;
  readonly close: () => Promise<void>;
}

export const openOwnedLocalDatabase = async <const TTables extends FumaTables>(
  input: OpenOwnedLocalDatabaseOptions<TTables>,
): Promise<OwnedLocalDatabase<TTables>> => {
  const ownership = await acquireDataDirOwnership(input.dataDir);
  let db: SqliteFumaDb<TTables> | null = null;

  try {
    // Use the real directory captured by the ownership primitive so a symlinked
    // input path cannot be repointed between lock acquisition and data.db open.
    const dataDir = dirname(ownership.lockPath);
    const sqlitePath = join(dataDir, "data.db");

    const migration = await migrateLocalV1ToV2IfNeeded({
      sqlitePath,
      tables: input.tables,
      namespace: input.namespace,
      tenantId: input.tenantId,
      ...(input.oauthMetadataFetch !== undefined
        ? { oauthMetadataFetch: input.oauthMetadataFetch }
        : {}),
      ...(input.oauthMetadataTimeoutMs !== undefined
        ? { oauthMetadataTimeoutMs: input.oauthMetadataTimeoutMs }
        : {}),
    });

    const openedDb = await createSqliteFumaDb({
      tables: input.tables,
      namespace: input.namespace,
      path: sqlitePath,
      ...(input.version !== undefined ? { version: input.version } : {}),
    });
    db = openedDb;

    let closed = false;
    return {
      dataDir,
      sqlitePath,
      lockPath: ownership.lockPath,
      db: openedDb,
      migration,
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          await openedDb.close();
        } finally {
          await ownership.release();
        }
      },
    };
  } catch (cause) {
    try {
      if (db) await db.close();
    } finally {
      await ownership.release();
    }
    throw cause;
  }
};
