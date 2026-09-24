/** Local product sessions survive host restarts without entering the SDK schema. */
import { pgliteLayer } from "fumadb-effect/pglite";
import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { fumadb } from "fumadb-effect";
import { sqlAdapter } from "fumadb-effect/sql";
import { column, idColumn, schema, table } from "fumadb-effect/schema";
import { AuthStorageError, StoredBrowserSession, type BrowserSessions } from "../contracts/auth.ts";

const sessionSchema = schema({
  version: "1.1.0",
  tables: {
    sessions: table("browser_sessions", {
      hash: idColumn("hash", Schema.String, { type: "varchar(64)" }),
      expiresAt: column("expires_at", Schema.Date),
      access: column("access", Schema.Json).default("dashboard"),
    }),
  },
});
const database = fumadb({ namespace: "local-auth", schemas: [sessionSchema] });

/** Store token digests, expiry dates and access restrictions for all browser sessions. */
export const openBrowserSessions = (directory: string, sharedSql?: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const sql =
      sharedSql ??
      (yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
        const location = path.join(directory, "browser-auth.pglite");
        yield* fs.makeDirectory(location, { recursive: true, mode: 0o700 });
        yield* fs.chmod(location, 0o700);
        const context = yield* Layer.build(pgliteLayer({ dataDir: location }));
        return Context.get(context, SqlClient.SqlClient);
      }));
    const storage = database.client(sqlAdapter({ provider: "postgresql" }));
    const query = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      effect.pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(() => new AuthStorageError()),
      );
    yield* query(
      Effect.gen(function* () {
        const migrator = yield* storage.createMigrator;
        const version = yield* migrator.version;
        if (Option.isSome(version)) {
          if (version.value !== sessionSchema.version) return yield* new AuthStorageError();
          return;
        }
        yield* (yield* migrator.migrateToLatest()).execute;
      }),
    );
    const orm = storage.orm("1.1.0");
    const store: BrowserSessions = {
      put: (session, now) =>
        query(
          orm.transaction(
            Effect.gen(function* () {
              yield* orm.deleteMany("sessions", { where: (b) => b("expiresAt", "<=", now) });
              // App launches cannot evict their parent login or another app's sessions.
              const rows = yield* orm.findMany("sessions", {
                where: (b) => b("access", "=", session.access),
                orderBy: ["expiresAt", "desc"],
              });
              for (const row of rows.slice(63))
                yield* orm.deleteMany("sessions", { where: (b) => b("hash", "=", row.hash) });
              yield* orm.create("sessions", session);
            }),
          ),
        ),
      get: (hash) =>
        query(orm.findFirst("sessions", { where: (b) => b("hash", "=", hash) })).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.NullOr(StoredBrowserSession))),
          Effect.mapError(() => new AuthStorageError()),
        ),
      revoke: (hash) => query(orm.deleteMany("sessions", { where: (b) => b("hash", "=", hash) })),
    };
    return store;
  }).pipe(Effect.mapError(() => new AuthStorageError()));
