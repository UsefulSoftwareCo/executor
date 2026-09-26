/** Serve an OpenAPI document that describes an older, looser version of an Executor endpoint. */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { createServer } from "node:http";

/**
 * A snapshot of the public registry list endpoint before its `name` query had a
 * pattern. Apps importing it send requests the current contract rejects.
 */
export const staleRegistryDocument = {
  openapi: "3.1.0",
  info: { title: "Executor registry snapshot", version: "0" },
  paths: {
    "/api/registry/apps": {
      get: {
        operationId: "listApps",
        parameters: [{ name: "name", in: "query", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Published apps",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
  },
};

/** Serve the stale document for one scenario scope; its operations target the Executor origin. */
export const staleOpenapiUpstream = Effect.gen(function* () {
  const services = yield* Layer.build(
    HttpRouter.serve(
      HttpRouter.add("GET", "/openapi.json", HttpServerResponse.jsonUnsafe(staleRegistryDocument)),
      { disableLogger: true, disableListenLog: true },
    ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  return `http://127.0.0.1:${server.address.port}`;
});
