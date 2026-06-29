/* oxlint-disable executor/no-try-catch-or-throw -- boundary: data-dir ownership is an async SQLite/file-lock primitive that maps lock contention to a typed failure */
import { createClient, type Client } from "@libsql/client";
import { Data } from "effect";
import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export class DataDirOwnershipHeld extends Data.TaggedError("DataDirOwnershipHeld")<{
  readonly message: string;
  readonly lockPath: string;
  readonly cause: unknown;
}> {}

export interface DataDirOwnership {
  readonly lockPath: string;
  readonly release: () => Promise<void>;
}

const LOCK_DATABASE_FILENAME = "data.db.owner-lock";

const toLibsqlFileUrl = (path: string): string => pathToFileURL(resolve(path)).href;

const ownerLockPath = (dataDir: string): string => {
  mkdirSync(dataDir, { recursive: true });
  // realpath collapses symlinked EXECUTOR_DATA_DIR values so normal local
  // installs contend on one lock inode. It intentionally does not claim to
  // detect hardlinked/bind-mounted data.db files in distinct real directories,
  // nor to make network-filesystem locks reliable.
  return join(realpathSync(dataDir), LOCK_DATABASE_FILENAME);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const isSqliteBusy = (cause: unknown): boolean => {
  if (!isRecord(cause)) return false;

  const code = cause.code;
  const extendedCode = cause.extendedCode;
  const rawCode = cause.rawCode;

  return (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_LOCKED" ||
    extendedCode === "SQLITE_BUSY" ||
    extendedCode === "SQLITE_LOCKED" ||
    (typeof extendedCode === "string" &&
      (extendedCode.startsWith("SQLITE_BUSY_") || extendedCode.startsWith("SQLITE_LOCKED_"))) ||
    rawCode === 5 ||
    rawCode === 6
  );
};

const openOwnershipLockClient = (lockPath: string): Client =>
  createClient({ url: toLibsqlFileUrl(lockPath) });

const configureOwnershipLockClient = async (client: Client): Promise<void> => {
  // Fail fast when another owner holds the exclusive lock. Ownership is a
  // try-not-wait operation; callers can then attach to the existing server hint.
  await client.execute("PRAGMA busy_timeout = 0");
  // Keep the lock DB in rollback-journal mode. The serving data.db still uses
  // WAL via openLocalLibsql/createSqliteFumaDb; the lock DB is deliberately a
  // separate file so exclusive locking does not constrain the serving DB.
  await client.execute("PRAGMA journal_mode = DELETE");
};

export const findDataDirOwnershipHeld = (cause: unknown): DataDirOwnershipHeld | null => {
  const visited = new WeakSet<object>();
  let current = cause;

  while (true) {
    if (current instanceof DataDirOwnershipHeld) return current;
    if (!isRecord(current)) return null;
    if (visited.has(current)) return null;

    visited.add(current);

    const nestedCause = current.cause;
    if (nestedCause === undefined) return null;
    current = nestedCause;
  }
};

export const acquireDataDirOwnership = async (dataDir: string): Promise<DataDirOwnership> => {
  const lockPath = ownerLockPath(dataDir);
  const client = openOwnershipLockClient(lockPath);

  try {
    await configureOwnershipLockClient(client);
    // Hold the transaction open for the ownership lifetime. In rollback-journal
    // mode, BEGIN EXCLUSIVE takes an EXCLUSIVE lock that is released by COMMIT
    // or ROLLBACK; do not commit here or ownership is gone.
    await client.execute("BEGIN EXCLUSIVE");
  } catch (cause) {
    client.close();
    if (isSqliteBusy(cause)) {
      throw new DataDirOwnershipHeld({
        lockPath,
        cause,
        message: `Executor data directory is already owned by another process: ${lockPath}`,
      });
    }
    throw cause;
  }

  let released = false;
  return {
    lockPath,
    release: async () => {
      if (released) return;
      released = true;
      try {
        await client.execute("ROLLBACK");
      } finally {
        client.close();
      }
    },
  };
};
