import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Ref } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { createServer } from "node:http";

/** A private credential-bearing API records requests instead of deleting any data. */
export const openapiPathUpstream = Effect.gen(function* () {
  const requests = yield* Ref.make<
    readonly { readonly path: string; readonly authenticated: boolean }[]
  >([]);
  const responses = {
    "200": {
      description: "Recorded",
      content: { "application/json": { schema: { type: "object" } } },
    },
  };
  const operation = (operationId: string, schema: unknown, style = "simple") => ({
    delete: {
      operationId,
      parameters: [{ name: "key", in: "path", required: true, style, schema }],
      responses,
    },
  });
  const document = {
    openapi: "3.1.0",
    info: { title: "Disposable path authority fixture", version: "1" },
    security: [{ key: [] }],
    components: {
      securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Fixture-Key" } },
    },
    paths: {
      "/projects/p/keys/{key}": operation("removeKey", { type: "string" }),
      "/projects/p/arrays/{key}": operation("removeArray", {
        type: "array",
        items: { type: "string" },
      }),
      "/projects/p/objects/{key}": operation("removeObject", {
        type: "object",
        additionalProperties: { type: "string" },
      }),
      "/projects/p/labels/{key}": operation("removeLabel", { type: "string" }, "label"),
      "/projects/p/keys": { delete: { operationId: "removeAllKeys", responses } },
      "/projects/p": { delete: { operationId: "removeProject", responses } },
    },
  };
  const services = yield* Layer.build(
    HttpRouter.serve(
      Layer.mergeAll(
        HttpRouter.add("GET", "/openapi.json", HttpServerResponse.json(document)),
        HttpRouter.add(
          "DELETE",
          "/*",
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const observed = {
              path: request.url,
              authenticated: request.headers["x-fixture-key"] === "synthetic-path-key",
            };
            yield* Ref.update(requests, (previous) => [...previous, observed]);
            return yield* HttpServerResponse.json(observed);
          }),
        ),
      ),
      { disableLogger: true, disableListenLog: true },
    ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  return { origin: `http://127.0.0.1:${server.address.port}`, requests: Ref.get(requests) };
});
