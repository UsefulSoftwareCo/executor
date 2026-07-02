import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { OAuthTestServer } from "@executor-js/sdk/testing";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { OpenApiEchoTestServer } from "./testing";

const TestLayer = OpenApiEchoTestServer.layerWithOAuth().pipe(
  Layer.provideMerge(OAuthTestServer.layer()),
);

const ItemsResponse = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    name: Schema.String,
  }),
);
const decodeItemsResponse = Schema.decodeUnknownEffect(ItemsResponse);

layer(TestLayer, { timeout: "15 seconds" })("OpenAPI testing fixtures", (it) => {
  it.effect("serves an OAuth-protected HttpApi-backed OpenAPI echo server", () =>
    Effect.gen(function* () {
      const oauth = yield* OAuthTestServer;
      const server = yield* OpenApiEchoTestServer;

      const unauthorized = yield* HttpClient.execute(HttpClientRequest.get("/items")).pipe(
        Effect.provide(server.httpClientLayer),
      );
      expect(unauthorized.status).toBe(401);

      const token = yield* oauth.completeAuthorizationCodeTokenFlow({
        resource: server.baseUrl,
        scopes: ["read"],
      });
      const authorized = yield* HttpClient.execute(
        HttpClientRequest.get("/items").pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${token.accessToken}`),
        ),
      ).pipe(Effect.provide(server.httpClientLayer));

      expect(authorized.status).toBe(200);
      const items = yield* authorized.json.pipe(Effect.flatMap(decodeItemsResponse));
      expect(items).toEqual([
        { id: 1, name: "Widget" },
        { id: 2, name: "Gadget" },
      ]);

      const requests = yield* server.requests;
      expect(requests.map((request) => request.path)).toEqual(["/items", "/items"]);
    }),
  );
});
