/**
 * Test host only: fails a read that binds one chosen ID inside a chosen operation, so a
 * scenario can show how a storage failure is reported where Executor reads saved state. The arm
 * names the spans the read must run inside (for example `sdk.invocation.snapshot`), so reads of
 * the same ID elsewhere, such as the host's own authorization reads, pass untouched. The
 * statement is replaced by one the database rejects, so the failure is a real SQL error from the
 * driver. It can instead fail the commit of the next transaction inside the named spans: the
 * database refuses the commit, or answers it with its timeout error, and rolls the transaction
 * back; or the commit applies and its answer is lost, as a dropped connection would lose it.
 * Production entry points never provide it.
 */
import { Effect, Layer, Option, Schema, type Tracer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { SqlClient, SqlError } from "effect/sql";
import * as Statement from "effect/sql/Statement";

const path = "/api/devtools/storage-fault";
const Within = Schema.NonEmptyArray(Schema.NonEmptyString);
const Arm = Schema.Union([
  Schema.Struct({ binds: Schema.NonEmptyString, within: Within }),
  Schema.Struct({ commit: Schema.Literals(["refused", "timeout", "lost"]), within: Within }),
]);
/**
 * Runs last in the transaction: a deferred trigger the database fires at COMMIT, which fails it.
 * PGlite has no statement timer, so the timeout is the error PostgreSQL's timer raises.
 */
const commitFault = (fault: "refused" | "timeout") => `
create temp table executor_test_commit_fault (id int) on commit drop;
create function pg_temp.executor_test_commit_fault() returns trigger language plpgsql as $$
begin
  ${
    fault === "refused"
      ? "raise exception 'storage fault fixture: commit refused';"
      : "perform pg_sleep(0.2); raise exception 'canceling statement due to statement timeout' using errcode = 'query_canceled';"
  }
end $$;
create constraint trigger executor_test_commit_fault after insert on executor_test_commit_fault
  deferrable initially deferred for each row execute function pg_temp.executor_test_commit_fault();
insert into executor_test_commit_fault values (1);`;

/** Names of the spans enclosing a statement, innermost first. */
const enclosing = (span: Tracer.AnySpan): ReadonlyArray<string> => {
  const names: Array<string> = [];
  let current: Option.Option<Tracer.AnySpan> = Option.some(span);
  while (Option.isSome(current)) {
    if (current.value._tag === "Span") names.push(current.value.name);
    current = current.value._tag === "Span" ? current.value.parent : Option.none();
  }
  return names;
};

export const storageFaultFixture = Effect.sync(() => {
  /**
   * Armed until a read binding the ID, or a transaction for a commit fault, inside every named span
   * reaches it; then reported until the next arm.
   */
  let armed: typeof Arm.Type | undefined;
  let failed: ReadonlyArray<string> | undefined;
  const transformer: Statement.Transformer = (statement, sql, _fiber, span) =>
    Effect.sync(() => {
      const fault = armed;
      if (fault === undefined || !("binds" in fault)) return statement;
      const [text, params] = statement.compile();
      if (!/^\s*select\b/iu.test(text) || !params.includes(fault.binds)) return statement;
      const spans = enclosing(span);
      if (!fault.within.every((name) => spans.includes(name))) return statement;
      armed = undefined;
      failed = spans;
      return sql`select executor_test_storage_fault()`;
    });
  const sql = (client: SqlClient.SqlClient): SqlClient.SqlClient =>
    new Proxy(client, {
      get: (target, property, receiver) =>
        property !== "withTransaction"
          ? Reflect.get(target, property, receiver)
          : <A, E, R>(work: Effect.Effect<A, E, R>) =>
              Effect.flatMap(
                Effect.currentParentSpan.pipe(
                  Effect.map(enclosing),
                  Effect.orElseSucceed((): ReadonlyArray<string> => []),
                ),
                (spans) => {
                  const fault = armed;
                  if (
                    fault === undefined ||
                    !("commit" in fault) ||
                    !fault.within.every((name) => spans.includes(name))
                  )
                    return target.withTransaction(work);
                  armed = undefined;
                  failed = spans;
                  const commit = fault.commit;
                  if (commit !== "lost")
                    return target.withTransaction(
                      Effect.tap(work, () => target.unsafe(commitFault(commit)).unprepared),
                    );
                  return Effect.andThen(
                    target.withTransaction(work),
                    Effect.die(
                      new SqlError.SqlError({
                        reason: new SqlError.ConnectionError({
                          cause: new Error("Connection closed"),
                          message: "Storage fault fixture: commit answer lost",
                          operation: "commit",
                        }),
                      }),
                    ),
                  );
                },
              ),
    });
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "POST",
      path,
      Effect.gen(function* () {
        armed = yield* HttpServerRequest.schemaBodyJson(Arm);
        failed = undefined;
        return HttpServerResponse.jsonUnsafe({ armed: true });
      }).pipe(Effect.orDie),
    ),
    HttpRouter.add(
      "GET",
      path,
      // `spans` names where the failed read ran, so a scenario can check the fault hit its target.
      Effect.sync(() =>
        HttpServerResponse.jsonUnsafe(
          failed === undefined ? { failed: false } : { failed: true, spans: failed },
        ),
      ),
    ),
    HttpRouter.add(
      "DELETE",
      path,
      Effect.sync(() => {
        armed = undefined;
        return HttpServerResponse.jsonUnsafe({ disarmed: true });
      }),
    ),
  );
  return {
    /** Every statement the server runs passes through the transformer. */
    transformer,
    /** Compose the product with its SQL client's transactions open to the commit fault. */
    provide: <A, E, R>(product: Effect.Effect<A, E, R>) =>
      product.pipe(Effect.updateService(SqlClient.SqlClient, sql)),
    routes,
  };
});
