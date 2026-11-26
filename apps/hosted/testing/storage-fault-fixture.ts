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
    transformer,
    provide: <A, E, R>(product: Effect.Effect<A, E, R>) =>
      product.pipe(Effect.updateService(SqlClient.SqlClient, sql)),
    routes,
  };
});
