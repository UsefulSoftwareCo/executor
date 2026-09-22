/** A real provider boundary whose registration can pause, fail, and recover. */
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Deferred, Effect, Layer, Ref, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
class RegistrationFixtureFailed extends Schema.TaggedError<RegistrationFixtureFailed>()(
  "RegistrationFixtureFailed",
  {},
) {}
/** The test scope owns the listener and releases any held registration on every exit. */
export const webhookRegistrationFixture = Effect.gen(function* () {
  const received = yield* Deferred.make<void>(),
    release = yield* Deferred.make<void>(),
    healthy = yield* Ref.make(false);
  const routes = HttpRouter.add(
    "POST",
    "/watch",
    Effect.gen(function* () {
      yield* Deferred.succeed(received, undefined);
      if (!(yield* Ref.get(healthy))) yield* Deferred.await(release);
      return HttpServerResponse.empty({ status: (yield* Ref.get(healthy)) ? 200 : 503 });
    }),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    ),
  );
  yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* new RegistrationFixtureFailed();
  return {
    url: `http://127.0.0.1:${server.address.port}/watch`,
    requested: Deferred.await(received).pipe(Effect.timeout("30 seconds")),
    fail: Deferred.succeed(release, undefined),
    recover: Ref.set(healthy, true),
  };
});
