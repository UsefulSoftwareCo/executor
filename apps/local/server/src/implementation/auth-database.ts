/** One embedded Postgres engine for local browser sessions and MCP OAuth. */
import { PgliteClient } from "@effect/sql-pglite";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { pgliteLayer } from "fumadb-effect/pglite";
import { openBrowserSessions } from "./session-store.ts";

export interface LocalAuthDatabase {
  readonly sql: SqlClient.SqlClient;
  readonly pglite: PgliteClient.PgliteClient;
}

interface LegacySession {
  readonly hash: string;
  readonly expires_at: string;
  readonly access: string;
}

/** Copy old session digests once. The source stays intact for rollback. */
const importBrowserSessions = (directory: string, sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql.unsafe(
      "CREATE TABLE IF NOT EXISTS local_auth_imports (source text PRIMARY KEY, completed_at timestamptz NOT NULL)",
    );
    const imported = yield* sql.unsafe<{ readonly source: string }>(
      "SELECT source FROM local_auth_imports WHERE source = 'browser-auth.pglite'",
    );
    if (imported.length > 0) return;

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const legacy = path.join(directory, "browser-auth.pglite");
    if (!(yield* fs.exists(legacy)) || (yield* fs.readDirectory(legacy)).length === 0) return;

    const rows = yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(pgliteLayer({ dataDir: legacy }));
        const oldSql = Context.get(context, SqlClient.SqlClient);
        return yield* oldSql.unsafe<LegacySession>(
          "SELECT hash, expires_at::text, access::text FROM browser_sessions",
        );
      }),
    );
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const row of rows)
          yield* sql`INSERT INTO browser_sessions (hash, expires_at, access)
            VALUES (${row.hash}, ${row.expires_at}::timestamptz, ${row.access}::jsonb)
            ON CONFLICT (hash) DO NOTHING`;
        yield* sql`INSERT INTO local_auth_imports (source, completed_at)
          VALUES ('browser-auth.pglite', now())`;
      }),
    );
  });

/** Build one scoped database, then migrate retained browser sessions into it. */
export const openLocalAuthDatabase = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const location = path.join(directory, "mcp-auth.pglite");
    yield* fs.makeDirectory(location, { recursive: true, mode: 0o700 });
    yield* fs.chmod(location, 0o700);
    const context = yield* Layer.build(pgliteLayer({ dataDir: location }));
    const shared = {
      sql: Context.get(context, SqlClient.SqlClient),
      pglite: Context.get(context, PgliteClient.PgliteClient),
    };
    // The local-auth migration table is namespaced and does not overlap Better Auth.
    yield* openBrowserSessions(directory, shared.sql);
    yield* importBrowserSessions(directory, shared.sql);
    return shared;
  });
