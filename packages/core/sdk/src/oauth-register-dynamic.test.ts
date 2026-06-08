import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ToolName,
} from "./ids";
import { definePlugin } from "./plugin";
import { makeTestWorkspaceHarness, memoryCredentialsPlugin } from "./test-config";
import { serveOAuthTestServer } from "./testing/oauth-test-server";

// RFC 7591 Dynamic Client Registration, end to end:
//   probe → registerDynamicClient (no pasted client id/secret) → listClients
//   → start → complete mints a connection via a PUBLIC client (PKCE, no secret).
// The test authorization server's /register endpoint mints a public client when
// `token_endpoint_auth_method: "none"` is requested, and its /token endpoint
// accepts that client WITHOUT a client_secret — proving the public-client path.

const INTEG = IntegrationSlug.make("acme");
const TEMPLATE = AuthTemplateSlug.make("oauth");
const CLIENT = OAuthClientSlug.make("acme-dcr");
const FLOW_REDIRECT_URI = "https://localhost:5394/api/oauth/callback";

const oauthPlugin = definePlugin(() => ({
  id: "acme" as const,
  storage: () => ({}),
  resolveTools: () =>
    Effect.succeed({
      tools: [{ name: ToolName.make("whoami"), description: "whoami" }],
    }),
  invokeTool: ({ credential }) => Effect.succeed({ token: credential.value }),
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({
        slug: INTEG,
        description: "Acme",
        config: {},
      }),
  }),
}))();

const plugins = [memoryCredentialsPlugin(), oauthPlugin] as const;

describe("oauth.registerDynamicClient", () => {
  it.effect("DCR mints + persists a public (no-secret) client that lists + connects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();

        // Probe surfaces the registration endpoint + advertised auth methods so
        // the caller knows a public client is allowed.
        const probe = yield* executor.oauth.probe({ url: server.mcpResourceUrl });
        expect(probe.registrationEndpoint).toBe(server.registrationEndpoint);
        expect(probe.tokenEndpointAuthMethodsSupported).toContain("none");
        expect(probe.resource).toBe(server.mcpResourceUrl);

        // Register dynamically — NO client id/secret pasted by the user.
        const slug = yield* executor.oauth.registerDynamicClient({
          owner: "org",
          slug: CLIENT,
          registrationEndpoint: probe.registrationEndpoint!,
          authorizationUrl: probe.authorizationUrl,
          tokenUrl: probe.tokenUrl,
          resource: probe.resource,
          scopes: ["read"],
          tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
          clientName: "Acme DCR",
          redirectUri: FLOW_REDIRECT_URI,
        });
        expect(String(slug)).toBe(String(CLIENT));

        // The minted client appears in listClients with a server-issued
        // client_id and NO secret ever projected.
        const clients = yield* executor.oauth.listClients();
        const minted = clients.find((c) => String(c.slug) === String(CLIENT));
        expect(minted).toBeDefined();
        expect(minted!.owner).toBe("org");
        expect(minted!.grant).toBe("authorization_code");
        expect(minted!.clientId.length).toBeGreaterThan(0);
        expect(minted!.clientId.startsWith("client_")).toBe(true);
        for (const client of clients) {
          expect(Object.keys(client)).not.toContain("clientSecret");
          expect(JSON.stringify(client)).not.toContain("secret");
        }

        // The DCR-minted public client drives the full authorization_code +
        // PKCE flow with NO client_secret on the token exchange.
        const started = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
          redirectUri: FLOW_REDIRECT_URI,
        });
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;
        expect(new URL(started.authorizationUrl).searchParams.get("resource")).toBe(
          server.mcpResourceUrl,
        );

        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });
        expect(callback.state).toBe(String(started.state));

        const connection = yield* executor.oauth.complete({
          state: started.state,
          code: callback.code,
        });
        expect(String(connection.name)).toBe("main");
        expect(String(connection.address)).toBe("tools.acme.org.main");

        // The /token request was made WITHOUT a client_secret (public client).
        const requests = yield* server.requests;
        const registerRequest = requests.find((r) => r.path === "/register" && r.method === "POST");
        expect(registerRequest).toBeDefined();
        expect(registerRequest!.body).toContain(FLOW_REDIRECT_URI);
        const tokenRequest = requests.find(
          (r) => r.path === "/token" && r.method === "POST" && r.body.includes("grant_type"),
        );
        expect(tokenRequest).toBeDefined();
        expect(tokenRequest!.body).not.toContain("client_secret");
        expect(new URLSearchParams(tokenRequest!.body).get("resource")).toBe(server.mcpResourceUrl);
      }),
    ),
  );
});
