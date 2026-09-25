/** Synthetic definition host for import failures, owned by the scenario scope. */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { createServer } from "node:http";

/** Serve controlled failures without calling a live integration or retaining its data. */
export const importUpstream = Effect.gen(function* () {
  const routes = Layer.mergeAll(
    HttpRouter.add("GET", "/json", HttpServerResponse.text('{"PRIVATE_SPEC_CONTENT":')),
    HttpRouter.add("GET", "/yaml", HttpServerResponse.text("PRIVATE_SPEC_CONTENT: [")),
    HttpRouter.add("GET", "/version", HttpServerResponse.json({ openapi: "2.0.0", paths: {} })),
    HttpRouter.add(
      "GET",
      "/redirect",
      HttpServerResponse.empty({
        status: 302,
        headers: { location: "/redirect?PRIVATE_REDIRECT" },
      }),
    ),
    HttpRouter.add("GET", "/missing-location", HttpServerResponse.empty({ status: 302 })),
    HttpRouter.add(
      "GET",
      "/blocked",
      HttpServerResponse.empty({
        status: 302,
        headers: { location: "http://169.254.169.254/PRIVATE_REDIRECT" },
      }),
    ),
    ...[401, 403, 404, 429, 503].map((status) =>
      HttpRouter.add(
        "GET",
        `/status/${status}`,
        HttpServerResponse.text("PRIVATE_RESPONSE_BODY", {
          status,
          headers: { "x-private-detail": "PRIVATE_RESPONSE_HEADER" },
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
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  return `http://127.0.0.1:${server.address.port}`;
});
