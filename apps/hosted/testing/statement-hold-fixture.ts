/**
 * Test host only: holds the next statement that checks a caller's access to one app until the
 * scenario releases it, so a scenario can change saved state while that check waits. PostgreSQL
 * reads take no row locks, so no lock on rows a scenario created can hold them; the test host
 * holds the statement before it reaches the database instead. Production entry points never
 * provide it.
 */
import { Deferred, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql";

/** The join every check of a caller's access to one app makes, with the app as its parameter. */
const appAccess = "left join hosted_app_access p on p.id =";
const path = "/api/devtools/statement-hold";
const Arm = Schema.Struct({ app: Schema.NonEmptyString });

const isTemplate = (value: unknown): value is TemplateStringsArray =>
  Array.isArray(value) && "raw" in value;

interface Hold {
  readonly app: string;
  readonly reached: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

export const statementHoldFixture = Effect.gen(function* () {
  /** Armed until a statement reaches it; current until the scenario releases it. */
  let armed: Hold | undefined;
  let current: Hold | undefined;
  const release = Effect.suspend(() => {
    const hold = current;
    armed = current = undefined;
    return hold === undefined ? Effect.void : Deferred.succeed(hold.release, undefined);
  });
  const sql = (client: SqlClient.SqlClient): SqlClient.SqlClient =>
    new Proxy(client, {
      apply: (target, self, args: [unknown, ...unknown[]]) => {
        const [strings, ...params] = args;
        const hold = armed;
        if (
          hold === undefined ||
          !isTemplate(strings) ||
          !strings.join("?").includes(appAccess) ||
          !params.includes(hold.app)
        )
          return Reflect.apply(target, self, args);
        armed = undefined;
        return Deferred.succeed(hold.reached, undefined).pipe(
          Effect.andThen(Deferred.await(hold.release)),
          Effect.andThen(target(strings, ...params)),
        );
      },
    });
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "POST",
      path,
      Effect.gen(function* () {
        const { app } = yield* HttpServerRequest.schemaBodyJson(Arm);
        yield* release;
        armed = current = {
          app,
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
    /** Compose the product with its SQL client gated by the hold. */
    provide: <A, E, R>(product: Effect.Effect<A, E, R>) =>
      product.pipe(Effect.updateService(SqlClient.SqlClient, sql)),
    routes,
  };
});
