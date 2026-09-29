import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ToolName,
} from "./ids";
import {
  DEFAULT_OAUTH_LOOPBACK_CALLBACK_PATH,
  OAUTH_LOOPBACK_CALLBACK_HOST,
  isOAuthLoopbackCallbackPort,
  normalizeOAuthLoopbackCallbackPath,
  oauthClientLoopbackCallback,
  oauthLoopbackCallbackUrl,
} from "./oauth-client";
import { definePlugin } from "./plugin";
import { makeTestWorkspaceHarness, memoryCredentialsPlugin } from "./test-config";
import { serveOAuthTestServer } from "./testing/oauth-test-server";

// ---------------------------------------------------------------------------
// A loopback callback a registered OAuth app declares (RFC 8252 §7.3).
//
// Providers without dynamic client registration only accept a redirect URI that
// is already on THEIR app — usually a loopback URI on a port the user cannot
// change. These tests cover the three things that must hold for that to work:
// the declared URI is what the authorize request AND the token exchange send
// (the AS compares them), the app stores and reports the declaration, and a
// declaration the provider could never have registered is refused up front
// rather than sent and rejected mid-flow.
// ---------------------------------------------------------------------------

const INTEG = IntegrationSlug.make("acme");
const TEMPLATE = AuthTemplateSlug.make("oauth");
const CLIENT = OAuthClientSlug.make("acme-byo");

const oauthPlugin = definePlugin(() => ({
  id: "acme" as const,
  storage: () => ({}),
  resolveTools: () =>
    Effect.succeed({
      tools: [{ name: ToolName.make("whoami"), description: "whoami" }],
    }),
  describeAuthMethods: () => [
    {
      id: "oauth",
      label: "OAuth2",
      kind: "oauth" as const,
      template: String(TEMPLATE),
      oauth: { scopes: ["read"] },
    },
  ],
  invokeTool: () => Effect.succeed({ ok: true }),
  checkHealth: () => Effect.succeed({ status: "healthy" as const, checkedAt: Date.now() }),
  extension: (ctx) => ({
    seed: () =>
      ctx.core.integrations.register({
        slug: INTEG,
        description: "Acme",
        config: { scopes: ["read"] },
      }),
  }),
}))();

const plugins = [memoryCredentialsPlugin(), oauthPlugin] as const;

describe("loopback callback declaration", () => {
  it("spells the host 127.0.0.1 and defaults the path", () => {
    // `localhost` and `127.0.0.1` are different URIs to an authorization server,
    // and the provider app is registered with one of them exactly.
    expect(OAUTH_LOOPBACK_CALLBACK_HOST).toBe("127.0.0.1");
    expect(
      oauthLoopbackCallbackUrl({ port: 3118, path: DEFAULT_OAUTH_LOOPBACK_CALLBACK_PATH }),
    ).toBe("http://127.0.0.1:3118/callback");
  });

  it("normalizes a path, defaulting an absent one and refusing anything else", () => {
    expect(normalizeOAuthLoopbackCallbackPath(undefined)).toBe("/callback");
    expect(normalizeOAuthLoopbackCallbackPath(null)).toBe("/callback");
    expect(normalizeOAuthLoopbackCallbackPath("")).toBe("/callback");
    expect(normalizeOAuthLoopbackCallbackPath("/oauth/cb")).toBe("/oauth/cb");
    // Round-trip failures: the URI we send must be the one the user registered.
    expect(normalizeOAuthLoopbackCallbackPath("callback")).toBeNull();
    expect(normalizeOAuthLoopbackCallbackPath("/callback?x=1")).toBeNull();
    expect(normalizeOAuthLoopbackCallbackPath("/callback#fragment")).toBeNull();
    expect(normalizeOAuthLoopbackCallbackPath("/call back")).toBeNull();
  });

  it("accepts only unprivileged ports", () => {
    expect(isOAuthLoopbackCallbackPort(1024)).toBe(true);
    expect(isOAuthLoopbackCallbackPort(65535)).toBe(true);
    expect(isOAuthLoopbackCallbackPort(80)).toBe(false);
    expect(isOAuthLoopbackCallbackPort(65536)).toBe(false);
    expect(isOAuthLoopbackCallbackPort(3118.5)).toBe(false);
    expect(isOAuthLoopbackCallbackPort(Number.NaN)).toBe(false);
  });

  it("derives a callback only from a port, and degrades a corrupt pair to none", () => {
    expect(oauthClientLoopbackCallback({})).toBeNull();
    // A path without the port the provider pinned declares nothing.
    expect(oauthClientLoopbackCallback({ callbackPath: "/callback" })).toBeNull();
    expect(oauthClientLoopbackCallback({ callbackPort: 3118 })).toEqual({
      port: 3118,
      path: "/callback",
    });
    expect(oauthClientLoopbackCallback({ callbackPort: 3118, callbackPath: "/oauth/cb" })).toEqual({
      port: 3118,
      path: "/oauth/cb",
    });
    // A corrupt row must not make the app unusable: no callback is the
    // pre-existing behaviour for every app.
    expect(oauthClientLoopbackCallback({ callbackPort: 80 })).toBeNull();
    expect(oauthClientLoopbackCallback({ callbackPort: 3118, callbackPath: "nope" })).toBeNull();
  });
});

