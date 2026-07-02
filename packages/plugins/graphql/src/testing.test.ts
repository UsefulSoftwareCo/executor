import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { OAuthTestServer } from "@executor-js/sdk/testing";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import { GraphqlTestServer, makeGreetingGraphqlSchema } from "./testing";

const TestLayer = GraphqlTestServer.layerWithOAuth({ schema: makeGreetingGraphqlSchema() }).pipe(
  Layer.provideMerge(OAuthTestServer.layer()),
);

const GreetingResponse = Schema.Struct({
  data: Schema.Struct({
    hello: Schema.String,
  }),
});
const decodeGreetingResponse = Schema.decodeUnknownEffect(GreetingResponse);

const graphqlRequest = (endpoint: string) =>
  HttpClientRequest.post(endpoint).pipe(
    HttpClientRequest.bodyJsonUnsafe({
      query: "query Greeting($name: String) { hello(name: $name) }",
      operationName: "Greeting",
      variables: { name: "Ada" },
    }),
  );

layer(TestLayer, { timeout: "15 seconds" })("GraphQL testing fixtures", (it) => {
  it.effect("serves an OAuth-protected Yoga GraphQL server", () =>
    Effect.gen(function* () {
      const oauth = yield* OAuthTestServer;
      const server = yield* GraphqlTestServer;

      const unauthorized = yield* HttpClient.execute(graphqlRequest(server.endpoint)).pipe(
        Effect.provide(FetchHttpClient.layer),
      );
      expect(unauthorized.status).toBe(401);

      const token = yield* oauth.completeAuthorizationCodeTokenFlow({ scopes: ["read"] });
      const authorized = yield* HttpClient.execute(
        graphqlRequest(server.endpoint).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${token.accessToken}`),
        ),
      ).pipe(Effect.provide(FetchHttpClient.layer));

      expect(authorized.status).toBe(200);
      const body = yield* authorized.json.pipe(Effect.flatMap(decodeGreetingResponse));
      expect(body).toEqual({ data: { hello: "Hello Ada" } });

      const requests = yield* server.requests;
      expect(requests.map((request) => request.payload.operationName)).toEqual(["Greeting"]);
    }),
  );
});
