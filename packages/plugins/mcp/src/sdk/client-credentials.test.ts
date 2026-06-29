import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ToolAddress,
  createExecutor,
} from "@executor-js/sdk";
import { OAuthTestServer, makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { mcpPlugin } from "./plugin";
import { makeEchoMcpServer, serveMcpServerWithOAuth } from "../testing";

// End-to-end proof of the MCP service-account flow: a shared OAuth2
// client_credentials app (one bot identity, no per-user sign-in) mints a token
// the executor refreshes itself, and that token authenticates real MCP tool
// calls. The authorization server REQUIRES HTTP Basic on the token request
// (Linear's client_credentials grant does), so a green run proves the executor
// sent `client_secret_basic` end to end, not just that some token worked.
layer(OAuthTestServer.layer({ requireClientAuthMethod: "basic", scopes: ["read"] }), {
  timeout: "20 seconds",
})("MCP client_credentials (service account) e2e", (it) => {
  it.effect("mints a client_credentials connection via HTTP Basic and invokes a tool", () =>
    Effect.gen(function* () {
      const oauth = yield* OAuthTestServer;
      const server = yield* serveMcpServerWithOAuth(
        () =>
          makeEchoMcpServer({
            name: "linear-mcp",
            toolName: "hello",
            toolDescription: "Greets a person",
            inputName: "name",
            text: (name) => `Hello ${name}`,
          }),
        { path: "/mcp" },
      );

      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [memoryCredentialsPlugin(), mcpPlugin()] as const }),
      );

      // Register the MCP integration with an ENDPOINTFUL oauth2 method declaring
      // the token endpoint, scopes, and the service-account defaults. This is
      // what makes the connect flow offer client_credentials with Basic.
      yield* executor.mcp.addServer({
        name: "Linear MCP",
        endpoint: server.endpoint,
        slug: "linear_mcp",
        authenticationTemplate: [
          {
            kind: "oauth2",
            tokenUrl: oauth.tokenEndpoint,
            scopes: ["read"],
            defaultGrant: "client_credentials",
            defaultTokenEndpointAuthMethod: "basic",
          },
        ],
      });

      // The shared bot app: a confidential client_credentials client that
      // authenticates to the token endpoint via HTTP Basic.
      yield* executor.oauth.createClient({
        owner: "org",
        slug: OAuthClientSlug.make("linear-bot"),
        authorizationUrl: "",
        tokenUrl: oauth.tokenEndpoint,
        grant: "client_credentials",
        clientId: "test-client",
        clientSecret: "test-secret",
        tokenEndpointAuthMethod: "basic",
        resource: server.endpoint,
      });

      const started = yield* executor.oauth.start({
        owner: "org",
        client: OAuthClientSlug.make("linear-bot"),
        clientOwner: "org",
        name: ConnectionName.make("main"),
        integration: IntegrationSlug.make("linear_mcp"),
        template: AuthTemplateSlug.make("oauth2"),
      });
      // No browser redirect: the connection is minted inline.
      expect(started.status).toBe("connected");

      // The minted token authenticates a real MCP tool call through the SDK
      // transport (the server validates the Bearer against the OAuth server).
      const result = yield* executor.execute(ToolAddress.make("tools.linear_mcp.org.main.hello"), {
        name: "Ada",
      });
      expect(result).toMatchObject({
        ok: true,
        data: { content: [{ type: "text", text: "Hello Ada" }] },
      });

      // The token endpoint only ever saw HTTP Basic client auth.
      expect(yield* oauth.tokenRequestAuthMethods).toEqual(["basic"]);
    }),
  );
});
