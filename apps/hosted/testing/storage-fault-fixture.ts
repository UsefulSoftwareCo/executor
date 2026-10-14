/**
 * Test host only: fails a read that binds one chosen ID inside a chosen operation, so a
 * scenario can show how a storage failure is reported where Executor reads saved state. The arm
 * names the spans the read must run inside (for example `sdk.invocation.snapshot`), so reads of
 * the same ID elsewhere, such as the host's own authorization reads, pass untouched. The
 * statement is replaced by one the database rejects, so the failure is a real SQL error from the
 * driver. Production entry points never provide it.
 */
import { Effect, Layer, Option, Schema, type Tracer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Statement from "effect/sql/Statement";

const path = "/api/devtools/storage-fault";
const Arm = Schema.Struct({
  binds: Schema.NonEmptyString,
  within: Schema.NonEmptyArray(Schema.NonEmptyString),
});

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
  /** Armed until a read binding the ID inside every named span reaches it; then reported until the next arm. */
  let armed: typeof Arm.Type | undefined;
  let failed: ReadonlyArray<string> | undefined;
  const transformer: Statement.Transformer = (statement, sql, _fiber, span) =>
    Effect.sync(() => {
      const fault = armed;
      if (fault === undefined) return statement;
      const [text, params] = statement.compile();
      if (!/^\s*select\b/iu.test(text) || !params.includes(fault.binds)) return statement;
      const spans = enclosing(span);
      if (!fault.within.every((name) => spans.includes(name))) return statement;
      armed = undefined;
      failed = spans;
      return sql`select executor_test_storage_fault()`;
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
    routes,
  };
});
