// Pre-scope-refactor executor CLI versions (<= 1.4.x) created a SQLite DB
// with a different shape: the `source` / `tool` / `definition` / `secret`
// tables had single-column `id` primary keys and no `scope_id` column.
// The scope-refactor added `scope_id` + composite `(scope_id, id)` PKs,
// which drizzle-kit generated as plain `CREATE TABLE` statements. That
// migration can't apply idempotently on top of an existing old-schema DB,
// so the upgrade path is to move the old file aside and let the fresh
// migration create the new shape. Users who need old data keep the
// backup; most never will — the rows are stale tool catalogs they'd
// re-fetch anyway.

import { type Client } from "@libsql/client";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";

import { openLegacyLibsql, queryFirst, queryRows } from "./libsql";

/**
 * Returns true when the DB at `dbPath` looks like it was written by a
 * pre-scope executor — has a `source` table but no `scope_id` column.
 * Fresh DBs (no `source` table yet) and current DBs both return false.
 *
 * Reads the legacy on-disk SQLite file through libSQL (same file format);
 * readonly intent is enforced by issuing only SELECT/PRAGMA reads.
 */
export const isPreScopeSchema = async (dbPath: string): Promise<boolean> => {
  if (!fs.existsSync(dbPath)) return false;
  const client = openLegacyLibsql(dbPath);
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: local SQLite schema probe must close the DB handle
  try {
    const tableExists = await queryFirst(
      client,
      "SELECT name FROM sqlite_master WHERE type='table' AND name='source'",
    );
    if (!tableExists) return false;
    const columns = await queryRows<{ readonly name: string }>(
      client,
      "PRAGMA table_info('source')",
    );
    return !columns.some((c) => c.name === "scope_id");
  } finally {
    client.close();
  }
};

/**
 * Move a pre-scope DB (and its WAL/SHM siblings) aside to
 * `<path>.pre-scopes-<timestamp>`. Returns the backup path if anything
 * was moved, otherwise null.
 */
export const moveAsidePreScopeDb = async (dbPath: string): Promise<string | null> => {
  if (!(await isPreScopeSchema(dbPath))) return null;
  // Timestamp alone is near-unique; the random suffix makes it actually
  // unique even if two moves ever land in the same millisecond.
  const suffix = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const backup = `${dbPath}.pre-scopes-${suffix}`;
  for (const ext of ["", "-wal", "-shm"]) {
    const src = dbPath + ext;
    if (fs.existsSync(src)) fs.renameSync(src, backup + ext);
  }
  return backup;
};

// ---------------------------------------------------------------------------
// Legacy secret routing — the `secret` table in the pre-scope DB has rows
// mapping secret id → provider. The secret *values* live in the provider
// backends (keychain, 1password, file-secrets) and survive the move-aside
// untouched. But without the routing row, non-enumerating providers
// (keychain) become unreachable: `secretsGet`'s fallback loop only asks
// providers that expose `list()`. We copy those routing rows forward into
// the new DB so post-upgrade resolution keeps working seamlessly.
// ---------------------------------------------------------------------------

export interface LegacySecret {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly createdAt: number;
}

export const readLegacySecrets = async (dbPath: string): Promise<readonly LegacySecret[]> => {
  if (!fs.existsSync(dbPath)) return [];
  const client = openLegacyLibsql(dbPath);
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: local SQLite legacy-row read must close the DB handle
  try {
    const tableExists = await queryFirst(
      client,
      "SELECT name FROM sqlite_master WHERE type='table' AND name='secret'",
    );
    if (!tableExists) return [];
    return await queryRows<LegacySecret>(
      client,
      "SELECT id, name, provider, created_at as createdAt FROM secret",
    );
  } finally {
    client.close();
  }
};

/**
 * Insert legacy routing rows into the new (scoped) `secret` table,
 * stamping the current scope id. Idempotent — uses INSERT OR IGNORE so
 * a row that the user already re-registered takes precedence.
 */
export const importLegacySecrets = async (
  client: Client,
  scopeId: string,
  secrets: readonly LegacySecret[],
): Promise<void> => {
  if (secrets.length === 0) return;
  for (const s of secrets) {
    await client.execute({
      sql: "INSERT OR IGNORE INTO secret (scope_id, id, name, provider, created_at) VALUES (?, ?, ?, ?, ?)",
      args: [scopeId, s.id, s.name, s.provider, s.createdAt],
    });
  }
};
