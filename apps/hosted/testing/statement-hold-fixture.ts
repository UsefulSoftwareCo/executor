import { Deferred, Effect, Layer, Option, Schema, type Tracer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { SqlClient, SqlError, type Statement } from "effect/sql";

const appAccess = "left join hosted_app_access p on p.id =";
const patCheck = "from apikey where key =";
const accountRows = /^SELECT .* FROM "executor_accounts"/s;
const toolCall = "mcp.tool.call";
const answeredChecks = {
  "app-access": "left join hosted_app_access p on",
  "account-access": "select p.account_id as account",
} as const;
const path = "/api/devtools/statement-hold";
const Arm = Schema.Union([
  Schema.Struct({ app: Schema.NonEmptyString, toolCall: Schema.optional(Schema.Literal(true)) }),
  Schema.Struct({
    after: Schema.Literals(["app-access", "account-access"]),
    id: Schema.NonEmptyString,
  }),
  Schema.Struct({ authentication: Schema.Literal("tool-call") }),
  Schema.Struct({ fail: Schema.Literal("tool-call-accounts") }),
]);

const isTemplate = (value: unknown): value is TemplateStringsArray =>
  Array.isArray(value) && "raw" in value;

const inToolCall = Effect.map(Effect.currentParentSpan, (span) => {
  let current: Tracer.AnySpan | undefined = span;
  while (current !== undefined && current._tag === "Span") {
    if (current.name === toolCall) return true;
    current = Option.getOrUndefined(current.parent);
  }
  return false;
}).pipe(Effect.orElseSucceed(() => false));

interface Hold {
  readonly app: string | undefined;
  readonly after: { readonly check: keyof typeof answeredChecks; readonly id: string } | undefined;
  readonly toolCall: boolean;
  readonly failAccounts: boolean;
  readonly reached: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

export const statementHoldFixture = Effect.gen(function* () {
  let armed: Hold | undefined;
  let current: Hold | undefined;
  const release = Effect.suspend(() => {
    const hold = current;
    armed = current = undefined;
    return hold === undefined ? Effect.void : Deferred.succeed(hold.release, undefined);
  });
  const held = (hold: Hold, run: Effect.Effect<unknown, unknown, unknown>) =>
    Deferred.succeed(hold.reached, undefined).pipe(
      Effect.andThen(Deferred.await(hold.release)),
      Effect.andThen(run),
    );
  const sql = (client: SqlClient.SqlClient): SqlClient.SqlClient =>
    new Proxy(client, {
      apply: (target, self, args: [unknown, ...unknown[]]) => {
        const [strings, ...params] = args;
        const hold = armed;
        if (hold === undefined || !isTemplate(strings)) return Reflect.apply(target, self, args);
        if (hold.after !== undefined) {
          const statement: Statement.Statement<unknown> = Reflect.apply(target, self, args);
          const [text, bound] = statement.compile();
          if (!text.includes(answeredChecks[hold.after.check]) || !bound.includes(hold.after.id))
            return statement;
          return Effect.tap(statement, () =>
            Effect.suspend(() => {
              if (armed !== hold) return Effect.void;
              armed = undefined;
              return Deferred.succeed(hold.reached, undefined).pipe(
                Effect.andThen(Deferred.await(hold.release)),
              );
            }),
          );
        }
        if (hold.failAccounts) {
          const statement: Statement.Statement<unknown> = Reflect.apply(target, self, args);
          if (!accountRows.test(statement.compile()[0])) return statement;
          return Effect.flatMap(inToolCall, (inside) => {
            if (!inside || armed !== hold) return statement;
            armed = undefined;
            return Effect.andThen(
              Deferred.succeed(hold.reached, undefined),
              Effect.fail(
                new SqlError.SqlError({
                  reason: new SqlError.ConnectionError({
                    cause: new Error("Connection closed"),
                    message: "Statement failure fixture: connection closed",
                    operation: "query",
                  }),
                }),
              ),
            );
          });
        }
        const text = strings.join("?");
        if (hold.app !== undefined) {
          if (!text.includes(appAccess) || !params.includes(hold.app))
            return Reflect.apply(target, self, args);
          if (hold.toolCall)
            return Effect.flatMap(inToolCall, (inside) => {
              if (!inside || armed !== hold) return target(strings, ...params);
              armed = undefined;
              return held(hold, target(strings, ...params));
            });
          armed = undefined;
          return held(hold, target(strings, ...params));
        }
        if (!text.includes(patCheck)) return Reflect.apply(target, self, args);
        return Effect.flatMap(inToolCall, (inside) => {
          if (!inside || armed !== hold) return target(strings, ...params);
          armed = undefined;
          return held(hold, target(strings, ...params));
        });
      },
    });
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "POST",
      path,
      Effect.gen(function* () {
        const arm = yield* HttpServerRequest.schemaBodyJson(Arm);
        yield* release;
        armed = current = {
          app: "app" in arm ? arm.app : undefined,
          after: "after" in arm ? { check: arm.after, id: arm.id } : undefined,
          toolCall: "app" in arm && arm.toolCall === true,
          failAccounts: "fail" in arm,
          reached: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        return HttpServerResponse.jsonUnsafe({ armed: true });
      }).pipe(Effect.orDie),
    ),
    HttpRouter.add(
      "GET",
      path,
      Effect.gen(function* () {
        const hold = current;
        return HttpServerResponse.jsonUnsafe({
          held: hold !== undefined && (yield* Deferred.isDone(hold.reached)),
        });
      }),
    ),
    HttpRouter.add(
      "DELETE",
      path,
      Effect.as(release, HttpServerResponse.jsonUnsafe({ released: true })),
    ),
  );
  return {
    provide: <A, E, R>(product: Effect.Effect<A, E, R>) =>
      product.pipe(Effect.updateService(SqlClient.SqlClient, sql)),
    routes,
  };
});
