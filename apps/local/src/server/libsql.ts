import { createClient, type Client, type InArgs, type ResultSet } from "@libsql/client";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// libSQL connection helpers for the local server. The local CLI/daemon used to
// open a single in-process bun:sqlite handle that drizzle and the legacy
// importers shared; libSQL instead opens a connection per `createClient`, so
// the per-connection PRAGMAs (foreign_keys, WAL) must be re-applied on every
// client (they no longer carry over from one shared handle). These helpers
// centralize the `file:` URL construction and the per-connection PRAGMA set so
// every open site stays consistent.
//
// libSQL reads existing on-disk SQLite files (the legacy pre-FumaDB / pre-scope
// databases) directly via a `file:` URL — same file format — so the one-time
// legacy import/migration path works against the same files, just through the
// async libSQL client instead of synchronous bun:sqlite.
// ---------------------------------------------------------------------------

/**
 * Build a libSQL `file:` URL from a filesystem path. libSQL requires an
 * absolute path for `file:` URLs; `:memory:` passes through unchanged.
 */
export const toLibsqlFileUrl = (path: string): string =>
  path === ":memory:" ? path : `file:${resolve(path)}`;

/**
 * Open a libSQL client for a local on-disk DB and apply the per-connection
 * PRAGMAs (foreign_keys + WAL). Used for the long-lived FumaDB handle and the
 * live one-shot google-discovery migration.
 */
export const openLocalLibsql = async (path: string): Promise<Client> => {
  const client = createClient({ url: toLibsqlFileUrl(path) });
  // foreign_keys is strictly per-connection; WAL is a file-level mode set on
  // first enabling. Re-apply both since libSQL gives no shared handle.
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute("PRAGMA journal_mode = WAL");
  return client;
};

/**
 * Open a libSQL client for reading a legacy on-disk SQLite file. Readonly
 * intent is enforced by issuing only SELECT/PRAGMA reads (libSQL has no
 * per-open readonly flag in the bun:sqlite sense).
 */
export const openLegacyLibsql = (path: string): Client =>
  createClient({ url: toLibsqlFileUrl(path) });

// ---------------------------------------------------------------------------
// Typed query boundary. `@libsql/client` returns rows as the structural `Row`
// type (array-like with named getters). The legacy importers/probes read known
// column shapes off those rows, so this is the single place where the dynamic
// SQLite result is narrowed to the caller's row type — the SQL is the schema
// contract, mirroring what bun:sqlite's `query<Row, Args>()` generic provided.
// ---------------------------------------------------------------------------

const asRows = <T>(result: ResultSet): readonly T[] =>
  // oxlint-disable-next-line executor/no-double-cast -- boundary: the SQLite result columns are the schema contract for `T`; libSQL's `Row` is structurally the row, narrowed once here
  result.rows as unknown as readonly T[];

/** Run a SELECT and return its rows narrowed to `T` (the SQL is the contract). */
export const queryRows = async <T>(
  client: Client,
  sql: string,
  args?: InArgs,
): Promise<readonly T[]> => asRows<T>(await client.execute(args ? { sql, args } : sql));

/** Run a SELECT and return its first row narrowed to `T`, or undefined. */
export const queryFirst = async <T>(
  client: Client,
  sql: string,
  args?: InArgs,
): Promise<T | undefined> => (await queryRows<T>(client, sql, args))[0];
