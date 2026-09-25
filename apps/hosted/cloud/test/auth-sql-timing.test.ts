/** Auth SQL timing spans belong to the operation that issued each query. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Option, Tracer } from "effect";
import {
  sql,
  type PostgresCursor,
  type PostgresPool,
  type PostgresPoolClient,
  type PostgresQueryResult,
} from "kysely";
import {
  authQueryAdapter,
  bindAuthQueries,
  timedAuthDatabase,
} from "../src/infrastructure/auth-database.ts";

/** A pg-shaped client whose queries resolve on a later turn with no rows. */
class SyntheticClient implements PostgresPoolClient {
  query<R>(sql: string, parameters: ReadonlyArray<unknown>): Promise<PostgresQueryResult<R>>;
  query<R>(cursor: PostgresCursor<R>): PostgresCursor<R>;
  query<R>(): Promise<PostgresQueryResult<R>> | PostgresCursor<R> {
    return new Promise((resolve) =>
      setTimeout(() => resolve({ command: "SELECT", rowCount: 0, rows: [] }), 1),
    );
  }
  release() {}
}
const syntheticPool: PostgresPool = {
  options: {},
  end: async () => {},
  connect: async () => new SyntheticClient(),
};

test("each query's timing span is a child of the span that issued it", async () => {
  const spans: Tracer.NativeSpan[] = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      // The pool and instance are built once, inside whichever span first needs them.
      const db = timedAuthDatabase(syntheticPool, yield* Effect.context<never>());
      const select = () => sql`select role from member`.execute(db);
      const adapter = {
        findOne: async () => {
          // Better Auth awaits its own work before it reaches Kysely.
          await Promise.resolve();
          return select();
        },
      };
      const bound = (name: string) =>
        Effect.flatMap(bindAuthQueries, (bind) => Effect.promise(() => bind(select))).pipe(
          Effect.withSpan(name),
        );
      yield* Effect.all(
        [
          bound("auth.current"),
          bound("auth.membership"),
          Effect.flatMap(authQueryAdapter(adapter), (traced) =>
            Effect.promise(() => traced.findOne()),
          ).pipe(Effect.withSpan("auth.organization")),
          Effect.promise(select).pipe(Effect.withSpan("unbound")),
        ],
        { concurrency: "unbounded" },
      );
    }).pipe(Effect.withSpan("invocation"), Effect.provideService(Tracer.Tracer, tracer)),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  const name = (span: Tracer.NativeSpan) =>
    spans.find((candidate) => candidate.spanId === Option.getOrUndefined(span.parent)?.spanId)
      ?.name;
  const timings = spans.filter((span) => span.name === "auth.sql.timing");
  assert.deepEqual(timings.map(name).sort(), [
    "auth.current",
    "auth.membership",
    "auth.organization",
    // Unbound Promise work keeps the invocation context.
    "invocation",
  ]);
  assert.ok(
    timings.every(
      (span) =>
        span.attributes.get("db.query.kind") === "RawNode" &&
        span.attributes.get("db.query.success") === true,
    ),
  );
});
