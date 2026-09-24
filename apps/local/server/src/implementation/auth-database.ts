/** Local authentication shares the main embedded Postgres engine. */
import { PgliteClient } from "@effect/sql-pglite";
import type { PGlite } from "@electric-sql/pglite";
import { pgDump } from "@electric-sql/pglite-tools/pg_dump";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { pgliteLayer } from "fumadb-effect/pglite";
import { openBrowserSessions } from "./session-store.ts";

export interface LocalAuthDatabase {
  readonly sql: SqlClient.SqlClient;
  readonly pglite: PgliteClient.PgliteClient;
  readonly main?: boolean;
}

interface LegacySession {
  readonly hash: string;
  readonly expires_at: string;
  readonly access: string;
}

/** Copy the newest retained session store once; never resurrect a revoked session. */
const importBrowserSessions = (directory: string, sql: SqlClient.SqlClient, shared: boolean) =>
  Effect.gen(function* () {
    yield* sql.unsafe(
      "CREATE TABLE IF NOT EXISTS local_auth_imports (source text PRIMARY KEY, completed_at timestamptz NOT NULL)",
    );
    const imported = yield* sql.unsafe<{ readonly source: string }>(
      "SELECT source FROM local_auth_imports LIMIT 1",
    );
    if (imported.length > 0) return;

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let source: string | undefined;
    let rows: readonly LegacySession[] = [];
    for (const name of shared
      ? ["mcp-auth.pglite", "browser-auth.pglite"]
      : ["browser-auth.pglite"]) {
      const legacy = path.join(directory, name);
      if (!(yield* fs.exists(legacy)) || (yield* fs.readDirectory(legacy)).length === 0) continue;
      const found = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(pgliteLayer({ dataDir: legacy }));
          const oldSql = Context.get(context, SqlClient.SqlClient);
          const tables = yield* oldSql.unsafe<{ readonly table_name: string }>(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'browser_sessions'",
          );
          if (tables.length === 0) return undefined;
          return yield* oldSql.unsafe<LegacySession>(
            "SELECT hash, expires_at::text, access::text FROM browser_sessions",
          );
        }),
      );
      if (found === undefined) continue;
      source = name;
      rows = found;
      break;
    }
    if (source === undefined) return;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const row of rows)
          yield* sql`INSERT INTO browser_sessions (hash, expires_at, access)
            VALUES (${row.hash}, ${row.expires_at}::timestamptz, ${row.access}::jsonb)
            ON CONFLICT (hash) DO NOTHING`;
        yield* sql`INSERT INTO local_auth_imports (source, completed_at)
          VALUES (${source}, now())`;
      }),
    );
  });

/** Build one scoped database, then migrate retained browser sessions into it. */
export const openLocalAuthDatabase = (directory: string, shared?: LocalAuthDatabase) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const database =
      shared ??
      (yield* Effect.gen(function* () {
        const location = path.join(directory, "mcp-auth.pglite");
        yield* fs.makeDirectory(location, { recursive: true, mode: 0o700 });
        yield* fs.chmod(location, 0o700);
        const context = yield* Layer.build(pgliteLayer({ dataDir: location }));
        return {
          sql: Context.get(context, SqlClient.SqlClient),
          pglite: Context.get(context, PgliteClient.PgliteClient),
        };
      }));
    // The local-auth migration table is namespaced and does not overlap Better Auth.
    yield* openBrowserSessions(directory, database.sql);
    yield* importBrowserSessions(directory, database.sql, shared !== undefined);
    return { ...database, main: shared !== undefined };
  });

/** Import retained OAuth grants after Better Auth has created its tables in the shared engine. */
export const importMcpAuth = (directory: string, database: LocalAuthDatabase) =>
  Effect.gen(function* () {
    const imported = yield* database.sql.unsafe<{ readonly source: string }>(
      "SELECT source FROM local_auth_imports WHERE source = 'mcp-auth.pglite.oauth'",
    );
    if (imported.length > 0) return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const legacy = path.join(directory, "mcp-auth.pglite");
    if (!(yield* fs.exists(legacy)) || (yield* fs.readDirectory(legacy)).length === 0) return;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(pgliteLayer({ dataDir: legacy }));
        const old = Context.get(context, PgliteClient.PgliteClient).pglite;
        const target = database.pglite.pglite;
        const dump = yield* Effect.promise(() =>
          pgDump({
            pg: old as PGlite,
            args: [
              "--data-only",
              "--column-inserts",
              "--exclude-table=public.browser_sessions",
              "--exclude-table=public.local_auth_imports",
              "--exclude-table=public.private_local-auth_settings",
            ],
          }).then((file) => file.text()),
        );
        const searchPath = yield* Effect.promise(() =>
          target.query<{ search_path: string }>("SHOW SEARCH_PATH"),
        );
        yield* Effect.promise(() =>
          target.transaction(async (transaction) => {
            await transaction.exec(dump);
            await transaction.query(
              "INSERT INTO public.local_auth_imports (source, completed_at) VALUES ('mcp-auth.pglite.oauth', now())",
            );
          }),
        );
        yield* Effect.promise(() =>
          target.exec(`SET SEARCH_PATH = ${searchPath.rows[0]?.search_path ?? "public"}`),
        );
      }),
    );
  });
