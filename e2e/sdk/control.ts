/** Loopback control for a foreground environment; each retained scenario owns a child scope. */
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  Console,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Redacted,
  Schema,
  Scope,
  Semaphore,
} from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { startEnvironment } from "./environment.ts";
import { createScenario, ScenarioFailed } from "./session.ts";
import { DataShape } from "./data.ts";
import { FixtureControl, ScenarioId } from "./contracts.ts";

const Identity = Schema.Struct({ id: ScenarioId });
const Role = Schema.Literals(["owner", "admin", "member"]);
const Create = Schema.Struct({ label: Schema.NonEmptyString });
const Seed = Schema.Struct({ id: ScenarioId, shape: DataShape });
const Open = Schema.Struct({ id: ScenarioId, role: Role });
const Request = Schema.Struct({
  id: ScenarioId,
  role: Role,
  method: Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: Schema.String,
  body: Schema.optional(Schema.Unknown),
});

/** Keep this process alive while exploring. Closing its scope releases all product resources. */
export const serveEnvironment = (input: {
  readonly target: "local" | "self-host" | "cloud" | "deployed";
  readonly database: "neon" | "planetscale";
  readonly handle: string;
  readonly headless?: boolean;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (yield* fs.exists(input.handle))
      return yield* new ScenarioFailed({
        operation: "Handle already exists; stop its environment or choose another path",
      });
    let written = false;
    // This finalizer runs last, so disappearance of the handle confirms all teardown finished.
    yield* Effect.addFinalizer(() =>
      written ? fs.remove(input.handle).pipe(Effect.orDie) : Effect.void,
    );
    const environment = yield* startEnvironment(input);
    const parent = yield* Effect.scope;
    const stopped = yield* Deferred.make<void>();
    const gate = yield* Semaphore.make(4);
    const token = Redacted.make(randomBytes(32).toString("hex"));
    type Scenario = Effect.Success<ReturnType<typeof createScenario>>;
    const sessions = new Map<
      string,
      { scenario: Scenario; scope: Scope.Closeable; gate: Semaphore.Semaphore }
    >();
    const parse = <A>(schema: Schema.ConstraintDecoder<A>) =>
      HttpServerRequest.HttpServerRequest.pipe(
        Effect.flatMap((request) => request.json),
        Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      );
    const use = <A, E, R>(id: string, operation: (scenario: Scenario) => Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        const entry = sessions.get(id);
        if (entry === undefined)
          return Effect.fail(new ScenarioFailed({ operation: "Scenario does not exist" }));
        return entry.gate.withPermits(1)(
          Effect.gen(function* () {
            if (!sessions.has(id))
              return yield* new ScenarioFailed({ operation: "Scenario was removed" });
            return yield* operation(entry.scenario).pipe(Scope.provide(entry.scope));
          }),
        );
      });
    const create = Effect.gen(function* () {
      const value = yield* parse(Create);
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const id = randomBytes(16).toString("hex");
          const scope = yield* Scope.fork(parent);
          const result = yield* restore(
            createScenario(environment.target, { id, label: value.label }).pipe(
              Scope.provide(scope),
            ),
          ).pipe(Effect.exit);
          if (Exit.isFailure(result)) {
            yield* Scope.close(scope, result);
            return yield* result;
          }
          sessions.set(id, { scenario: result.value, scope, gate: yield* Semaphore.make(1) });
          return yield* result.value.summary;
        }),
      );
    });
    const remove = Effect.gen(function* () {
      const { id } = yield* parse(Identity);
      const entry = sessions.get(id);
      if (entry !== undefined)
        yield* entry.gate.withPermits(1)(
          Effect.gen(function* () {
            sessions.delete(id);
            yield* Scope.close(entry.scope, Exit.succeed(undefined));
          }),
        );
      return { removed: true };
    });
    const endpoint = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const actual = Buffer.from(request.headers.authorization ?? ""),
          expected = Buffer.from(`Bearer ${Redacted.value(token)}`);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
          return HttpServerResponse.empty({ status: 401 });
        return yield* gate
          .withPermits(1)(operation)
          .pipe(
            Effect.map((result) => HttpServerResponse.jsonUnsafe(result)),
            Effect.catchCause((cause) =>
              Effect.logError(cause).pipe(
                Effect.as(
                  HttpServerResponse.jsonUnsafe(
                    {
                      error: "Scenario operation failed; inspect the environment log and evidence",
                    },
                    { status: 400 },
                  ),
                ),
              ),
            ),
          );
      });
    const routes = Layer.mergeAll(
      HttpRouter.add("POST", "/create", endpoint(create)),
      HttpRouter.add(
        "POST",
        "/list",
        endpoint(
          Effect.suspend(() =>
            Effect.forEach(sessions.values(), (entry) => entry.scenario.summary),
          ),
        ),
      ),
      HttpRouter.add(
        "POST",
        "/seed",
        endpoint(
          parse(Seed).pipe(
            Effect.flatMap(({ id, shape }) => use(id, (scenario) => scenario.seed(shape))),
          ),
        ),
      ),
      HttpRouter.add(
        "POST",
        "/open",
        endpoint(
          parse(Open).pipe(
            Effect.flatMap(({ id, role }) => use(id, (scenario) => scenario.open(role))),
          ),
        ),
      ),
      HttpRouter.add(
        "POST",
        "/request",
        endpoint(
          parse(Request).pipe(
            Effect.flatMap(({ id, role, method, path, body }) =>
              use(id, (scenario) =>
                Effect.gen(function* () {
                  return yield* scenario.request(role, method, path, body);
                }),
              ),
            ),
          ),
        ),
      ),
      HttpRouter.add("POST", "/remove", endpoint(remove)),
      HttpRouter.add(
        "POST",
        "/stop",
        endpoint(
          Effect.gen(function* () {
            yield* Deferred.succeed(stopped, undefined).pipe(
              Effect.delay("100 millis"),
              Effect.forkIn(parent),
            );
            return { stopping: true };
          }),
        ),
      ),
    );
    const services = yield* Layer.build(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
      ),
    );
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
    if (!("port" in server.address))
      return yield* new ScenarioFailed({ operation: "Control server requires TCP" });
    const control = FixtureControl.make({
      origin: `http://127.0.0.1:${server.address.port}`,
      token,
    });
    yield* fs.writeFileString(
      input.handle,
      yield* Schema.encodeEffect(Schema.fromJsonString(FixtureControl))(control),
      { flag: "wx", mode: 0o600 },
    );
    written = true;
    yield* Console.log(
      JSON.stringify({
        ready: true,
        target: input.target,
        handle: input.handle,
        evidence: environment.target.directory,
      }),
    );
    yield* Deferred.await(stopped);
  });