describe("oauth loopback callback", () => {
  it.effect("stores the declaration, reports it, and sends it on both legs of the flow", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();

        const created = yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
          // The URI the user registered on the provider's own app.
          callbackPort: 3118,
        });
        expect(String(created)).toBe("acme-byo");

        // The host reads the declaration BEFORE starting, to bind the URI.
        expect(
          yield* executor.oauth.loopbackCallback({ client: CLIENT, clientOwner: "org" }),
        ).toEqual({ port: 3118, path: "/callback" });

        // Listings carry it, so the connect UI can show the same URI.
        const listed = yield* executor.oauth.listClients();
        const summary = listed.find((client) => client.slug === CLIENT);
        expect(summary?.callbackPort).toBe(3118);
        expect(summary?.callbackPath).toBe("/callback");

        const started = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("slack"),
          integration: INTEG,
          template: TEMPLATE,
          redirectUri: "http://127.0.0.1:3118/callback",
        });
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;

        const authorize = new URL(started.authorizationUrl);
        expect(authorize.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:3118/callback");

        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });
        // The test server hands the code back to the URI the authorize request
        // named, so the provider's redirect lands on the listener.
        expect(callback.callbackUrl.startsWith("http://127.0.0.1:3118/callback?")).toBe(true);

        yield* server.clearRequests;
        const connection = yield* executor.oauth.complete({
          state: started.state,
          code: callback.code,
        });
        expect(String(connection.address)).toBe("tools.acme.org.slack");

        // The exchange must send the SAME redirect_uri as the authorize request:
        // the test server rejects the code when they differ, and the token
        // request is checked here so the guarantee is asserted rather than
        // inferred from the exchange succeeding.
        const requests = yield* server.requests;
        const tokenRequest = requests.find((request) => request.path === "/token");
        expect(tokenRequest).toBeDefined();
        expect(new URLSearchParams(tokenRequest?.body ?? "").get("redirect_uri")).toBe(
          "http://127.0.0.1:3118/callback",
        );
      }),
    ),
  );

  it.effect("sends the declared callback verbatim when the caller passes it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();

        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
          callbackPort: 3118,
          callbackPath: "/oauth/cb",
        });

        // What a host does: read the URI it must serve, bind it, then start the
        // flow with exactly that value.
        const declared = yield* executor.oauth.loopbackCallback({
          client: CLIENT,
          clientOwner: "org",
        });
        if (declared === null) throw new Error("expected a declared loopback callback");

        const started = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("slack"),
          integration: INTEG,
          template: TEMPLATE,
          redirectUri: oauthLoopbackCallbackUrl(declared),
        });
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;

        expect(new URL(started.authorizationUrl).searchParams.get("redirect_uri")).toBe(
          "http://127.0.0.1:3118/oauth/cb",
        );
      }),
    ),
  );

  it.effect("refuses a declared-callback flow the caller has not bound", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();

        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
          callbackPort: 3118,
        });

        const startInput = {
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("slack"),
          integration: INTEG,
          template: TEMPLATE,
        } as const;

        // The connect UI always sends its own origin's callback; a caller that
        // never asked for the declared one (an agent tool, a host that skips
        // `loopbackCallback`) sends nothing. Both would send a redirect URI
        // nothing is listening on — the provider would take the user all the way
        // through consent and then refuse, so the flow is refused here instead.
        for (const redirectUri of ["http://localhost:4788/api/oauth/callback", null]) {
          const error = yield* Effect.flip(executor.oauth.start({ ...startInput, redirectUri }));
          expect(Predicate.isTagged("OAuthStartError")(error)).toBe(true);
          expect(error).toEqual(
            expect.objectContaining({
              message: expect.stringContaining(
                "requires the loopback callback http://127.0.0.1:3118/callback",
              ),
            }),
          );
        }
      }),
    ),
  );

  it.effect("refuses a port the provider could never have registered", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        const error = yield* Effect.flip(
          executor.oauth.createClient({
            owner: "org",
            slug: CLIENT,
            authorizationUrl: "https://acme.test/authorize",
            tokenUrl: "https://acme.test/token",
            grant: "authorization_code",
            clientId: "test-client",
            clientSecret: "test-secret",
            callbackPort: 80,
          }),
        );
        expect(Predicate.isTagged("StorageError")(error)).toBe(true);
        expect(error).toEqual(
          expect.objectContaining({ message: expect.stringContaining("unprivileged port") }),
        );
        expect(yield* executor.oauth.listClients()).toEqual([]);
      }),
    ),
  );

  it.effect("refuses a callback path that would not round-trip", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        const error = yield* Effect.flip(
          executor.oauth.createClient({
            owner: "org",
            slug: CLIENT,
            authorizationUrl: "https://acme.test/authorize",
            tokenUrl: "https://acme.test/token",
            grant: "authorization_code",
            clientId: "test-client",
            clientSecret: "test-secret",
            callbackPort: 3118,
            callbackPath: "/callback?tenant=1",
          }),
        );
        expect(Predicate.isTagged("StorageError")(error)).toBe(true);
        expect(error).toEqual(
          expect.objectContaining({ message: expect.stringContaining("absolute path") }),
        );
      }),
    ),
  );

  it.effect("an app without a declaration reports none", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: "https://acme.test/authorize",
          tokenUrl: "https://acme.test/token",
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        });

        expect(
          yield* executor.oauth.loopbackCallback({ client: CLIENT, clientOwner: "org" }),
        ).toBeNull();
        expect(
          yield* executor.oauth.loopbackCallback({
            client: OAuthClientSlug.make("never-registered"),
            clientOwner: "org",
          }),
        ).toBeNull();
      }),
    ),
  );
});
