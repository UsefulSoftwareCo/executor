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

import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";

/**
 * Returns true when the DB at `dbPath` looks like it was written by a
 * pre-scope executor — has a `source` table but no `scope_id` column.
 * Fresh DBs (no `source` table yet) and current DBs both return false.
 */
export const isPreScopeSchema = (dbPath: string): boolean => {
  if (!fs.existsSync(dbPath)) return false;
  const db = new Database(dbPath, { readonly: true });
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: local SQLite schema probe must close the DB handle
  try {
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='source'")
      .get();
    if (!tableExists) return false;
    const columns = db.prepare("PRAGMA table_info('source')").all() as ReadonlyArray<{
      readonly name: string;
    }>;
    return !columns.some((c) => c.name === "scope_id");
  } finally {
    db.close();
  }
};

/**
 * Move a pre-scope DB (and its WAL/SHM siblings) aside to
 * `<path>.pre-scopes-<timestamp>`. Returns the backup path if anything
 * was moved, otherwise null.
 */
export const moveAsidePreScopeDb = (dbPath: string): string | null => {
  if (!isPreScopeSchema(dbPath)) return null;
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

export const readLegacySecrets = (dbPath: string): readonly LegacySecret[] => {
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: local SQLite legacy-row read must close the DB handle
  try {
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='secret'")
      .get();
    if (!tableExists) return [];
    return db
      .prepare("SELECT id, name, provider, created_at as createdAt FROM secret")
      .all() as LegacySecret[];
  } finally {
    db.close();
  }
};

/**
 * Insert legacy routing rows into the new (scoped) `secret` table,
 * stamping the current scope id. Idempotent — uses INSERT OR IGNORE so
 * a row that the user already re-registered takes precedence.
 */
export const importLegacySecrets = (
  db: Database,
  scopeId: string,
  secrets: readonly LegacySecret[],
): void => {
  if (secrets.length === 0) return;
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO secret (scope_id, id, name, provider, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (const s of secrets) {
    stmt.run(scopeId, s.id, s.name, s.provider, s.createdAt);
  }
};
