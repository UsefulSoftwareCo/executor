/** An external HTTP dependency held until the test releases it. */
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Deferred, Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";

/** Own a loopback listener and release pending requests on every scope exit. */
export const requestGate = Effect.gen(function* () {
  const arrived = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  let completed = 0;
  yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
  const services = yield* Layer.build(
    HttpRouter.serve(
      Layer.mergeAll(
        HttpRouter.add(
          "GET",
          "/wait",
          Effect.gen(function* () {
            yield* Deferred.succeed(arrived, undefined);
            yield* Deferred.await(release);
            return HttpServerResponse.jsonUnsafe({ ready: true });
          }),
        ),
        HttpRouter.add(
          "GET",
          "/done",
          Effect.sync(() => {
            completed += 1;
            return HttpServerResponse.jsonUnsafe({ done: true });
          }),
        ),
      ),
      { disableLogger: true, disableListenLog: true },
    ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Gate requires a TCP listener");
  return {
    origin: `http://127.0.0.1:${server.address.port}`,
    arrived: Deferred.await(arrived).pipe(Effect.timeout("20 seconds")),
    release: Deferred.succeed(release, undefined),
    completed: Effect.sync(() => completed),
  };
});
