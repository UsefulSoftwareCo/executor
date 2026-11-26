import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { type Duration, Effect, Layer, Ref } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

export interface Export {
  readonly path: string;
  readonly outcome: "acknowledged" | "abandoned";
}

export const delayedCollector = (delay: Duration.Input) =>
  Effect.gen(function* () {
    const exports = yield* Ref.make<ReadonlyArray<Export>>([]);
    const record = (path: string, outcome: Export["outcome"]) =>
      Ref.update(exports, (all) => [...all, { path, outcome }]);
    const handler = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      yield* request.arrayBuffer;
      yield* Effect.sleep(delay).pipe(Effect.onInterrupt(() => record(request.url, "abandoned")));
      yield* record(request.url, "acknowledged");
      return HttpServerResponse.empty({ status: 200 });
    });
    const services = yield* Layer.build(
      HttpRouter.serve(HttpRouter.add("POST", "/*", handler), {
        disableLogger: true,
        disableListenLog: true,
      }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
      ),
    );
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
    if (!("port" in server.address)) return yield* Effect.die("Collector must listen on TCP");
    return {
      origin: `http://127.0.0.1:${server.address.port}`,
      exports: Ref.get(exports),
    };
  });
