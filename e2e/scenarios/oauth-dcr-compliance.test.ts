// Cross-target: DCR (RFC 7591) compliance against a real emulated MCP
// authorization server — the probe → registerDynamic → start → complete
// journey driven through the product's typed API, with the MCP emulator
// seeded into each misbehavior/variation an RFC-compliant client must handle.
//
// Each scenario is one gap from the 2026-07 DCR spec audit:
//   1. RFC 8414 §3.3 — a metadata document whose `issuer` does not match the
//      URL it was fetched from must be REJECTED at probe time.
//   2. RFC 9728 §3.3 — protected-resource metadata whose `resource` is not
//      the requested identifier must be rejected, never adopted as the
//      RFC 8707 token audience.
//   3. RFC 8414 §2 — omitted `token_endpoint_auth_methods_supported` means
//      client_secret_basic, NOT `none`; a registration + token exchange
//      against such a server must authenticate with HTTP Basic.
//   4. RFC 7591 §3.2.1 — the server may substitute registration metadata;
//      the client must honor the RETURNED token_endpoint_auth_method (a
//      server answering client_secret_basic gets Basic on /token, even when
//      the client asked for `none`).
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

import { expect } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { createEmulator, type Emulator } from "@executor-js/emulate";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import type { OAuthProbeError } from "@executor-js/sdk";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([mcpHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

/** The slug `normalizeMcpAuthMethods` assigns a slug-less oauth2 method. */
const OAUTH2_TEMPLATE = AuthTemplateSlug.make("oauth2");

const availablePort = Effect.callback<number>((resume) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close(() => {
      resume(Effect.succeed(port));
    });
  });
});

/** A private MCP emulator seeded with `oauth` misbehavior knobs plus one
 *  authorizable user. Local + in-process so each scenario owns its instance. */
const mcpEmulator = (oauth: Record<string, unknown>) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const port = yield* availablePort;
      const emulator = yield* Effect.promise(() => createEmulator({ service: "mcp", port }));
      yield* Effect.promise(() => emulator.seed({ users: [{ login: "octocat" }], oauth }));
      return emulator;
    }),
    (emulator: Emulator) => Effect.promise(() => emulator.close()).pipe(Effect.ignore),
  );

/** Follow the emulator's consent screen headlessly: GET /authorize renders a
 *  form per seeded user; POST the approval and capture the redirect back to
 *  the executor callback. Returns the `code` + `state` from that location. */
const approveConsent = (authorizationUrl: string) =>
  Effect.promise(async () => {
    const authorize = new URL(authorizationUrl);
    const page = await fetch(authorize, { redirect: "manual" });
    if (!page.ok) throw new Error(`authorize page failed: ${page.status}`);
    const approval = new URL("/authorize/approve", authorize.origin);
    const body = new URLSearchParams({
      client_id: authorize.searchParams.get("client_id") ?? "",
      redirect_uri: authorize.searchParams.get("redirect_uri") ?? "",
      state: authorize.searchParams.get("state") ?? "",
      scope: authorize.searchParams.get("scope") ?? "",
      code_challenge: authorize.searchParams.get("code_challenge") ?? "",
      code_challenge_method: authorize.searchParams.get("code_challenge_method") ?? "",
      resource: authorize.searchParams.get("resource") ?? "",
      login: "octocat",
    });
    const response = await fetch(approval, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      redirect: "manual",
    });
    const location = response.headers.get("location");
    if (response.status !== 302 || !location) {
      throw new Error(`consent approval did not redirect: ${response.status}`);
    }
    const redirected = new URL(location);
    const code = redirected.searchParams.get("code");
    const state = redirected.searchParams.get("state");
    if (!code || !state) throw new Error(`callback carried no code/state: ${location}`);
    return { code, state };
  });

// ---------------------------------------------------------------------------
// 1. RFC 8414 issuer validation: metadata lying about its issuer is rejected.
// ---------------------------------------------------------------------------

scenario(
  "OAuth DCR · probe rejects authorization-server metadata whose issuer mismatches",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const emulator = yield* mcpEmulator({ issuerOverride: "https://evil.example.com" });

      // The metadata document at <emulator>/.well-known/... claims an issuer
      // it does not live at. RFC 8414 §3.3: such metadata MUST NOT be used.
      const failure = yield* Effect.flip(
        client.oauth.probe({ payload: { url: `${emulator.url}/mcp` } }),
      );
      expect(Predicate.isTagged("OAuthProbeError")(failure)).toBe(true);
      const probeError = failure as OAuthProbeError;
      expect(probeError.message).toContain("issuer");
      expect(probeError.message).toContain("https://evil.example.com");
    }),
  ),
);

// ---------------------------------------------------------------------------
// 2. RFC 9728 resource validation: PRM naming a foreign resource is rejected.
// ---------------------------------------------------------------------------

scenario(
  "OAuth DCR · probe rejects protected-resource metadata naming a foreign resource",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const emulator = yield* mcpEmulator({
        resourceOverride: "https://other.example.com/mcp",
      });

      // The PRM's `resource` is not the identifier we asked about. Accepting
      // it would make the foreign URL the RFC 8707 token audience.
      const failure = yield* Effect.flip(
        client.oauth.probe({ payload: { url: `${emulator.url}/mcp` } }),
      );
      expect(Predicate.isTagged("OAuthProbeError")(failure)).toBe(true);
      const probeError = failure as OAuthProbeError;
      expect(probeError.message).toContain("resource");
      expect(probeError.message).toContain("https://other.example.com/mcp");
    }),
  ),
);

// ---------------------------------------------------------------------------
// 3. RFC 8414 default auth method: omitted advertisement = client_secret_basic.
//    The emulator omits token_endpoint_auth_methods_supported entirely and its
//    token endpoint REQUIRES HTTP Basic for basic clients — a client that
//    wrongly assumes `none` (or posts the secret in the form body) fails.
// ---------------------------------------------------------------------------

