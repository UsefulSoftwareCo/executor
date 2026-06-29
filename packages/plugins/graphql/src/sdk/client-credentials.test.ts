import { expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ToolAddress,
  createExecutor,
} from "@executor-js/sdk";
import { OAuthTestServer, makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { graphqlPlugin } from "./plugin";
import { GraphqlTestServer, makeGreetingGraphqlSchema } from "../testing";

// End-to-end proof of the GraphQL service-account flow: a shared OAuth2
// client_credentials app mints a token the executor refreshes itself, and that
// token authenticates GraphQL introspection (at connect) AND query execution.
// The authorization server REQUIRES HTTP Basic on the token request, so a green
// run proves the executor sent `client_secret_basic` end to end.
const TestLayer = GraphqlTestServer.layerWithOAuth({ schema: makeGreetingGraphqlSchema() }).pipe(
  Layer.provideMerge(OAuthTestServer.layer({ requireClientAuthMethod: "basic", scopes: ["read"] })),
);

layer(TestLayer, { timeout: "20 seconds" })(
  "GraphQL client_credentials (service account) e2e",
  (it) => {
    it.effect("mints a client_credentials connection via HTTP Basic and runs a query", () =>
      Effect.gen(function* () {
        const oauth = yield* OAuthTestServer;
        const server = yield* GraphqlTestServer;

        const executor = yield* createExecutor(
          makeTestConfig({ plugins: [memoryCredentialsPlugin(), graphqlPlugin()] as const }),
        );

        // Endpointful oauth2 method: declares the token endpoint + the
        // service-account defaults. No introspectionJson (introspection is
        // deferred to connect and runs with the minted token).
        yield* executor.graphql.addIntegration({
          endpoint: server.endpoint,
          slug: "linear_graphql",
          authenticationTemplate: [
            {
              kind: "oauth2",
              slug: "oauth2",
              tokenUrl: oauth.tokenEndpoint,
              scopes: ["read"],
              defaultGrant: "client_credentials",
              defaultTokenEndpointAuthMethod: "basic",
            },
          ],
        });

        yield* executor.oauth.createClient({
          owner: "org",
          slug: OAuthClientSlug.make("linear-bot"),
          authorizationUrl: "",
          tokenUrl: oauth.tokenEndpoint,
          grant: "client_credentials",
          clientId: "test-client",
          clientSecret: "test-secret",
          tokenEndpointAuthMethod: "basic",
        });

        const started = yield* executor.oauth.start({
          owner: "org",
          client: OAuthClientSlug.make("linear-bot"),
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: IntegrationSlug.make("linear_graphql"),
          template: AuthTemplateSlug.make("oauth2"),
        });
        expect(started.status).toBe("connected");

        const result = yield* executor.execute(
          ToolAddress.make("tools.linear_graphql.org.main.query.hello"),
          { name: "Ada" },
        );
        expect(result).toEqual({ ok: true, data: { hello: "Hello Ada" } });

        // The single token mint authenticated via HTTP Basic; introspection and
        // the query reused the stored (unexpired) token, so no further mints.
        expect(yield* oauth.tokenRequestAuthMethods).toEqual(["basic"]);
      }),
    );
  },
);
