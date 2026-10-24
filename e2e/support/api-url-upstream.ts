/** Per-run published GitHub emulator, plus a YAML copy of its public OpenAPI document. */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { BaseUrl, emulatorRequest } from "./emulators.ts";

export const apiUrlUpstream = Effect.gen(function* () {
  const created = yield* emulatorRequest("https://github.emulators.dev", "/_emulate/instances", {
    instance: `executor-api-url-${randomUUID()}`,
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ providerBaseUrl: BaseUrl }))));
  const origin = created.providerBaseUrl;
  yield* Effect.addFinalizer(() =>
    emulatorRequest(origin, "/_emulate/reset", {}).pipe(Effect.orDie),
  );
  const login = "api-url-operator";
  yield* emulatorRequest(origin, "/_emulate/seed", {
    users: [{ login, name: "API URL operator", email: "operator@example.test" }],
  });
  const issued = yield* emulatorRequest(origin, "/_emulate/credentials", {
    type: "bearer-token",
    login,
    scopes: ["repo"],
  }).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Struct({
          credential: Schema.Struct({ token: Schema.RedactedFromValue(Schema.NonEmptyString) }),
        }),
      ),
    ),
  );
  const document = yield* emulatorRequest(origin, "/openapi.json").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))),
  );
  const object = Schema.Record(Schema.String, Schema.Json);
  const paths = yield* Schema.decodeUnknownEffect(object)(document.paths);
  const components = yield* Schema.decodeUnknownEffect(object)(document.components);
  const schemes = yield* Schema.decodeUnknownEffect(object)(components.securitySchemes);
  // Only document hosting lives here. Every API call and GraphQL response comes from the
  // published emulator; there is no second implementation of GitHub's API in this repository.
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/openapi.yaml",
      HttpServerResponse.text(
        `---\n${JSON.stringify({ ...document, servers: [{ url: "https://unused.example.invalid" }] })}`,
        { contentType: "application/yaml" },
      ),
    ),
    HttpRouter.add("GET", "/invalid.json", HttpServerResponse.json({ invalid: true })),
    HttpRouter.add(
      "GET",
      "/partial.json",
      HttpServerResponse.json({
        ...document,
        components: {
          ...components,
          securitySchemes: { ...schemes, unknownAuth: { type: "http", scheme: "digest" } },
        },
        paths: {
          ...paths,
          "/unsupported": {
            get: {
              operationId: "unsupportedAuthentication",
              security: [{ unknownAuth: [] }],
              responses: { "200": { description: "Unsupported authentication" } },
            },
          },
        },
      }),
    ),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    ),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Definition server must listen on TCP");
  const documents = `http://127.0.0.1:${server.address.port}`;
  return {
    origin,
    login,
    token: issued.credential.token,
    openapi: `${origin}/openapi.json`,
    yaml: `${documents}/openapi.yaml`,
    graphql: `${origin}/graphql`,
    invalid: `${documents}/invalid.json`,
    partial: `${documents}/partial.json`,
  };
});
