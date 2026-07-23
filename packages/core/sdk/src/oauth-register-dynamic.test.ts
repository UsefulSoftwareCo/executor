import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ToolName,
} from "./ids";
import { OAuthRegisterDynamicError } from "./oauth-client";
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

const dcrSlugFor = (issuerUrl: string): OAuthClientSlug =>
  OAuthClientSlug.make(
    `dcr-${new URL(issuerUrl).host
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")}`,
  );

const registerRequestCount = (
  requests: readonly { readonly path: string; readonly method: string }[],
): number => requests.filter((r) => r.path === "/register" && r.method === "POST").length;

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
        expect(probe.issuer).toBe(server.issuerUrl);
        expect(probe.registrationEndpoint).toBe(server.registrationEndpoint);
        expect(probe.tokenEndpointAuthMethodsSupported).toContain("none");
        expect(probe.resource).toBe(server.mcpResourceUrl);

        // Register dynamically — NO client id/secret pasted by the user.
        const slug = yield* executor.oauth.registerDynamicClient({
          owner: "org",
          slug: CLIENT,
          issuer: probe.issuer,
          registrationEndpoint: probe.registrationEndpoint!,
          authorizationUrl: probe.authorizationUrl,
          tokenUrl: probe.tokenUrl,
          resource: probe.resource,
          scopes: ["read"],
          tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
          clientName: "Acme DCR",
          redirectUri: FLOW_REDIRECT_URI,
          originIntegration: INTEG,
        });
        const expectedSlug = dcrSlugFor(server.issuerUrl);
        expect(String(slug)).toBe(String(expectedSlug));

        // The minted client appears in listClients with a server-issued
        // client_id and NO secret ever projected.
        const clients = yield* executor.oauth.listClients();
        const minted = clients.find((c) => String(c.slug) === String(expectedSlug));
        expect(minted).toBeDefined();
        expect(minted!.owner).toBe("org");
        expect(minted!.grant).toBe("authorization_code");
        expect(minted!.clientId.length).toBeGreaterThan(0);
        expect(minted!.clientId.startsWith("client_")).toBe(true);
        expect(minted!.origin).toEqual({
          kind: "dynamic_client_registration",
          integration: INTEG,
        });
        for (const client of clients) {
          expect(Object.keys(client)).not.toContain("clientSecret");
          expect(JSON.stringify(client)).not.toContain("secret");
        }

        // The DCR-minted public client drives the full authorization_code +
        // PKCE flow with NO client_secret on the token exchange.
        const started = yield* executor.oauth.start({
          owner: "org",
          client: expectedSlug,
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
        expect(registerRequest!.body).toContain("authorization_code");
        expect(registerRequest!.body).toContain("refresh_token");
        const authorizationRequest = requests.find(
          (r) => r.path === "/authorize" && r.method === "GET",
        );
        expect(authorizationRequest).toBeDefined();
        expect(authorizationRequest!.query.resource).toBe(server.mcpResourceUrl);
        const tokenRequest = requests.find(
          (r) => r.path === "/token" && r.method === "POST" && r.body.includes("grant_type"),
        );
        expect(tokenRequest).toBeDefined();
        expect(tokenRequest!.body).not.toContain("client_secret");
        expect(new URLSearchParams(tokenRequest!.body).get("resource")).toBe(server.mcpResourceUrl);
      }),
    ),
  );

  it.effect("reuses an existing DCR client for the same owner and authorization server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();
        const probe = yield* executor.oauth.probe({ url: server.mcpResourceUrl });

        const first = yield* executor.oauth.registerDynamicClient({
          owner: "org",
          slug: OAuthClientSlug.make("first-attempt"),
          issuer: probe.issuer,
          registrationEndpoint: probe.registrationEndpoint!,
          authorizationUrl: probe.authorizationUrl,
          tokenUrl: probe.tokenUrl,
          resource: probe.resource,
          scopes: ["read"],
          tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
          clientName: "Acme DCR",
          redirectUri: FLOW_REDIRECT_URI,
          originIntegration: INTEG,
        });
        yield* server.clearRequests;

        const second = yield* executor.oauth.registerDynamicClient({
          owner: "org",
          slug: OAuthClientSlug.make("second-attempt"),
          issuer: probe.issuer,
          registrationEndpoint: probe.registrationEndpoint!,
          authorizationUrl: probe.authorizationUrl,
          tokenUrl: probe.tokenUrl,
          resource: probe.resource,
          scopes: ["read"],
          tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
          clientName: "Other integration DCR",
          redirectUri: FLOW_REDIRECT_URI,
          originIntegration: IntegrationSlug.make("other"),
        });

        expect(second).toBe(first);
        const requests = yield* server.requests;
        expect(registerRequestCount(requests)).toBe(0);
      }),
    ),
  );

  it.effect("does not reuse a DCR client across owners", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();
        const probe = yield* executor.oauth.probe({ url: server.mcpResourceUrl });

        const orgSlug = yield* executor.oauth.registerDynamicClient({
          owner: "org",
          slug: OAuthClientSlug.make("org-attempt"),
          issuer: probe.issuer,
          registrationEndpoint: probe.registrationEndpoint!,
          authorizationUrl: probe.authorizationUrl,
          tokenUrl: probe.tokenUrl,
          resource: probe.resource,
          scopes: ["read"],
          tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
          clientName: "Org DCR",
          redirectUri: FLOW_REDIRECT_URI,
          originIntegration: INTEG,
        });
        yield* server.clearRequests;

        const userSlug = yield* executor.oauth.registerDynamicClient({
          owner: "user",
          slug: OAuthClientSlug.make("user-attempt"),
          issuer: probe.issuer,
          registrationEndpoint: probe.registrationEndpoint!,
          authorizationUrl: probe.authorizationUrl,
          tokenUrl: probe.tokenUrl,
          resource: probe.resource,
          scopes: ["read"],
          tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
          clientName: "User DCR",
          redirectUri: FLOW_REDIRECT_URI,
          originIntegration: INTEG,
        });

        expect(String(userSlug)).toBe(String(orgSlug));
        const requests = yield* server.requests;
        expect(registerRequestCount(requests)).toBe(1);
      }),
    ),
  );

  it.effect("does NOT reuse a legacy DCR row with no stored issuer (mints fresh)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Post-migration, the reuse lookup keys strictly on a non-null
        // origin_issuer: the fuzzy token-host fallback is gone. A legacy row that
        // has not yet been backfilled (null origin_issuer) is therefore NOT
        // reused, so a fresh DCR registration happens. The GC migration then
        // backfills/GCs any duplicate this transient window mints.
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const { config, executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();
        const probe = yield* executor.oauth.probe({ url: server.mcpResourceUrl });
        const legacySlug = OAuthClientSlug.make("cloudflare-mcp");

        yield* executor.oauth.createClient({
          owner: "org",
          slug: legacySlug,
          authorizationUrl: probe.authorizationUrl,
          tokenUrl: probe.tokenUrl,
          resource: server.mcpResourceUrl,
          grant: "authorization_code",
          clientId: "legacy-dcr-client",
          clientSecret: "",
        });
        yield* Effect.promise(() =>
          config.db.updateMany("oauth_client", {
            where: (b) => b("slug", "=", String(legacySlug)),
            set: { origin_kind: null, origin_integration: null, origin_issuer: null },
          }),
        );
        yield* server.clearRequests;

        const registered = yield* executor.oauth.registerDynamicClient({
          owner: "org",
          slug: OAuthClientSlug.make("new-attempt"),
          issuer: probe.issuer,
          registrationEndpoint: probe.registrationEndpoint!,
          authorizationUrl: probe.authorizationUrl,
          tokenUrl: probe.tokenUrl,
          resource: server.mcpResourceUrl,
          scopes: ["read"],
          tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
          clientName: "Acme DCR",
          redirectUri: FLOW_REDIRECT_URI,
          originIntegration: INTEG,
        });

        // A fresh client is registered, not the null-issuer legacy row.
        expect(registered).not.toBe(legacySlug);
        const requests = yield* server.requests;
        expect(registerRequestCount(requests)).toBe(1);
      }),
    ),
  );

  it.effect("reuses a legacy DCR row once its origin_issuer is backfilled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The post-backfill counterpart: after the GC migration stamps a legacy
        // row's origin_issuer, the reuse lookup keys on it and mints no
        // duplicate. This is the steady state the migration establishes.
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const { config, executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();
        const probe = yield* executor.oauth.probe({ url: server.mcpResourceUrl });
        const legacySlug = OAuthClientSlug.make("cloudflare-mcp");

        yield* executor.oauth.createClient({
          owner: "org",
          slug: legacySlug,
          authorizationUrl: probe.authorizationUrl,
          tokenUrl: probe.tokenUrl,
          resource: server.mcpResourceUrl,
          grant: "authorization_code",
          clientId: "legacy-dcr-client",
          clientSecret: "",
        });
        // Simulate the migration's backfill: legacy DCR stamp + issuer set.
        yield* Effect.promise(() =>
          config.db.updateMany("oauth_client", {
            where: (b) => b("slug", "=", String(legacySlug)),
            set: {
              origin_kind: "dynamic_client_registration",
              origin_integration: null,
              origin_issuer: probe.issuer,
            },
          }),
        );
        yield* server.clearRequests;

        const reused = yield* executor.oauth.registerDynamicClient({
          owner: "org",
          slug: OAuthClientSlug.make("new-attempt"),
          issuer: probe.issuer,
          registrationEndpoint: probe.registrationEndpoint!,
          authorizationUrl: probe.authorizationUrl,
          tokenUrl: probe.tokenUrl,
          resource: server.mcpResourceUrl,
          scopes: ["read"],
          tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
          clientName: "Acme DCR",
          redirectUri: FLOW_REDIRECT_URI,
          originIntegration: INTEG,
        });

        expect(reused).toBe(legacySlug);
        const requests = yield* server.requests;
        expect(registerRequestCount(requests)).toBe(0);
      }),
    ),
  );

  it.effect("uses resource to distinguish DCR clients only after an issuer already differs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();
        const probe = yield* executor.oauth.probe({ url: server.mcpResourceUrl });
        const resourceA = `${server.issuerUrl}/mcp/a`;
        const resourceB = `${server.issuerUrl}/mcp/b`;

        const first = yield* executor.oauth.registerDynamicClient({
          owner: "org",
          slug: OAuthClientSlug.make("first-resource"),
          issuer: probe.issuer,
          registrationEndpoint: probe.registrationEndpoint!,
          authorizationUrl: probe.authorizationUrl,
          tokenUrl: probe.tokenUrl,
          resource: resourceA,
          scopes: ["read"],
          tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
          clientName: "Resource A",
          redirectUri: FLOW_REDIRECT_URI,
          originIntegration: INTEG,
        });
        expect(String(first)).toBe(String(dcrSlugFor(server.issuerUrl)));

        const second = yield* executor.oauth.registerDynamicClient({
          owner: "org",
          slug: OAuthClientSlug.make("second-resource"),
          issuer: probe.issuer,
          registrationEndpoint: probe.registrationEndpoint!,
          authorizationUrl: probe.authorizationUrl,
          tokenUrl: probe.tokenUrl,
          resource: resourceB,
          scopes: ["read"],
          tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
          clientName: "Resource B",
          redirectUri: FLOW_REDIRECT_URI,
          originIntegration: INTEG,
        });
        expect(String(second)).not.toBe(String(first));
        expect(String(second)).toContain(String(first));
        yield* server.clearRequests;

        const third = yield* executor.oauth.registerDynamicClient({
          owner: "org",
          slug: OAuthClientSlug.make("third-resource"),
          issuer: probe.issuer,
          registrationEndpoint: probe.registrationEndpoint!,
          authorizationUrl: probe.authorizationUrl,
          tokenUrl: probe.tokenUrl,
          resource: resourceB,
          scopes: ["read"],
          tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
          clientName: "Resource B again",
          redirectUri: FLOW_REDIRECT_URI,
          originIntegration: IntegrationSlug.make("other"),
        });

        expect(third).toBe(second);
        const requests = yield* server.requests;
        expect(registerRequestCount(requests)).toBe(0);
      }),
    ),
  );

  it.effect("does not reuse a resource-scoped DCR client for a resource-less request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();
        const probe = yield* executor.oauth.probe({ url: server.mcpResourceUrl });
        const resourceA = `${server.issuerUrl}/mcp/a`;
        const resourceB = `${server.issuerUrl}/mcp/b`;

        // Two resource-scoped clients for the same authorization server. The first
        // takes the base `dcr-<host>` slug; the second gets a resource-suffixed one.
        const scopedA = yield* executor.oauth.registerDynamicClient({
          owner: "org",
          slug: OAuthClientSlug.make("scoped-a"),
          issuer: probe.issuer,
          registrationEndpoint: probe.registrationEndpoint!,
          authorizationUrl: probe.authorizationUrl,
          tokenUrl: probe.tokenUrl,
          resource: resourceA,
          scopes: ["read"],
          tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
          clientName: "Resource A",
          redirectUri: FLOW_REDIRECT_URI,
          originIntegration: INTEG,
        });
        const scopedB = yield* executor.oauth.registerDynamicClient({
          owner: "org",
          slug: OAuthClientSlug.make("scoped-b"),
          issuer: probe.issuer,
          registrationEndpoint: probe.registrationEndpoint!,
          authorizationUrl: probe.authorizationUrl,
          tokenUrl: probe.tokenUrl,
          resource: resourceB,
          scopes: ["read"],
          tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
          clientName: "Resource B",
          redirectUri: FLOW_REDIRECT_URI,
          originIntegration: INTEG,
        });
        expect(String(scopedB)).not.toBe(String(scopedA));
        yield* server.clearRequests;

        // A resource-LESS request for the same owner + issuer must NOT borrow
        // either resource-scoped client (their tokens are bound to a resource):
        // it registers a fresh resource-less client.
        const resourceLess = yield* executor.oauth.registerDynamicClient({
          owner: "org",
          slug: OAuthClientSlug.make("resource-less"),
          issuer: probe.issuer,
          registrationEndpoint: probe.registrationEndpoint!,
          authorizationUrl: probe.authorizationUrl,
          tokenUrl: probe.tokenUrl,
          resource: null,
          scopes: ["read"],
          tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
          clientName: "Resource-less",
          redirectUri: FLOW_REDIRECT_URI,
          originIntegration: INTEG,
        });
        expect(String(resourceLess)).not.toBe(String(scopedA));
        expect(String(resourceLess)).not.toBe(String(scopedB));
        const requests = yield* server.requests;
        expect(registerRequestCount(requests)).toBe(1);

        // The minted resource-less client is stored with a null resource, and the
        // two resource-scoped clients still exist (nothing was clobbered).
        const clients = yield* executor.oauth.listClients();
        const minted = clients.find((c) => String(c.slug) === String(resourceLess));
        expect(minted).toBeDefined();
        expect(minted!.resource ?? null).toBeNull();
        const slugs = clients.map((c) => String(c.slug));
        expect(slugs).toContain(String(scopedA));
        expect(slugs).toContain(String(scopedB));

        // A SECOND resource-less request now reuses the resource-less client.
        yield* server.clearRequests;
        const reused = yield* executor.oauth.registerDynamicClient({
          owner: "org",
          slug: OAuthClientSlug.make("resource-less-again"),
          issuer: probe.issuer,
          registrationEndpoint: probe.registrationEndpoint!,
          authorizationUrl: probe.authorizationUrl,
          tokenUrl: probe.tokenUrl,
          resource: null,
          scopes: ["read"],
          tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
          clientName: "Resource-less again",
          redirectUri: FLOW_REDIRECT_URI,
          originIntegration: IntegrationSlug.make("other"),
        });
        expect(String(reused)).toBe(String(resourceLess));
        expect(registerRequestCount(yield* server.requests)).toBe(0);
      }),
    ),
  );

  // Repro: a recreated sandbox changes the executor's callback origin while
  // the DCR client minted for the OLD callback survives in storage. Reuse is
  // keyed on (owner, issuer, resource) and never compares the redirect URI the
  // client was registered with, so `oauth.start` pairs the stale registration
  // with the NEW callback — and a strict authorization server (the test AS
  // included) rejects the authorize request with 400 `redirect_uri is not
  // registered`. Contract: a changed flow redirect URI must trigger a fresh
  // registration instead of reusing the stale client.
  it.effect("re-registers instead of reusing the DCR client when the redirect URI changed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();
        const probe = yield* executor.oauth.probe({ url: server.mcpResourceUrl });

        // Original sandbox: DCR registration carries the ORIGINAL callback.
        yield* executor.oauth.registerDynamicClient({
          owner: "org",
          slug: OAuthClientSlug.make("original-sandbox"),
          issuer: probe.issuer,
          registrationEndpoint: probe.registrationEndpoint!,
          authorizationUrl: probe.authorizationUrl,
          tokenUrl: probe.tokenUrl,
          resource: probe.resource,
          scopes: ["read"],
          tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
          clientName: "Acme DCR",
          redirectUri: FLOW_REDIRECT_URI,
          originIntegration: INTEG,
        });
        yield* server.clearRequests;

        const originalSlug = yield* Effect.map(executor.oauth.listClients(), (clients) =>
          String(clients[0]!.slug),
        );

        // Recreated sandbox: same persisted oauth_client rows, NEW callback
        // origin. The register call runs again the way the connect flow does.
        const recreatedRedirectUri = "https://localhost:6410/api/oauth/callback";
        const slug = yield* executor.oauth.registerDynamicClient({
          owner: "org",
          slug: OAuthClientSlug.make("recreated-sandbox"),
          issuer: probe.issuer,
          registrationEndpoint: probe.registrationEndpoint!,
          authorizationUrl: probe.authorizationUrl,
          tokenUrl: probe.tokenUrl,
          resource: probe.resource,
          scopes: ["read"],
          tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
          clientName: "Acme DCR",
          redirectUri: recreatedRedirectUri,
          originIntegration: INTEG,
        });

        // The changed redirect URI must have minted a FRESH registration whose
        // redirect_uris carry the recreated callback — reusing the stale
        // client would make the authorize hop below the reported 400. The new
        // client takes a DIFFERENT slug so it does not clobber the stale row
        // (existing connections still refresh through the old client_id).
        expect(registerRequestCount(yield* server.requests)).toBe(1);
        expect(String(slug)).not.toBe(originalSlug);
        const slugsAfter = yield* Effect.map(executor.oauth.listClients(), (clients) =>
          clients.map((client) => String(client.slug)),
        );
        expect(slugsAfter).toContain(originalSlug);
        expect(slugsAfter).toContain(String(slug));

        const started = yield* executor.oauth.start({
          owner: "org",
          client: slug,
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
          redirectUri: recreatedRedirectUri,
        });
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;

        // The strict AS accepts the authorize request only when the flow's
        // redirect_uri matches the client's registration — with the stale
        // reused client this hop is the reported 400.
        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });
        const connection = yield* executor.oauth.complete({
          state: started.state,
          code: callback.code,
        });
        expect(String(connection.address)).toBe("tools.acme.org.main");
      }),
    ),
  );

  // Regression: Mercury's authorization server vets `client_name` and rejects
  // any value containing its own brand with `invalid_client_metadata`, which
  // the old auto-generated "Executor for Mercury MCP" always tripped. The UI
  // flow now always registers under the bare product name, which brand-vetting
  // servers accept.
  it.effect("registers under the bare product name against a brand-vetting server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({
          scopes: ["read"],
          // Mirror Mercury: reject any client_name containing the brand.
          approveClientName: (name) => !name.includes("Acme"),
        });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();
        const probe = yield* executor.oauth.probe({ url: server.mcpResourceUrl });

        const slug = yield* executor.oauth.registerDynamicClient({
          owner: "org",
          slug: CLIENT,
          issuer: probe.issuer,
          registrationEndpoint: probe.registrationEndpoint!,
          authorizationUrl: probe.authorizationUrl,
          tokenUrl: probe.tokenUrl,
          resource: probe.resource,
          scopes: ["read"],
          tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
          clientName: "Executor",
          redirectUri: FLOW_REDIRECT_URI,
          originIntegration: INTEG,
        });
        expect(String(slug).length).toBeGreaterThan(0);

        const requests = yield* server.requests;
        const registers = requests.filter((r) => r.path === "/register" && r.method === "POST");
        expect(registers).toHaveLength(1);
        expect(registers[0]!.body).toContain('"client_name":"Executor"');
      }),
    ),
  );

  // A server that rejects even the bare product name surfaces the RFC error
  // untouched: no retry loop, no masking of the server-authored description.
  it.effect("surfaces invalid_client_metadata when the server rejects the client_name", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({
          scopes: ["read"],
          approveClientName: () => false,
        });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();
        const probe = yield* executor.oauth.probe({ url: server.mcpResourceUrl });

        const error = yield* Effect.flip(
          executor.oauth.registerDynamicClient({
            owner: "org",
            slug: CLIENT,
            registrationEndpoint: probe.registrationEndpoint!,
            authorizationUrl: probe.authorizationUrl,
            tokenUrl: probe.tokenUrl,
            resource: probe.resource,
            scopes: ["read"],
            tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
            clientName: "Executor",
            redirectUri: FLOW_REDIRECT_URI,
            originIntegration: INTEG,
          }),
        );
        expect(Predicate.isTagged("OAuthRegisterDynamicError")(error)).toBe(true);
        const registerError = error as OAuthRegisterDynamicError;
        expect(registerError.message).toContain(
          "Dynamic Client Registration failed: invalid_client_metadata",
        );

        const requests = yield* server.requests;
        const registers = requests.filter((r) => r.path === "/register" && r.method === "POST");
        expect(registers).toHaveLength(1);
      }),
    ),
  );

  // Regression: issue #770. Vercel (and other RFC 8252-strict servers) only
  // approve loopback redirect URIs for anonymous DCR, so a hosted/tailnet/LAN
  // origin trips `invalid_redirect_uri`. The failure must explain the loopback
  // requirement and name the offending URI, not dump the raw RFC code.
  it.effect("DCR rejection of a non-loopback redirect URI yields an actionable loopback hint", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({
          scopes: ["read"],
          // Mirror Vercel: approve only loopback redirect URIs for anonymous DCR.
          approveRedirectUri: (uri) =>
            uri.startsWith("http://localhost") || uri.startsWith("http://127."),
        });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();
        const probe = yield* executor.oauth.probe({ url: server.mcpResourceUrl });

        const nonLoopback = "https://app.example.com/api/oauth/callback";
        const error = yield* Effect.flip(
          executor.oauth.registerDynamicClient({
            owner: "org",
            slug: CLIENT,
            registrationEndpoint: probe.registrationEndpoint!,
            authorizationUrl: probe.authorizationUrl,
            tokenUrl: probe.tokenUrl,
            resource: probe.resource,
            scopes: ["read"],
            tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
            clientName: "Acme DCR",
            redirectUri: nonLoopback,
            originIntegration: INTEG,
          }),
        );
        // Predicate guard narrows the union so `.message` reads off a typed failure.
        expect(Predicate.isTagged("OAuthRegisterDynamicError")(error)).toBe(true);
        const registerError = error as OAuthRegisterDynamicError;
        const message = registerError.message;
        // Names the loopback-only requirement, the localhost fix, and the URI.
        expect(message).toContain("loopback");
        expect(message).toContain("http://localhost");
        expect(message).toContain(nonLoopback);
      }),
    ),
  );

  // The loopback hint is gated on the redirect URI actually being non-loopback.
  // A server that rejects even a loopback URI keeps the generic message so we
  // never tell the user "use localhost" when they already are.
  it.effect(
    "DCR rejection of a loopback redirect URI keeps the generic message (no false hint)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* serveOAuthTestServer({
            scopes: ["read"],
            approveRedirectUri: () => false, // reject every redirect URI, even loopback
          });
          const { executor } = yield* makeTestWorkspaceHarness({ plugins });
          yield* executor.acme.seed();
          const probe = yield* executor.oauth.probe({ url: server.mcpResourceUrl });

          const error = yield* Effect.flip(
            executor.oauth.registerDynamicClient({
              owner: "org",
              slug: CLIENT,
              registrationEndpoint: probe.registrationEndpoint!,
              authorizationUrl: probe.authorizationUrl,
              tokenUrl: probe.tokenUrl,
              resource: probe.resource,
              scopes: ["read"],
              tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
              clientName: "Acme DCR",
              redirectUri: "http://127.0.0.1:5394/api/oauth/callback",
              originIntegration: INTEG,
            }),
          );
          expect(Predicate.isTagged("OAuthRegisterDynamicError")(error)).toBe(true);
          const registerError = error as OAuthRegisterDynamicError;
          const message = registerError.message;
          expect(message).toContain("Dynamic Client Registration failed: invalid_redirect_uri");
          expect(message).not.toContain("Automatic OAuth setup failed");
        }),
      ),
  );
});
