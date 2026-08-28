import { createClient, type Client, type InArgs, type ResultSet } from "@libsql/client";
import { chmodSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// libSQL connection helper for the local server. libSQL opens a connection per
// `createClient`, so the per-connection PRAGMAs (foreign_keys, WAL) must be
// re-applied on every client (they no longer carry over from one shared
// handle). This helper centralizes the `file:` URL construction and the
// per-connection PRAGMA set so every open site stays consistent.
// ---------------------------------------------------------------------------

/**
 * Build a libSQL `file:` URL from a filesystem path. libSQL requires an
 * absolute path for `file:` URLs; `:memory:` passes through unchanged.
 */
const toLibsqlFileUrl = (path: string): string =>
  path === ":memory:" ? path : `file:${resolve(path)}`;

/** The database and the two sidecars WAL mode creates beside it. */
const DB_FILE_SUFFIXES = ["", "-wal", "-shm"] as const;

/**
 * Restrict the database and its WAL sidecars to owner-only.
 *
 * SQLite creates these files with the process umask, which on a default macOS
 * or Linux install means 0644. The secret files next to them are deliberately
 * 0600 (`auth.json`, `server-connections.json`), and the database is not the
 * less sensitive of the two: it holds live `oauth_session.pkce_verifier`
 * values, health-check response samples, artifact previews, and — for stdio
 * MCP integrations created before the auth-method revamp — plaintext secret
 * env in `integration.config`.
 *
 * Called on open rather than on create, so a database written by an earlier
 * version is tightened too. That mirrors the `mode` + `chmod` pair in
 * `writeToken`, and for the same reason: `mode` only applies at creation.
 *
 * Best-effort per file. A filesystem with no POSIX modes, or a read-only
 * mount, must not stop the server booting over a permission it cannot set.
 */
const restrictDbFilePermissions = (path: string): void => {
  if (path === ":memory:") return;
  const base = resolve(path);
  for (const suffix of DB_FILE_SUFFIXES) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: chmod on a file that may not exist yet or a filesystem without POSIX modes; hardening must never block boot
    try {
      chmodSync(`${base}${suffix}`, 0o600);
    } catch {
      // Sidecars only exist once WAL has been used, and not every filesystem
      // supports chmod. Either way the open proceeds.
    }
  }
};

/**
 * Open a libSQL client for a local on-disk DB and apply the per-connection
 * PRAGMAs (foreign_keys + WAL). Used for the long-lived FumaDB handle.
 */
export const openLocalLibsql = async (path: string): Promise<Client> => {
  const client = createClient({ url: toLibsqlFileUrl(path) });
  // foreign_keys is strictly per-connection; WAL is a file-level mode set on
  // first enabling. Re-apply both since libSQL gives no shared handle.
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute("PRAGMA journal_mode = WAL");
  // After the WAL pragma, so `-wal`/`-shm` exist to be tightened.
  restrictDbFilePermissions(path);
  // busy_timeout is per-connection (default 0 = fail immediately on a lock).
  // Under the supervised-daemon model a single process owns this file, but a
  // second OS process can still transiently hold the write lock (e.g. a CLI
  // tool, the v1→v2 migration reader, or a launchd restart racing the old
  // pid). Give writers a 5s retry window instead of an instant SQLITE_BUSY.
  // Matches the self-host open path (self-host-db.ts).
  await client.execute("PRAGMA busy_timeout = 5000");
  return client;
};

const asRows = <T>(result: ResultSet): readonly T[] =>
  // oxlint-disable-next-line executor/no-double-cast -- boundary: SQLite result columns are the schema contract for T; libSQL rows are narrowed once here
  result.rows as unknown as readonly T[];

export const executeSql = async (client: Client, sql: string, args?: InArgs): Promise<ResultSet> =>
  client.execute(args ? { sql, args } : sql);

export const queryRows = async <T>(
  client: Client,
  sql: string,
  args?: InArgs,
): Promise<readonly T[]> => asRows<T>(await executeSql(client, sql, args));

export const queryFirst = async <T>(
  client: Client,
  sql: string,
  args?: InArgs,
): Promise<T | null> => (await queryRows<T>(client, sql, args))[0] ?? null;
