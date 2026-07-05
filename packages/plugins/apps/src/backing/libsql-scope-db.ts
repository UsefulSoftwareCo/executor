import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { createClient, type Client } from "@libsql/client";
import { Effect } from "effect";

import {
  ScopeDbError,
  type ScopeDb,
  type ScopeDbHandle,
  type ScopeWriteEvent,
} from "../seams/scope-db";

// ---------------------------------------------------------------------------
// libSQL-backed ScopeDb (self-hosted). One SQLite file per scope under
// `<root>/<scope>.db`. A control table `__versions` holds a monotonic counter
// per user table; every write statement bumps the counters for the tables it
// touched and emits a `ScopeWriteEvent` (the runtime forwards that to
// LiveChannel). Scope isolation is a separate file per scope — there is no
// cross-scope query path.
// ---------------------------------------------------------------------------

const VERSION_TABLE = "__scope_versions";

// Statements that mutate data. Determines whether a `sql` call bumps versions.
const WRITE_RE = /^\s*(insert|update|delete|replace|create|drop|alter)\b/i;

// Extract the table names a write statement targets (best-effort: covers the
// shapes authored tools produce — INSERT INTO x, UPDATE x, DELETE FROM x,
// CREATE TABLE x, REPLACE INTO x).
const targetsOf = (sql: string): string[] => {
  const out = new Set<string>();
  const patterns = [
    /\binsert\s+(?:or\s+\w+\s+)?into\s+["'`]?([a-zA-Z_][a-zA-Z0-9_]*)["'`]?/gi,
    /\breplace\s+into\s+["'`]?([a-zA-Z_][a-zA-Z0-9_]*)["'`]?/gi,
    /\bupdate\s+["'`]?([a-zA-Z_][a-zA-Z0-9_]*)["'`]?/gi,
    /\bdelete\s+from\s+["'`]?([a-zA-Z_][a-zA-Z0-9_]*)["'`]?/gi,
    /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?["'`]?([a-zA-Z_][a-zA-Z0-9_]*)["'`]?/gi,
    /\bdrop\s+table\s+(?:if\s+exists\s+)?["'`]?([a-zA-Z_][a-zA-Z0-9_]*)["'`]?/gi,
    /\balter\s+table\s+["'`]?([a-zA-Z_][a-zA-Z0-9_]*)["'`]?/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
      const name = m[1];
      if (name && name !== VERSION_TABLE) out.add(name);
    }
  }
  return [...out];
};

const toArgs = (values: readonly unknown[]): unknown[] =>
  values.map((v) => (v === undefined ? null : v));

const makeHandle = (
  scope: string,
  client: Client,
  emit: (event: ScopeWriteEvent) => void,
): ScopeDbHandle => {
  const ensureVersionTable = async () => {
    await client.execute(
      `CREATE TABLE IF NOT EXISTS ${VERSION_TABLE} (name TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0)`,
    );
  };

  const bump = async (tables: readonly string[]): Promise<{ table: string; version: number }[]> => {
    const bumped: { table: string; version: number }[] = [];
    for (const table of tables) {
      await client.execute({
        sql: `INSERT INTO ${VERSION_TABLE} (name, version) VALUES (?, 1)
              ON CONFLICT(name) DO UPDATE SET version = version + 1`,
        args: [table],
      });
      const row = await client.execute({
        sql: `SELECT version FROM ${VERSION_TABLE} WHERE name = ?`,
        args: [table],
      });
      bumped.push({ table, version: Number(row.rows[0]?.version ?? 0) });
    }
    return bumped;
  };

  const runStatement = <Row>(
    sql: string,
    args: unknown[],
  ): Effect.Effect<readonly Row[], ScopeDbError> =>
    Effect.tryPromise({
      try: async () => {
        await ensureVersionTable();
        const result = await client.execute({ sql, args: args as never });
        if (WRITE_RE.test(sql)) {
          const targets = targetsOf(sql);
          if (targets.length > 0) {
            const bumped = await bump(targets);
            if (bumped.length > 0) emit({ scope, tables: bumped });
          }
        }
        return result.rows as unknown as readonly Row[];
      },
      catch: (cause) =>
        new ScopeDbError({ message: `scope-db statement failed for scope ${scope}`, cause }),
    });

  return {
    sql: <Row = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.reduce((acc, part, i) => acc + part + (i < values.length ? "?" : ""), "");
      return runStatement<Row>(sql, toArgs(values));
    },
    exec: <Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) =>
      runStatement<Row>(sql, toArgs(params)),
    tableVersion: (table: string) =>
      Effect.tryPromise({
        try: async () => {
          await ensureVersionTable();
          const row = await client.execute({
            sql: `SELECT version FROM ${VERSION_TABLE} WHERE name = ?`,
            args: [table],
          });
          return Number(row.rows[0]?.version ?? 0);
        },
        catch: (cause) => new ScopeDbError({ message: "tableVersion failed", cause }),
      }),
    versions: () =>
      Effect.tryPromise({
        try: async () => {
          await ensureVersionTable();
          const rows = await client.execute(`SELECT name, version FROM ${VERSION_TABLE}`);
          const out = new Map<string, number>();
          for (const r of rows.rows) out.set(String(r.name), Number(r.version));
          return out as ReadonlyMap<string, number>;
        },
        catch: (cause) => new ScopeDbError({ message: "versions failed", cause }),
      }),
  };
};

export interface LibsqlScopeDbOptions {
  /** Directory holding one SQLite file per scope, or ":memory:" for tests. */
  readonly root: string;
}

const toUrl = (path: string): string => (path === ":memory:" ? path : `file:${resolve(path)}`);

// A reversible, collision-free filename key for a scope (Fix 9). A scope already
// composed only of filename-safe characters is used verbatim (so distinct
// filename-safe scopes stay distinct — "my-scope" and "my_scope" no longer
// collide). Any scope containing a character outside that set is hex-encoded in
// full under an `x-` prefix, which can never collide with a verbatim scope
// (verbatim scopes never start with `x-` followed by only hex... unless they
// literally are `x-<hex>`, so we also encode those). Two different scopes always
// produce two different keys.
const SAFE_SCOPE = /^[A-Za-z0-9._-]+$/;
const HEX_PREFIXED = /^x-[0-9a-f]*$/;
const scopeFileKey = (scope: string): string => {
  if (SAFE_SCOPE.test(scope) && !HEX_PREFIXED.test(scope)) return scope;
  const hex = Buffer.from(scope, "utf8").toString("hex");
  return `x-${hex}`;
};

export const makeLibsqlScopeDb = (options: LibsqlScopeDbOptions): ScopeDb => {
  const clients = new Map<string, Client>();
  const listeners = new Set<(event: ScopeWriteEvent) => void>();

  const emit = (event: ScopeWriteEvent) => {
    for (const listener of listeners) listener(event);
  };

  const clientFor = (scope: string): Client => {
    let client = clients.get(scope);
    if (!client) {
      if (options.root === ":memory:") {
        client = createClient({ url: ":memory:" });
      } else {
        mkdirSync(options.root, { recursive: true });
        // Collision-free filename (Fix 9): the old `replace(/[^..]/g, "_")`
        // COLLAPSED distinct scopes to the same file ("my-scope" and "my_scope"
        // -> "my_scope.db"), so two scopes shared one database. Encode the raw
        // scope instead: keep the common safe-identifier case readable, and for
        // anything with a character outside `[A-Za-z0-9._-]` fall back to a
        // reversible hex encoding of the full raw scope. Distinct scopes always
        // map to distinct filenames.
        const safe = scopeFileKey(scope);
        client = createClient({ url: toUrl(join(options.root, `${safe}.db`)) });
      }
      clients.set(scope, client);
    }
    return client;
  };

  return {
    forScope: (scope) =>
      Effect.try({
        try: () => makeHandle(scope, clientFor(scope), emit),
        catch: (cause) => new ScopeDbError({ message: `failed to open scope db ${scope}`, cause }),
      }),
    onWrite: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () =>
      Effect.sync(() => {
        for (const client of clients.values()) client.close();
        clients.clear();
        listeners.clear();
      }),
  };
};
