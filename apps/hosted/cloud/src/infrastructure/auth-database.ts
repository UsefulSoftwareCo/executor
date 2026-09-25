/** The hosted auth database is Postgres; other SQL drivers do not belong in this Worker. */
import { AsyncLocalStorage } from "node:async_hooks";
import { Database } from "@alchemy.run/better-auth/Database";
import { openPostgresPool } from "alchemy/SQL/PostgresDriver";
import { Context, Effect, Layer, Option, Schema, Tracer } from "effect";
import { Kysely, PostgresDialect, type PostgresDialectConfig, type QueryId } from "kysely";
import { cloudDatabaseConnection } from "./database.ts";

const DriverCode = Schema.Struct({
  code: Schema.String.check(Schema.isPattern(/^(?:[0-9A-Z]{5}|E[A-Z_]{2,40})$/)),
});
class AuthDatabaseFailed extends Schema.TaggedError<AuthDatabaseFailed>()("AuthDatabaseFailed", {
  code: Schema.String,
}) {}

/**
 * The span whose Better Auth Promise work issued the current query. The auth
 * instance and its pool are built once per invocation, inside whichever span
 * first needed them, so their captured context cannot identify later callers.
 */
const queryParent = new AsyncLocalStorage<Tracer.AnySpan>();

/** Bind Better Auth Promise work to the calling span, so its SQL timing spans become its children. */
export const bindAuthQueries = Effect.map(
  Effect.option(Effect.currentParentSpan),
  (span) =>
    <A>(run: () => A): A =>
      Option.isSome(span) ? queryParent.run(span.value, run) : run(),
);

/** An adapter whose methods run as {@link bindAuthQueries} work of the calling span. */
export const authQueryAdapter = <A extends object>(adapter: A) =>
  Effect.map(
    bindAuthQueries,
    (bind) =>
      new Proxy(adapter, {
        get(target, key, receiver) {
          const value: unknown = Reflect.get(target, key, receiver);
          return typeof value === "function"
            ? (...args: ReadonlyArray<unknown>) => bind(() => Reflect.apply(value, target, args))
            : value;
        },
      }),
  );

/**
 * Better Auth's Kysely instance over one invocation's pool. Each query records an
 * `auth.sql.timing` span under the span that issued it, or under the invocation
 * context when no calling span was bound.
 */
export const timedAuthDatabase = (
  pool: PostgresDialectConfig["pool"],
  context: Context.Context<never>,
) => {
  const started = new WeakMap<QueryId, number>();
  return new Kysely<unknown>({
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
      const parent = queryParent.getStore();
      return Effect.runPromiseWith(
        parent === undefined ? context : Context.add(context, Tracer.ParentSpan, parent),
      )(
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
};

/** Resolve the selected database transport once; Postgres keeps its pool in the invocation scope. */
export const cloudAuthDatabase = Layer.unwrap(
  Effect.gen(function* () {
    const connection = yield* cloudDatabaseConnection;
    return Layer.succeed(
      Database,
      Database.of({
        provider: "postgres",
        runtime: Effect.gen(function* () {
          // Keep Alchemy's request-owned pg pool and Better Auth's Postgres dialect.
          const url = yield* connection.connectionString;
          const pool = yield* openPostgresPool(Effect.succeed(url));
          // This trusted host callback needs the complete invocation context.
          const db = timedAuthDatabase(pool, yield* Effect.context<never>());
          // SSO account resolution and membership provisioning require real
          // transactions; the Kysely adapter otherwise runs callbacks without one.
          return { db, type: "postgres" as const, transaction: true };
        }),
      }),
    );
  }),
);
