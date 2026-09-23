/** The hosted auth database is Postgres; other SQL drivers do not belong in this Worker. */
import { Database } from "@alchemy.run/better-auth/Database";
import { openPostgresPool } from "alchemy/SQL/PostgresDriver";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Layer, Option, Schema } from "effect";
import { Kysely, PostgresDialect, type QueryId } from "kysely";
import { DatabaseConnection } from "./database.ts";

const DriverCode = Schema.Struct({
  code: Schema.String.check(Schema.isPattern(/^(?:[0-9A-Z]{5}|E[A-Z_]{2,40})$/)),
});
class AuthDatabaseFailed extends Schema.TaggedError<AuthDatabaseFailed>()("AuthDatabaseFailed", {
  code: Schema.String,
}) {}

/** Resolve the native Hyperdrive binding once; Postgres keeps its pool in the invocation scope. */
export const cloudAuthDatabase = Layer.unwrap(
  Effect.gen(function* () {
    const connection = yield* Cloudflare.Hyperdrive.Connect(yield* DatabaseConnection);
    return Layer.succeed(
      Database,
      Database.of({
        provider: "postgres",
        runtime: Effect.gen(function* () {
          // Keep Alchemy's request-owned pg pool and Better Auth's Postgres dialect.
          const url = yield* connection.connectionString;
          const pool = yield* openPostgresPool(Effect.succeed(url));
          // This trusted host callback needs the complete invocation context.
          const context = yield* Effect.context<never>();
          const started = new WeakMap<QueryId, number>();
          const db = new Kysely<unknown>({
            dialect: new PostgresDialect({ pool }),
            plugins: [
              {
                transformQuery: ({ queryId, node }) => {
                  started.set(queryId, Date.now());
                  return node;
                },
                transformResult: ({ result }) => Promise.resolve(result),
              },
            ],
            log: (event) => {
              const start = started.get(event.query.queryId);
              started.delete(event.query.queryId);
              return Effect.runPromiseWith(context)(
                (event.level === "error"
                  ? Effect.fail(
                      new AuthDatabaseFailed({
                        code: Option.match(Schema.decodeUnknownOption(DriverCode)(event.error), {
                          onNone: () => "UnknownDriverError",
                          onSome: ({ code }) => code,
                        }),
                      }),
                    )
                  : Effect.void
                ).pipe(
                  Effect.withSpan("auth.sql.timing", {
                    attributes: {
                      "db.query.kind": event.query.query.kind,
                      "db.query.duration_ms": event.queryDurationMillis,
                      "db.query.success": event.level === "query",
                      "db.query.parameter_count": event.query.parameters.length,
                      "db.query.clock": "cloudflare-io",
                      ...(start === undefined
                        ? {}
                        : { "db.query.compile_to_result_ms": Date.now() - start }),
                    },
                  }),
                  Effect.withErrorReporting,
                  Effect.ignore,
                ),
              );
            },
          });
          // SSO account resolution and membership provisioning require real
          // transactions; the Kysely adapter otherwise runs callbacks without one.
          return { db, type: "postgres" as const, transaction: true };
        }),
      }),
    );
  }),
).pipe(Layer.provide(Cloudflare.Hyperdrive.ConnectBinding));