scenario(
  "OAuth DCR · omitted auth-methods metadata negotiates client_secret_basic end to end",
  {
    skip: "red until DCR auth-method negotiation honors the RFC 8414 client_secret_basic default (needs the oauth_client token_endpoint_auth_method column)",
  },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const emulator = yield* mcpEmulator({ tokenEndpointAuthMethods: "omit" });

      const integration = IntegrationSlug.make(unique("dcr-basic"));
      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: "DCR compliance MCP",
          endpoint: `${emulator.url}/mcp`,
          slug: String(integration),
          authenticationTemplate: [{ kind: "oauth2" }],
        },
      });
      const probe = yield* client.oauth.probe({ payload: { url: `${emulator.url}/mcp` } });
      expect(probe.registrationEndpoint, "the emulator advertises DCR").toBeTruthy();
      // RFC 8414 §2: omitted means client_secret_basic — the probe must not
      // fabricate a `none` capability the server never advertised.
      expect(probe.tokenEndpointAuthMethodsSupported ?? null).toBeNull();

      const registered = yield* client.oauth.registerDynamic({
        payload: {
          owner: "user",
          slug: OAuthClientSlug.make(unique("dcr-basic")),
          issuer: probe.issuer ?? null,
          registrationEndpoint: probe.registrationEndpoint!,
          authorizationUrl: probe.authorizationUrl,
          tokenUrl: probe.tokenUrl,
          resource: probe.resource ?? null,
          scopes: [...(probe.scopesSupported ?? [])],
          tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
          clientName: "Executor",
          originIntegration: integration,
        },
      });

      const started = yield* client.oauth.start({
        payload: {
          client: registered.client,
          clientOwner: "user",
          owner: "user",
          name: ConnectionName.make("main"),
          integration,
          template: OAUTH2_TEMPLATE,
        },
      });
      expect(started.status).toBe("redirect");
      if (started.status !== "redirect") return;

      // The token exchange must authenticate with HTTP Basic (the emulator
      // rejects form-body secrets for basic clients) — completing proves the
      // negotiated AND executed method is client_secret_basic.
      const { code } = yield* approveConsent(started.authorizationUrl);
      const connection = yield* client.oauth.complete({
        payload: { state: started.state, code },
      });
      expect(String(connection.name)).toBe("main");

      // Completion alone is not proof: the emulator honors whatever method the
      // client REQUESTED at registration, so a wrongly-negotiated `none` also
      // completes (public client + PKCE). The on-wire /token request is the
      // authoritative check: a Basic client sends an Authorization header
      // (redacted in the ledger, but its presence survives), a `none` client
      // sends none at all.
      const ledger = yield* Effect.promise(() => emulator.ledger.list());
      const tokenExchange = ledger.find(
        (entry) =>
          entry.method === "POST" &&
          entry.path.endsWith("/token") &&
          JSON.stringify(entry.request.body ?? "").includes("authorization_code"),
      );
      expect(tokenExchange, "the token exchange is in the ledger").toBeDefined();
      expect(
        Object.keys(tokenExchange!.request.headers).map((h) => h.toLowerCase()),
        "the token exchange authenticated with HTTP Basic",
      ).toContain("authorization");
    }),
  ),
);

// ---------------------------------------------------------------------------
// 4. RFC 7591 metadata substitution: the server upgrades the requested `none`
//    to client_secret_basic in the registration RESPONSE; the client must use
//    the returned method on /token, not the one it asked for.
// ---------------------------------------------------------------------------

scenario(
  "OAuth DCR · the server-substituted token auth method is honored on the token exchange",
  {
    skip: "red until the DCR response's token_endpoint_auth_method is persisted and used on /token (needs the oauth_client token_endpoint_auth_method column)",
  },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeClient } = yield* Api;
      const identity = yield* target.newIdentity();
      const client = yield* makeClient(api, identity);
      const emulator = yield* mcpEmulator({ dcrAuthMethodOverride: "client_secret_basic" });

      const integration = IntegrationSlug.make(unique("dcr-subst"));
      yield* client.mcp.addServer({
        payload: {
          transport: "remote",
          name: "DCR substitution MCP",
          endpoint: `${emulator.url}/mcp`,
          slug: String(integration),
          authenticationTemplate: [{ kind: "oauth2" }],
        },
      });
      const probe = yield* client.oauth.probe({ payload: { url: `${emulator.url}/mcp` } });

      // The server advertises `none` (so the client requests it) but the DCR
      // response substitutes client_secret_basic + mints a secret.
      const registered = yield* client.oauth.registerDynamic({
        payload: {
          owner: "user",
          slug: OAuthClientSlug.make(unique("dcr-subst")),
          issuer: probe.issuer ?? null,
          registrationEndpoint: probe.registrationEndpoint!,
          authorizationUrl: probe.authorizationUrl,
          tokenUrl: probe.tokenUrl,
          resource: probe.resource ?? null,
          scopes: [...(probe.scopesSupported ?? [])],
          tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
          clientName: "Executor",
          originIntegration: integration,
        },
      });

      const started = yield* client.oauth.start({
        payload: {
          client: registered.client,
          clientOwner: "user",
          owner: "user",
          name: ConnectionName.make("main"),
          integration,
          template: OAUTH2_TEMPLATE,
        },
      });
      expect(started.status).toBe("redirect");
      if (started.status !== "redirect") return;

      const { code } = yield* approveConsent(started.authorizationUrl);
      const connection = yield* client.oauth.complete({
        payload: { state: started.state, code },
      });
      expect(String(connection.name)).toBe("main");
    }),
  ),
);
