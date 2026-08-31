import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Predicate } from "effect";
import { withQueryContext } from "@executor-js/fumadb/query";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  OAuthState,
  ProviderKey,
  Subject,
  Tenant,
  ToolAddress,
  ToolName,
} from "./ids";
import { authToolFailure } from "./auth-tool-failure";
import { createExecutor } from "./executor";
import { decodeOAuthCallbackState } from "./oauth";
import { OAuthStartError } from "./oauth-client";
import { missingGrantedOAuthScopes } from "./oauth-service";
import { definePlugin } from "./plugin";
import type { CredentialProvider } from "./provider";
import { makeTestConfig, makeTestWorkspaceHarness, memoryCredentialsPlugin } from "./test-config";
import { ToolResult } from "./tool-result";
import { serveOAuthTestServer } from "./testing/oauth-test-server";

// Milestone 2: prove the v2 `oauth.start` / `oauth.complete` token-minting flow
// and OAuth access-token refresh end to end against the test authorization
// server.

const INTEG = IntegrationSlug.make("acme");
const TEMPLATE = AuthTemplateSlug.make("oauth");
const CLIENT = OAuthClientSlug.make("acme-app");

const oauthPlugin = definePlugin(() => ({
  id: "acme" as const,
  storage: () => ({}),
  resolveTools: () =>
    Effect.succeed({
      tools: [{ name: ToolName.make("whoami"), description: "whoami" }],
    }),
  describeAuthMethods: (record) => {
    const config = record.config as { readonly scopes?: readonly string[] } | null;
    return [
      {
        id: "oauth",
        label: "OAuth2",
        kind: "oauth" as const,
        template: String(TEMPLATE),
        oauth: { scopes: config?.scopes ?? [] },
      },
    ];
  },
  // Echo the resolved credential value (the OAuth access token) back out.
  invokeTool: ({ credential }) => Effect.succeed({ token: credential.value }),
  checkHealth: ({ credential }) =>
    Effect.succeed({
      status: credential.value === null ? "expired" : "healthy",
      checkedAt: Date.now(),
    }),
  extension: (ctx) => ({
    seed: (scopes: readonly string[] = []) =>
      ctx.core.integrations.register({
        slug: INTEG,
        description: "Acme",
        config: { scopes },
      }),
  }),
}))();

const plugins = [memoryCredentialsPlugin(), oauthPlugin] as const;

// Stated explicitly where a test builds a SECOND root database handle by hand:
// both handles must carry the same owner-policy context to address one
// connection, so the values cannot be left to `makeTestConfig`'s defaults.
const SHARED_STORE_TENANT = "test-tenant";
const SHARED_STORE_SUBJECT = "test-subject";

/** The URL a `fetch` double was handed, however the caller spelled it. */
const fetchTarget = (input: Parameters<typeof globalThis.fetch>[0]): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

/**
 * A `fetch` that holds token-endpoint requests open AFTER the authorization
 * server has answered them.
 *
 * Parking after the response is the point. The refresh token has been rotated
 * upstream by then, and the in-flight gate entry is still registered, so a peer
 * arriving during the park has to resolve against an OPEN grant rather than a
 * settled one. Parking before the response would prove nothing: the grant would
 * never reach the server, and a peer that went on to run its own grant would
 * find the stored token still live and succeed.
 *
 * Idle until `arm()`, so connection setup (the authorization-code exchange)
 * runs through untouched.
 */
const makeTokenRequestPark = () => {
  let armed = false;
  let onSeen: (() => void) | null = null;
  const seen = new Promise<void>((resolve) => {
    onSeen = resolve;
  });
  let onRelease: (() => void) | null = null;
  const parked = new Promise<void>((resolve) => {
    onRelease = resolve;
  });
  // oxlint-disable-next-line executor/no-raw-fetch -- test boundary: the park wraps the platform fetch and must delegate back to it, which is the only seam that can hold a token request open mid-grant.
  const platformFetch: typeof globalThis.fetch = globalThis.fetch;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const response = await platformFetch(input, init);
    if (armed && new URL(fetchTarget(input)).pathname === "/token") {
      onSeen?.();
      await parked;
    }
    return response;
  };
  return {
    fetch,
    arm: () => {
      armed = true;
    },
    /** Resolves once a token request has been answered and is being held. */
    seen,
    release: () => onRelease?.(),
  };
};

/** Every refresh-token grant the authorization server was asked for. */
const refreshGrantsIn = (
  requests: ReadonlyArray<{ readonly path: string; readonly body: string }>,
) =>
  requests.filter(
    (request) => request.path === "/token" && request.body.includes("grant_type=refresh_token"),
  );

interface TokenEndpointCall {
  readonly host: string;
  readonly grantType: string | null;
}

// Route token-endpoint requests aimed at a *non-loopback* host (the
// regional/attacker hosts a multi-site rebind test exercises) back to the
// loopback test AS, recording the host + grant each one was sent to. The token
// exchange/refresh runs through `oauth4webapi`, which calls the global `fetch`
// at request time, so swapping `globalThis.fetch` lets the real
// `oauth.complete` / refresh path drive the rebind decision while still hitting
// a live authorization server. Loopback traffic (the authorize/login hops)
// passes straight through untouched. Returns a restore function.
const routeTokenEndpointToLoopback = (
  server: { readonly issuerUrl: string },
  record: TokenEndpointCall[],
): (() => void) => {
  // oxlint-disable-next-line executor/no-raw-fetch -- test boundary: oauth4webapi reads the global `fetch` at call time, so doubling it is the only seam to observe the token exchange/refresh host.
  const originalFetch = globalThis.fetch;
  const loopback = new URL(server.issuerUrl);
  const patched: typeof fetch = async (input, init) => {
    const requestUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const target = new URL(requestUrl);
    if (target.hostname === loopback.hostname) {
      return originalFetch(input as Parameters<typeof fetch>[0], init);
    }
    if (target.pathname === "/token") {
      const bodyText =
        init?.body instanceof URLSearchParams
          ? init.body.toString()
          : typeof init?.body === "string"
            ? init.body
            : input instanceof Request
              ? await input.clone().text()
              : "";
      record.push({
        host: target.hostname,
        grantType: new URLSearchParams(bodyText).get("grant_type"),
      });
    }
    const rerouted = new URL(loopback.origin);
    rerouted.pathname = target.pathname;
    rerouted.search = target.search;
    return input instanceof Request
      ? originalFetch(new Request(rerouted.href, input))
      : originalFetch(rerouted.href, init);
  };
  // oxlint-disable-next-line executor/no-raw-fetch -- test boundary: install the doubled fetch (see above).
  globalThis.fetch = patched;
  return () => {
    // oxlint-disable-next-line executor/no-raw-fetch -- test boundary: restore the original fetch.
    globalThis.fetch = originalFetch;
  };
};

describe("oauth.start / oauth.complete", () => {
  it.effect(
    "createClient → start (redirect) → complete mints a connection + tools, executable",
    () =>
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
            resource: server.mcpResourceUrl,
          });

          const started = yield* executor.oauth.start({
            owner: "org",
            client: CLIENT,
            clientOwner: "org",
            name: ConnectionName.make("main-account"),
            integration: INTEG,
            template: TEMPLATE,
          });
          expect(started.status).toBe("redirect");
          if (started.status !== "redirect") return;

          // Drive the test AS through the authorization request to obtain the
          // callback code + echoed state.
          const callback = yield* server.completeAuthorizationCodeFlow({
            authorizationUrl: started.authorizationUrl,
          });
          expect(callback.state).toBe(String(started.state));

          const connection = yield* executor.oauth.complete({
            state: started.state,
            code: callback.code,
          });
          expect(String(connection.name)).toBe("mainAccount");
          expect(String(connection.address)).toBe("tools.acme.org.mainAccount");
          expect(connection.expiresAt).toBeGreaterThan(Date.now());
          const requests = yield* server.requests;
          const authorizationRequest = requests.find(
            (r) => r.path === "/authorize" && r.method === "GET",
          );
          expect(authorizationRequest?.query.resource).toBe(server.mcpResourceUrl);
          const tokenRequest = requests.find(
            (r) => r.path === "/token" && r.method === "POST" && r.body.includes("grant_type"),
          );
          expect(tokenRequest?.body).toContain(
            `resource=${encodeURIComponent(server.mcpResourceUrl)}`,
          );

          // The connection produced its tools.
          const tools = yield* executor.tools.list();
          expect(tools.map((t) => String(t.name))).toEqual(["whoami"]);

          // Executing the tool resolves the minted access token, which the AS
          // recognises as one it issued.
          const out = (yield* executor.execute(
            ToolAddress.make("tools.acme.org.mainAccount.whoami"),
            {},
          )) as { token: string };
          expect(out.token).toMatch(/^at_/);
          expect(yield* server.acceptsAccessToken(out.token)).toBe(true);
        }),
      ),
  );

  it.effect("persists HTTP Basic client auth for code exchange and refresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({
          scopes: ["read"],
          defaultTokenEndpointAuthMethod: "client_secret_basic",
        });
        const { executor, config } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();

        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
          tokenEndpointAuthMethod: "basic",
        });

        const started = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("basic-client"),
          integration: INTEG,
          template: TEMPLATE,
        });
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;

        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });
        yield* executor.oauth.complete({ state: started.state, code: callback.code });

        yield* Effect.promise(() =>
          config.db.updateMany("connection", {
            where: (b) => b("name", "=", "basicClient"),
            set: { expires_at: Date.now() - 60_000 },
          }),
        );
        const refreshed = (yield* executor.execute(
          ToolAddress.make("tools.acme.org.basicClient.whoami"),
          {},
        )) as { token: string };
        expect(refreshed.token).toMatch(/^at_/);

        const tokenRequests = (yield* server.requests).filter(
          (request) => request.path === "/token" && request.method === "POST",
        );
        expect(tokenRequests).toHaveLength(2);
        for (const request of tokenRequests) {
          expect(request.headers.authorization).toMatch(/^Basic /);
          expect(request.body).not.toContain("client_secret=");
        }
        expect(tokenRequests[0]?.body).toContain("grant_type=authorization_code");
        expect(tokenRequests[1]?.body).toContain("grant_type=refresh_token");
      }),
    ),
  );

  it.effect("carries the URL org selector in provider state without changing redirect_uri", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const { executor } = yield* makeTestWorkspaceHarness({
          plugins,
          oauthCallbackStateOrgSlug: "acme",
        });
        yield* executor.acme.seed();

        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        });

        const started = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("main-account"),
          integration: INTEG,
          template: TEMPLATE,
        });
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;

        const authorizationUrl = new URL(started.authorizationUrl);
        const redirectUri = new URL(authorizationUrl.searchParams.get("redirect_uri") ?? "");
        const providerState = authorizationUrl.searchParams.get("state") ?? "";

        expect(redirectUri.toString()).toBe("http://localhost/oauth/callback");
        expect(providerState).not.toBe(String(started.state));
        expect(decodeOAuthCallbackState(providerState)).toEqual({
          state: String(started.state),
          orgSlug: "acme",
        });

        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });
        const callbackState = decodeOAuthCallbackState(callback.state);
        expect(callbackState).not.toBeNull();
        if (callbackState === null) return;

        const connection = yield* executor.oauth.complete({
          state: OAuthState.make(callbackState.state),
          code: callback.code,
        });
        expect(String(connection.address)).toBe("tools.acme.org.mainAccount");
      }),
    ),
  );

  it.effect("records offline_access when a refresh token proves it was granted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({
          scopes: ["offline_access", "read"],
          omitTokenResponseScopes: ["offline_access"],
        });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed(["offline_access", "read"]);

        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        });

        const started = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("main-account"),
          integration: INTEG,
          template: TEMPLATE,
        });
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;

        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });
        const connection = yield* executor.oauth.complete({
          state: started.state,
          code: callback.code,
        });

        expect(connection.oauthScope?.split(/\s+/)).toEqual(["read", "offline_access"]);
      }),
    ),
  );

  it.effect("persists connection identity from id_token claims on authorization-code grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({
          scopes: ["openid", "email", "profile", "read"],
          idTokenClaims: { email: "alice@example.com", sub: "user-1" },
        });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed(["openid", "email", "profile", "read"]);

        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        });

        const started = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
        });
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;

        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });
        const connection = yield* executor.oauth.complete({
          state: started.state,
          code: callback.code,
        });

        expect(connection.identityLabel).toBe("alice@example.com");
      }),
    ),
  );

  it.effect("keeps an explicit OAuth session identity label over id_token claims", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({
          scopes: ["openid", "email", "profile", "read"],
          idTokenClaims: { email: "alice@example.com", sub: "user-1" },
        });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed(["openid", "email", "profile", "read"]);

        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        });

        const started = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
          identityLabel: "Work account",
        });
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;

        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });
        const connection = yield* executor.oauth.complete({
          state: started.state,
          code: callback.code,
        });

        expect(connection.identityLabel).toBe("Work account");
      }),
    ),
  );

  it.effect("newConnection resolves a taken name to the next free suffix", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({
          scopes: ["openid", "email", "profile", "read"],
          idTokenClaims: { email: "alice@example.com", sub: "user-1" },
        });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed(["openid", "email", "profile", "read"]);

        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        });

        const runFlow = Effect.gen(function* () {
          const started = yield* executor.oauth.start({
            owner: "org",
            client: CLIENT,
            clientOwner: "org",
            name: ConnectionName.make("main"),
            integration: INTEG,
            template: TEMPLATE,
            newConnection: true,
          });
          expect(started.status).toBe("redirect");
          if (started.status !== "redirect") return null;
          const callback = yield* server.completeAuthorizationCodeFlow({
            authorizationUrl: started.authorizationUrl,
          });
          return yield* executor.oauth.complete({
            state: started.state,
            code: callback.code,
          });
        });

        const first = yield* runFlow;
        const second = yield* runFlow;
        expect(String(first?.name)).toBe("main");
        expect(String(second?.name)).toBe("main2");

        const connections = yield* executor.connections.list({ integration: INTEG });
        expect(connections.map((connection) => String(connection.name)).sort()).toEqual([
          "main",
          "main2",
        ]);
      }),
    ),
  );

  it.effect("newConnection suffixes a name that only normalizes on the server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Regression: a human label like "Work Gmail" reaches `start` as the
        // client-derived "workGmail". The mint stores the `connectionIdentifier`
        // form; before the fix the free-name guard compared the un-re-normalized
        // name case-sensitively, missed the existing row, and the second connect
        // OVERWROTE the first account instead of minting a suffixed name.
        const server = yield* serveOAuthTestServer({
          scopes: ["openid", "email", "profile", "read"],
          idTokenClaims: { email: "alice@example.com", sub: "user-1" },
        });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed(["openid", "email", "profile", "read"]);

        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        });

        const runFlow = Effect.gen(function* () {
          const started = yield* executor.oauth.start({
            owner: "org",
            client: CLIENT,
            clientOwner: "org",
            // A raw label the client would type, not an already-normalized name.
            name: ConnectionName.make("Work Gmail"),
            integration: INTEG,
            template: TEMPLATE,
            newConnection: true,
          });
          expect(started.status).toBe("redirect");
          if (started.status !== "redirect") return null;
          const callback = yield* server.completeAuthorizationCodeFlow({
            authorizationUrl: started.authorizationUrl,
          });
          return yield* executor.oauth.complete({
            state: started.state,
            code: callback.code,
          });
        });

        const first = yield* runFlow;
        const second = yield* runFlow;
        // The stored name is the normalized form, and the second connect resolves
        // to a distinct suffixed name rather than re-minting the first row.
        expect(String(first?.name)).toBe("workGmail");
        expect(String(second?.name)).toBe("workGmail2");

        const connections = yield* executor.connections.list({ integration: INTEG });
        expect(connections.map((connection) => String(connection.name)).sort()).toEqual([
          "workGmail",
          "workGmail2",
        ]);
      }),
    ),
  );

  it.effect("preserves a curated label when reconnecting without an explicit label", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({
          scopes: ["openid", "email", "profile", "read"],
          idTokenClaims: { email: "alice@example.com", sub: "user-1" },
        });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed(["openid", "email", "profile", "read"]);

        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        });

        const runFlow = Effect.gen(function* () {
          const started = yield* executor.oauth.start({
            owner: "org",
            client: CLIENT,
            clientOwner: "org",
            name: ConnectionName.make("main"),
            integration: INTEG,
            template: TEMPLATE,
          });
          expect(started.status).toBe("redirect");
          if (started.status !== "redirect") return null;
          const callback = yield* server.completeAuthorizationCodeFlow({
            authorizationUrl: started.authorizationUrl,
          });
          return yield* executor.oauth.complete({
            state: started.state,
            code: callback.code,
          });
        });

        const first = yield* runFlow;
        expect(first?.identityLabel).toBe("alice@example.com");

        // The user renames the connection, then reconnects (no typed label).
        yield* executor.connections.update(
          { owner: "org", integration: INTEG, name: ConnectionName.make("main") },
          { identityLabel: "Finance account" },
        );
        const second = yield* runFlow;
        expect(second?.identityLabel).toBe("Finance account");
      }),
    ),
  );

  it.effect("does not overwrite connection identity from id_token claims on refresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({
          scopes: ["openid", "email", "profile", "read"],
          idTokenClaims: { email: "alice@example.com", sub: "user-1" },
          refreshIdTokenClaims: { email: "refreshed@example.com", sub: "user-2" },
        });
        const harness = yield* makeTestWorkspaceHarness({ plugins });
        const { executor, config } = harness;
        yield* executor.acme.seed(["openid", "email", "profile", "read"]);

        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        });

        const started = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
        });
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;
        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });
        yield* executor.oauth.complete({
          state: started.state,
          code: callback.code,
        });

        yield* Effect.promise(() =>
          config.db.updateMany("connection", {
            where: (b) => b("name", "=", "main"),
            set: { expires_at: Date.now() - 60_000 },
          }),
        );

        yield* executor.execute(ToolAddress.make("tools.acme.org.main.whoami"), {});
        const refreshed = yield* executor.connections.get({
          owner: "org",
          integration: INTEG,
          name: ConnectionName.make("main"),
        });
        expect(refreshed?.identityLabel).toBe("alice@example.com");
      }),
    ),
  );

  it.effect("start (authorization_code) fails loudly when the executor has no redirectUri", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        // EXPLICIT: construct the executor WITHOUT a redirectUri (null) — there
        // is no silent localhost default. The redirect flow must fail loudly
        // rather than handing the provider a wrong `http://127.0.0.1/callback`.
        const { executor } = yield* makeTestWorkspaceHarness({
          plugins,
          redirectUri: null,
        });
        yield* executor.acme.seed();

        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        });

        const error = yield* Effect.flip(
          executor.oauth.start({
            owner: "org",
            client: CLIENT,
            clientOwner: "org",
            name: ConnectionName.make("main"),
            integration: INTEG,
            template: TEMPLATE,
          }),
        );
        // `OAuthStartError` carries a typed `message`; the `Predicate.isTagged`
        // guard narrows the union so this read is on a typed failure.
        expect(Predicate.isTagged("OAuthStartError")(error)).toBe(true);
        const startError = error as OAuthStartError;
        expect(startError.message).toContain("redirectUri");
      }),
    ),
  );

  it.effect("client_credentials start still mints without a redirectUri (no redirect needed)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        // No redirectUri configured, but client_credentials never redirects —
        // it must still mint the connection inline.
        const { executor } = yield* makeTestWorkspaceHarness({
          plugins,
          redirectUri: null,
        });
        yield* executor.acme.seed();

        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "client_credentials",
          clientId: "test-client",
          clientSecret: "test-secret",
        });

        const started = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("cc"),
          integration: INTEG,
          template: TEMPLATE,
        });
        expect(started.status).toBe("connected");
      }),
    ),
  );

  it.effect("complete with an unknown state fails OAuthSessionNotFoundError", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer();
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
        });
        const result = yield* Effect.flip(
          executor.oauth.complete({
            state: OAuthState.make("nonexistent"),
            code: "whatever",
          }),
        );
        expect(Predicate.isTagged("OAuthSessionNotFoundError")(result)).toBe(true);
      }),
    ),
  );

  it.effect(
    "a Workspace (org) app mints a Personal (user) connection — own→shared client resolution",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* serveOAuthTestServer({ scopes: ["read"] });
          const { executor } = yield* makeTestWorkspaceHarness({ plugins });
          yield* executor.acme.seed();

          // The app is registered under the WORKSPACE (org) — "shared with
          // everyone in the workspace".
          yield* executor.oauth.createClient({
            owner: "org",
            slug: CLIENT,
            authorizationUrl: server.authorizationEndpoint,
            tokenUrl: server.tokenEndpoint,
            grant: "authorization_code",
            clientId: "test-client",
            clientSecret: "test-secret",
          });

          // Start the flow for a PERSONAL (user) connection. The member has no
          // own `acme-app`, so the resolver falls back to the shared org app.
          const started = yield* executor.oauth.start({
            owner: "user",
            client: CLIENT,
            clientOwner: "org",
            name: ConnectionName.make("mine"),
            integration: INTEG,
            template: TEMPLATE,
          });
          expect(started.status).toBe("redirect");
          if (started.status !== "redirect") return;

          const callback = yield* server.completeAuthorizationCodeFlow({
            authorizationUrl: started.authorizationUrl,
          });
          const connection = yield* executor.oauth.complete({
            state: started.state,
            code: callback.code,
          });

          // Minted under the PERSONAL owner, not the app's org owner — and it
          // points back to the shared app it was minted through.
          expect(connection.owner).toBe("user");
          expect(String(connection.address)).toBe("tools.acme.user.mine");
          expect(String(connection.oauthClient)).toBe("acme-app");
          // The app's owner is recorded explicitly (Workspace app, Personal connection).
          expect(connection.oauthClientOwner).toBe("org");
        }),
      ),
  );

  it.effect("a Workspace (org) connection cannot use a member's private (user) app", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();

        // A PRIVATE app owned by the member.
        yield* executor.oauth.createClient({
          owner: "user",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        });

        // Sharing is one-directional (org → members). Backing a Workspace (org)
        // connection with a member's private (user) app is rejected by the
        // direction guard.
        const error = yield* Effect.flip(
          executor.oauth.start({
            owner: "org",
            clientOwner: "user",
            client: CLIENT,
            name: ConnectionName.make("shared"),
            integration: INTEG,
            template: TEMPLATE,
          }),
        );
        expect(Predicate.isTagged("OAuthStartError")(error)).toBe(true);
        const startError = error as OAuthStartError;
        expect(startError.message).toContain("must use a Workspace app");
      }),
    ),
  );
});

describe("oauth token refresh in resolveConnectionValue", () => {
  it.effect("an expired access token is refreshed before resolving", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const harness = yield* makeTestWorkspaceHarness({ plugins });
        const { executor, config } = harness;
        yield* executor.acme.seed();

        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
          resource: server.mcpResourceUrl,
        });

        const started = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
        });
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;
        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });
        yield* executor.oauth.complete({
          state: started.state,
          code: callback.code,
        });

        // The first resolve returns the freshly minted access token.
        const firstToken = (yield* executor.execute(
          ToolAddress.make("tools.acme.org.main.whoami"),
          {},
        )) as { token: string };
        expect(firstToken.token).toMatch(/^at_/);

        // Force the access token to be expired so the next resolve refreshes.
        yield* Effect.promise(() =>
          config.db.updateMany("connection", {
            where: (b) => b("name", "=", "main"),
            set: { expires_at: Date.now() - 60_000 },
          }),
        );

        const refreshedToken = (yield* executor.execute(
          ToolAddress.make("tools.acme.org.main.whoami"),
          {},
        )) as { token: string };

        // A refresh-token grant minted a brand-new access token.
        expect(refreshedToken.token).toMatch(/^at_/);
        expect(refreshedToken.token).not.toBe(firstToken.token);
        expect(yield* server.acceptsAccessToken(refreshedToken.token)).toBe(true);
        const requests = yield* server.requests;
        const refreshRequest = requests.find(
          (r) => r.path === "/token" && r.method === "POST" && r.body.includes("refresh_token"),
        );
        expect(refreshRequest?.body).toContain(
          `resource=${encodeURIComponent(server.mcpResourceUrl)}`,
        );
      }),
    ),
  );

  // Issue #1520, in one process. A self-host builds a FRESH execution stack per
  // MCP session over ONE database handle, so two sessions resolving the same
  // connection each read the same stored refresh token and each believe they
  // are the refresh winner. The authorization server rotates that token, so the
  // loser redeems one the winner already spent, and a server that detects reuse
  // revokes the whole family: the connection dies and the user must
  // reauthorize. The first refresh always succeeds, which is why the fault
  // stays invisible until a later expiry.
  it.effect("two execution stacks over one host database share a single refresh grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const park = makeTokenRequestPark();

        // One database handle and one credential store under two execution
        // stacks — what a self-host holds while two MCP sessions are open.
        const config = { ...makeTestConfig({ plugins }), fetch: park.fetch };
        const sessionA = yield* createExecutor(config);
        const sessionB = yield* createExecutor(config);
        yield* Effect.addFinalizer(() => sessionA.close().pipe(Effect.ignore));
        yield* Effect.addFinalizer(() => sessionB.close().pipe(Effect.ignore));
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => config.testDb.close()).pipe(Effect.ignore),
        );

        yield* sessionA.acme.seed();
        yield* sessionA.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        });
        const started = yield* sessionA.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
        });
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;
        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });
        yield* sessionA.oauth.complete({ state: started.state, code: callback.code });

        const address = ToolAddress.make("tools.acme.org.main.whoami");
        const original = (yield* sessionA.execute(address, {})) as { token: string };

        // Expire the access token so BOTH stacks must refresh.
        yield* Effect.promise(() =>
          config.db.updateMany("connection", {
            where: (b) => b("name", "=", "main"),
            set: { expires_at: Date.now() - 60_000 },
          }),
        );
        yield* server.clearRequests;
        park.arm();

        const first = yield* Effect.forkChild(sessionA.execute(address, {}));
        const second = yield* Effect.forkChild(sessionB.execute(address, {}));
        // Release only once a grant has been answered and is being held open,
        // so the peer resolves against a grant that is still in flight. Without
        // the park the peer could arrive after the winner had already settled,
        // find a fresh token, refresh nothing, and pass this test for the wrong
        // reason.
        yield* Effect.promise(() => park.seen);
        park.release();

        const firstToken = (yield* Fiber.join(first)) as { token: string };
        const secondToken = (yield* Fiber.join(second)) as { token: string };

        expect(firstToken.token, "the refresh minted a new access token").not.toBe(original.token);
        expect(secondToken.token, "both stacks resolved the SAME refreshed token").toBe(
          firstToken.token,
        );
        expect(
          refreshGrantsIn(yield* server.requests),
          "one refresh grant for the connection, not one per execution stack",
        ).toHaveLength(1);
      }),
    ),
  );

  // The gate spans tenants (one map per root DB handle), so its key must keep
  // tenant and subject unambiguous. Both are opaque strings that may contain
  // any delimiter: under a colon-joined key, tenant "a" + subject "user:b" and
  // tenant "a:user" + subject "b" both flatten to "a:user:user:b:…", so two
  // DIFFERENT tenants' refreshes would share one gate entry and one tenant's
  // caller would be handed the other tenant's access token.
  it.effect(
    "colliding tenant/subject pairs never share a refresh gate entry",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const serverA = yield* serveOAuthTestServer({ scopes: ["read"] });
          const serverB = yield* serveOAuthTestServer({ scopes: ["read"] });
          const parkA = makeTokenRequestPark();
          const parkB = makeTokenRequestPark();

          // ONE root DB handle under TWO tenants — the shape a multi-tenant host
          // holds — so both executors share one refresh gate. `shared.db` stays
          // bound to tenant A's owner-policy context; tenant B's row edits below
          // build their own scoped handle by hand. Each tenant gets its OWN
          // credential store instance: the memory store keys items without a
          // tenant, so sharing one across tenants would cross their tokens at
          // the store layer and mask the gate-key collision this test is about.
          const pluginsA = [memoryCredentialsPlugin(), oauthPlugin] as const;
          const pluginsB = [memoryCredentialsPlugin(), oauthPlugin] as const;
          const shared = makeTestConfig({ plugins: pluginsA, tenant: "a", subject: "user:b" });
          const configA = { ...shared, fetch: parkA.fetch };
          const configB = {
            ...shared,
            plugins: pluginsB,
            tenant: Tenant.make("a:user"),
            subject: Subject.make("b"),
            fetch: parkB.fetch,
          };
          const sessionA = yield* createExecutor(configA);
          const sessionB = yield* createExecutor(configB);
          yield* Effect.addFinalizer(() => sessionA.close().pipe(Effect.ignore));
          yield* Effect.addFinalizer(() => sessionB.close().pipe(Effect.ignore));
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => shared.testDb.close()).pipe(Effect.ignore),
          );

          // Each tenant mints its own USER-owned connection (user rows carry the
          // session subject, which is what the colliding pair needs) against its
          // own authorization server, so token provenance is observable.
          const connect = (session: typeof sessionA, server: typeof serverA) =>
            Effect.gen(function* () {
              yield* session.acme.seed();
              yield* session.oauth.createClient({
                owner: "org",
                slug: CLIENT,
                authorizationUrl: server.authorizationEndpoint,
                tokenUrl: server.tokenEndpoint,
                grant: "authorization_code",
                clientId: "test-client",
                clientSecret: "test-secret",
              });
              const started = yield* session.oauth.start({
                owner: "user",
                client: CLIENT,
                clientOwner: "org",
                name: ConnectionName.make("mine"),
                integration: INTEG,
                template: TEMPLATE,
              });
              expect(started.status).toBe("redirect");
              if (started.status !== "redirect") return;
              const callback = yield* server.completeAuthorizationCodeFlow({
                authorizationUrl: started.authorizationUrl,
              });
              yield* session.oauth.complete({ state: started.state, code: callback.code });
            });
          yield* connect(sessionA, serverA);
          yield* connect(sessionB, serverB);

          const address = ToolAddress.make("tools.acme.user.mine.whoami");
          const originalA = (yield* sessionA.execute(address, {})) as { token: string };
          const originalB = (yield* sessionB.execute(address, {})) as { token: string };
          expect(originalB.token).not.toBe(originalA.token);

          // Expire BOTH rows so both tenants must refresh. `shared.db` is bound
          // to tenant A; tenant B's partition needs its own scoped handle.
          const dbB = withQueryContext(shared.testDb.db, { tenant: "a:user", subject: "b" });
          yield* Effect.promise(() =>
            shared.db.updateMany("connection", {
              where: (b) => b("name", "=", "mine"),
              set: { expires_at: Date.now() - 60_000 },
            }),
          );
          yield* Effect.promise(() =>
            dbB.updateMany("connection", {
              where: (b) => b("name", "=", "mine"),
              set: { expires_at: Date.now() - 60_000 },
            }),
          );

          parkA.arm();
          parkB.arm();
          const first = yield* Effect.forkChild(sessionA.execute(address, {}));
          // Hold tenant A's grant open so its gate entry is still registered
          // when tenant B performs its lookup of the would-be colliding key.
          yield* Effect.promise(() => parkA.seen);
          const second = yield* Effect.forkChild(sessionB.execute(address, {}));
          // With a collision-free key, tenant B misses the gate and sends its
          // OWN grant. Under a colliding key it would await tenant A's deferred
          // and never reach its server, so cap the wait with a real timer (the
          // test clock is virtual, so Effect.sleep would never fire) instead of
          // hanging the suite; the assertions below then report the bleed.
          yield* Effect.promise(() =>
            Promise.race([parkB.seen, new Promise((resolve) => setTimeout(resolve, 2_000))]),
          );
          parkA.release();
          parkB.release();

          const tokenA = (yield* Fiber.join(first)) as { token: string };
          const tokenB = (yield* Fiber.join(second)) as { token: string };

          expect(tokenA.token, "tenant A refreshed to a new token").not.toBe(originalA.token);
          expect(tokenB.token, "tenant B refreshed to a new token").not.toBe(originalB.token);
          expect(tokenB.token, "no cross-tenant token bleed").not.toBe(tokenA.token);
          expect(yield* serverA.acceptsAccessToken(tokenA.token)).toBe(true);
          expect(
            yield* serverB.acceptsAccessToken(tokenB.token),
            "tenant B's token was minted by tenant B's own authorization server",
          ).toBe(true);
          expect(
            refreshGrantsIn(yield* serverA.requests),
            "tenant A ran its own refresh grant",
          ).toHaveLength(1);
          expect(
            refreshGrantsIn(yield* serverB.requests),
            "tenant B ran its own refresh grant — two distinct refresh executions",
          ).toHaveLength(1);
        }),
      ),
    // Two authorization servers, two full mint flows and two refreshes — about
    // twice the cost of the single-tenant gate tests, which sits on the 5s
    // default when the test runs cold.
    20_000,
  );

  // The gate entry is shared, so the stack that REGISTERS a grant is only the
  // first arrival, not its owner. Running the grant on that caller's fiber
  // would hand it that caller's interruption — a disconnected MCP client, an
  // execution deadline, a cancelled tool call — and abandon a refresh token the
  // authorization server has ALREADY rotated. What the store still holds is
  // then dead, and the next grant is answered invalid_grant: the interruption
  // would have killed the connection. So the grant runs detached, and callers
  // only await it.
  it.effect("an interrupted first arrival still settles the grant and persists its token", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const park = makeTokenRequestPark();

        const config = { ...makeTestConfig({ plugins }), fetch: park.fetch };
        const sessionA = yield* createExecutor(config);
        const sessionB = yield* createExecutor(config);
        yield* Effect.addFinalizer(() => sessionA.close().pipe(Effect.ignore));
        yield* Effect.addFinalizer(() => sessionB.close().pipe(Effect.ignore));
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => config.testDb.close()).pipe(Effect.ignore),
        );

        yield* sessionA.acme.seed();
        yield* sessionA.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        });
        const started = yield* sessionA.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
        });
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;
        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });
        yield* sessionA.oauth.complete({ state: started.state, code: callback.code });

        const address = ToolAddress.make("tools.acme.org.main.whoami");
        const original = (yield* sessionA.execute(address, {})) as { token: string };
        yield* Effect.promise(() =>
          config.db.updateMany("connection", {
            where: (b) => b("name", "=", "main"),
            set: { expires_at: Date.now() - 60_000 },
          }),
        );
        yield* server.clearRequests;
        park.arm();

        // The first arrival registers the grant, and its session drops the
        // instant the authorization server has rotated the token — the worst
        // possible moment, and the one a disconnecting MCP client picks.
        const arrival = yield* Effect.forkChild(Effect.exit(sessionA.execute(address, {})));
        yield* Effect.promise(() => park.seen);
        yield* Fiber.interrupt(arrival);
        park.release();

        // That the grant finishes at all, with nobody left waiting on it, is
        // the property under test: a rotated token that is never persisted is a
        // dead connection.
        const persisted = yield* Effect.promise(async () => {
          for (let attempt = 0; attempt < 500; attempt += 1) {
            const row = await config.db.findFirst("connection", {
              where: (b) => b("name", "=", "main"),
            });
            const expiresAt = row?.expires_at;
            if (expiresAt != null && Number(expiresAt) > Date.now()) return true;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          return false;
        });
        expect(persisted, "the detached grant settled and persisted its rotated token").toBe(true);

        const recovered = (yield* sessionB.execute(address, {})) as { token: string };
        expect(recovered.token, "the peer stack resolved the rotated token").not.toBe(
          original.token,
        );
        expect(
          yield* server.acceptsAccessToken(recovered.token),
          "and the authorization server still honours it",
        ).toBe(true);
        expect(
          refreshGrantsIn(yield* server.requests),
          "the interrupted arrival's grant settled, so no second grant was needed",
        ).toHaveLength(1);
      }),
    ),
  );

  // Two product instances, one connection, one credential store. The in-flight
  // refresh gate serialises refreshes across every execution stack over ONE
  // root database handle and cannot see past it, so between two INSTANCES —
  // two replicas, two isolates — nothing but the store itself stands between
  // two refreshers and the same rotated token. The provider below opens a seam
  // exactly where the danger is — between the read of the stored refresh token
  // and whatever the reader writes next — because a probe that "tests" the
  // store by rewriting the value it just read would put the spent token back
  // over the peer's rotated one, and kill the connection it was added to
  // protect.
  it.effect(
    "a refresher paused after reading the stored token never writes it back over a peer's rotated one",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* serveOAuthTestServer({ scopes: ["read"] });

          const store = new Map<string, string>();
          // Every item id written, in order — the tape that says WHICH item a
          // refresher touched, which is the whole question here.
          const writes: string[] = [];
          const pausedAtRead = yield* Deferred.make<void>();
          const resumeFromRead = yield* Deferred.make<void>();
          // One-shot: the FIRST read of a refresh token stops there; the
          // peer's read, moments later, runs straight through.
          let pauseNextRefreshRead = false;

          const sharedStore: CredentialProvider = {
            key: ProviderKey.make("shared-memory"),
            writable: true,
            get: (id) =>
              Effect.gen(function* () {
                const value = store.get(String(id)) ?? null;
                if (pauseNextRefreshRead && String(id).endsWith(":refresh")) {
                  pauseNextRefreshRead = false;
                  yield* Deferred.succeed(pausedAtRead, undefined);
                  yield* Deferred.await(resumeFromRead);
                }
                return value;
              }),
            set: (id, value) =>
              Effect.sync(() => {
                writes.push(String(id));
                store.set(String(id), value);
              }),
            delete: (id) => Effect.sync(() => void store.delete(String(id))),
          };

          // One database and one credential store, two executors over them —
          // the deployment this race needs and the one a single harness
          // cannot express.
          //
          // Each executor gets its OWN root database handle onto that one
          // database, because that handle is what identifies an instance: the
          // in-flight refresh gate is shared per handle, so two executors over
          // the SAME handle are two execution stacks in one instance and the
          // second would simply join the first's grant — closing the very
          // window this test exists to open. A second replica holds a second
          // handle, which is what the extra `withQueryContext` wrapper is.
          const config = {
            ...makeTestConfig({
              plugins: [oauthPlugin] as const,
              tenant: SHARED_STORE_TENANT,
              subject: SHARED_STORE_SUBJECT,
            }),
            providers: [sharedStore],
          };
          const instanceA = yield* createExecutor(config);
          const instanceB = yield* createExecutor({
            ...config,
            db: withQueryContext(config.testDb.db, {
              tenant: SHARED_STORE_TENANT,
              subject: SHARED_STORE_SUBJECT,
            }),
          });
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => config.testDb.close()).pipe(Effect.ignore),
          );
          yield* Effect.addFinalizer(() => instanceA.close().pipe(Effect.ignore));
          yield* Effect.addFinalizer(() => instanceB.close().pipe(Effect.ignore));

          yield* instanceA.acme.seed();
          yield* instanceA.oauth.createClient({
            owner: "org",
            slug: CLIENT,
            authorizationUrl: server.authorizationEndpoint,
            tokenUrl: server.tokenEndpoint,
            grant: "authorization_code",
            clientId: "test-client",
            clientSecret: "test-secret",
          });
          const started = yield* instanceA.oauth.start({
            owner: "org",
            client: CLIENT,
            clientOwner: "org",
            name: ConnectionName.make("main"),
            integration: INTEG,
            template: TEMPLATE,
          });
          expect(started.status).toBe("redirect");
          if (started.status !== "redirect") return;
          const callback = yield* server.completeAuthorizationCodeFlow({
            authorizationUrl: started.authorizationUrl,
          });
          yield* instanceA.oauth.complete({ state: started.state, code: callback.code });

          const refreshItemId = [...store.keys()].find((key) => key.endsWith(":refresh"));
          expect(refreshItemId, "the completed connection stored a refresh token").toBeDefined();
          const spentRefreshToken = store.get(refreshItemId!);

          // Expire the access token so both instances must refresh.
          yield* Effect.promise(() =>
            config.db.updateMany("connection", {
              where: (b) => b("name", "=", "main"),
              set: { expires_at: Date.now() - 60_000 },
            }),
          );

          // A begins a refresh and stops the instant it has the stored refresh
          // token in hand. This is the window.
          pauseNextRefreshRead = true;
          const refresherA = yield* Effect.forkChild(
            Effect.exit(instanceA.execute(ToolAddress.make("tools.acme.org.main.whoami"), {})),
          );
          yield* Deferred.await(pausedAtRead);

          // B refreshes on that same token, to completion. The authorization
          // server rotates it, so what the store holds afterwards is the only
          // value left that can ever mint again.
          yield* instanceB.execute(ToolAddress.make("tools.acme.org.main.whoami"), {});
          const rotatedByB = store.get(refreshItemId!);
          expect(rotatedByB, "the peer's refresh rotated the stored token").not.toBe(
            spentRefreshToken,
          );
          const writesBeforeAResumes = writes.length;

          // A resumes into a world where the token it is holding is already
          // spent — and still has to prove the store is writable before it
          // tries to spend it.
          yield* Deferred.succeed(resumeFromRead, undefined);
          yield* Fiber.join(refresherA);

          expect(
            store.get(refreshItemId!),
            "the peer's rotated refresh token is still what the store holds",
          ).toBe(rotatedByB);
          expect(
            [...store.entries()]
              .filter(([, value]) => value === spentRefreshToken)
              .map(([key]) => key),
            "the spent refresh token was not written back anywhere",
          ).toEqual([]);

          // The gate did still run for A — on an item of its own, holding no
          // credential. Its grant then failed on the spent token, so it
          // persisted nothing: this one write is everything A wrote.
          const writtenByA = writes.slice(writesBeforeAResumes);
          expect(writtenByA, "the resumed refresher wrote exactly one item").toHaveLength(1);
          expect(writtenByA[0], "and it was not the refresh token's own item").not.toBe(
            refreshItemId,
          );
          expect(
            [spentRefreshToken, rotatedByB],
            "the item it wrote carries no credential",
          ).not.toContain(store.get(writtenByA[0]!));

          // Both instances really did reach the authorization server, so the
          // interleaving under test happened rather than being short-circuited.
          expect(
            (yield* server.requests).filter(
              (request) =>
                request.path === "/token" && request.body.includes("grant_type=refresh_token"),
            ),
            "both instances sent a refresh grant",
          ).toHaveLength(2);
        }),
      ),
  );

  it.effect(
    "refreshes a Personal (user) connection minted through a Workspace (org) app — own→shared client resolution",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* serveOAuthTestServer({ scopes: ["read"] });
          const harness = yield* makeTestWorkspaceHarness({ plugins });
          const { executor, config } = harness;
          yield* executor.acme.seed();

          // Workspace (org) app …
          yield* executor.oauth.createClient({
            owner: "org",
            slug: CLIENT,
            authorizationUrl: server.authorizationEndpoint,
            tokenUrl: server.tokenEndpoint,
            grant: "authorization_code",
            clientId: "test-client",
            clientSecret: "test-secret",
            resource: server.mcpResourceUrl,
          });

          // … minting a PERSONAL (user) connection.
          const started = yield* executor.oauth.start({
            owner: "user",
            client: CLIENT,
            clientOwner: "org",
            name: ConnectionName.make("mine"),
            integration: INTEG,
            template: TEMPLATE,
          });
          if (started.status !== "redirect") return;
          const callback = yield* server.completeAuthorizationCodeFlow({
            authorizationUrl: started.authorizationUrl,
          });
          yield* executor.oauth.complete({ state: started.state, code: callback.code });

          const firstToken = (yield* executor.execute(
            ToolAddress.make("tools.acme.user.mine.whoami"),
            {},
          )) as { token: string };
          expect(firstToken.token).toMatch(/^at_/);

          // Expire it so the next resolve must refresh. The refresh path resolves
          // the backing client own→shared(org); WITHOUT that fallback it would
          // fail with "OAuth client is no longer registered" since the app is
          // org-owned while the connection is user-owned.
          yield* Effect.promise(() =>
            config.db.updateMany("connection", {
              where: (b) => b("name", "=", "mine"),
              set: { expires_at: Date.now() - 60_000 },
            }),
          );

          const refreshedToken = (yield* executor.execute(
            ToolAddress.make("tools.acme.user.mine.whoami"),
            {},
          )) as { token: string };
          expect(refreshedToken.token).toMatch(/^at_/);
          expect(refreshedToken.token).not.toBe(firstToken.token);
          expect(yield* server.acceptsAccessToken(refreshedToken.token)).toBe(true);
        }),
      ),
  );

  it.effect("checkHealth records expired when OAuth refresh is rejected", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({
          scopes: ["read"],
          supportRefresh: false,
          tokenExpiresInSeconds: 0,
          invalidRefreshTokenDescription: "Grant not found",
        });
        const harness = yield* makeTestWorkspaceHarness({ plugins });
        const { executor, config } = harness;
        yield* executor.acme.seed();

        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
          resource: server.mcpResourceUrl,
        });

        const started = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
        });
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;
        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });
        yield* executor.oauth.complete({
          state: started.state,
          code: callback.code,
        });

        yield* Effect.promise(() =>
          config.db.updateMany("connection", {
            where: (b) => b("name", "=", "main"),
            set: { expires_at: Date.now() - 60_000 },
          }),
        );
        yield* server.clearRequests;

        const result = yield* executor.connections.checkHealth({
          owner: "org",
          integration: INTEG,
          name: ConnectionName.make("main"),
        });

        expect(result.status).toBe("expired");
        expect(result.detail).toContain("Grant not found");
        const refreshed = yield* executor.connections.get({
          owner: "org",
          integration: INTEG,
          name: ConnectionName.make("main"),
        });
        expect(refreshed?.lastHealth).toMatchObject({
          status: "expired",
          detail: expect.stringContaining("Grant not found"),
        });
        const requests = yield* server.requests;
        const refreshRequest = requests.find(
          (r) => r.path === "/token" && r.method === "POST" && r.body.includes("refresh_token"),
        );
        expect(refreshRequest).toBeDefined();

        yield* server.clearRequests;
        const repeated = yield* executor.connections.checkHealth({
          owner: "org",
          integration: INTEG,
          name: ConnectionName.make("main"),
        });
        expect(repeated.status).toBe("expired");
        expect(repeated.detail).toContain("Grant not found");
        expect(yield* server.requests).toHaveLength(0);
      }),
    ),
  );

  it.effect("a definitively rejected grant is not re-sent to the AS on later refreshes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({
          scopes: ["read"],
          supportRefresh: false,
          tokenExpiresInSeconds: 0,
          invalidRefreshTokenDescription: "Grant revoked",
        });
        const harness = yield* makeTestWorkspaceHarness({ plugins });
        const { executor, config } = harness;
        yield* executor.acme.seed();

        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
          resource: server.mcpResourceUrl,
        });

        const started = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
        });
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;
        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });
        yield* executor.oauth.complete({ state: started.state, code: callback.code });

        yield* Effect.promise(() =>
          config.db.updateMany("connection", {
            where: (b) => b("name", "=", "main"),
            set: { expires_at: Date.now() - 60_000 },
          }),
        );
        yield* server.clearRequests;

        // First resolve: the refresh grant reaches the AS and is rejected
        // with invalid_grant — the AS's definitive verdict.
        const first = yield* Effect.flip(
          executor.execute(ToolAddress.make("tools.acme.org.main.whoami"), {}),
        );
        expect(JSON.stringify(first)).toContain("invalid_grant");

        // The verdict is persisted: the dead-grant marker plus an expired
        // health record, without waiting for a probe.
        const row = yield* Effect.promise(() =>
          config.db.findFirst("connection", { where: (b) => b("name", "=", "main") }),
        );
        expect(
          (row?.provider_state as { oauthReauthRequiredAt?: number } | null)?.oauthReauthRequiredAt,
        ).toEqual(expect.any(Number));
        expect(row?.last_health).toMatchObject({ status: "expired" });

        const grantRequests = () =>
          server.requests.pipe(
            Effect.map(
              (all) =>
                all.filter((r) => r.path === "/token" && r.body.includes("refresh_token")).length,
            ),
          );
        const sentBefore = yield* grantRequests();
        expect(sentBefore).toBe(1);

        // Later resolves still fail reauth-required, but WITHOUT re-sending
        // the dead grant: the token endpoint sees no further traffic.
        const second = yield* Effect.flip(
          executor.execute(ToolAddress.make("tools.acme.org.main.whoami"), {}),
        );
        expect(JSON.stringify(second)).toContain("Reconnect");
        expect(yield* grantRequests()).toBe(sentBefore);

        // Reconnecting mints a fresh grant and re-arms refresh: the marker is
        // gone and resolution works again.
        const restarted = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
        });
        expect(restarted.status).toBe("redirect");
        if (restarted.status !== "redirect") return;
        const reCallback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: restarted.authorizationUrl,
        });
        yield* executor.oauth.complete({ state: restarted.state, code: reCallback.code });

        const cleared = yield* Effect.promise(() =>
          config.db.findFirst("connection", { where: (b) => b("name", "=", "main") }),
        );
        expect(
          (cleared?.provider_state as { oauthReauthRequiredAt?: number } | null)
            ?.oauthReauthRequiredAt,
        ).toBeUndefined();
      }),
    ),
  );

  it.effect(
    "checkHealth reports healthy from OAuth credential resolution when no probe is configured",
    () =>
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
            resource: server.mcpResourceUrl,
          });

          const started = yield* executor.oauth.start({
            owner: "org",
            client: CLIENT,
            clientOwner: "org",
            name: ConnectionName.make("main"),
            integration: INTEG,
            template: TEMPLATE,
          });
          expect(started.status).toBe("redirect");
          if (started.status !== "redirect") return;
          const callback = yield* server.completeAuthorizationCodeFlow({
            authorizationUrl: started.authorizationUrl,
          });
          yield* executor.oauth.complete({
            state: started.state,
            code: callback.code,
          });
          yield* server.clearRequests;

          const result = yield* executor.connections.checkHealth({
            owner: "org",
            integration: INTEG,
            name: ConnectionName.make("main"),
          });

          expect(result).toMatchObject({
            status: "healthy",
            detail: "Credential resolved (no probe configured).",
          });
          expect(result.identity).toBeUndefined();
          const requests = yield* server.requests;
          expect(requests).toEqual([]);
        }),
      ),
  );

  it.effect("records missing authorization-code scopes without blocking the connection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({
          scopes: ["openid", "email", "profile", "offline_access", "read", "write"],
          omitTokenResponseScopes: ["email", "profile", "write"],
        });
        const { executor, config } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed([
          "openid",
          "email",
          "profile",
          "offline_access",
          "read",
          "write",
        ]);

        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
          resource: server.mcpResourceUrl,
        });

        const started = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
        });
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;
        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });
        const connection = yield* executor.oauth.complete({
          state: started.state,
          code: callback.code,
        });

        expect(connection.missingOAuthScopes).toEqual(["write"]);
        const row = yield* Effect.promise(() =>
          config.db.findFirst("connection", {
            where: (b) => b("name", "=", "main"),
          }),
        );
        expect(row?.provider_state).toEqual({ missingOAuthScopes: ["write"] });
        const listed = yield* executor.connections.list({ integration: INTEG });
        expect(listed[0]?.missingOAuthScopes).toEqual(["write"]);
      }),
    ),
  );

  it.effect(
    "does not persist missing scopes when the authorization-code grant covers requested scopes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* serveOAuthTestServer({ scopes: ["read", "write"] });
          const { executor, config } = yield* makeTestWorkspaceHarness({ plugins });
          yield* executor.acme.seed(["read", "write"]);

          yield* executor.oauth.createClient({
            owner: "org",
            slug: CLIENT,
            authorizationUrl: server.authorizationEndpoint,
            tokenUrl: server.tokenEndpoint,
            grant: "authorization_code",
            clientId: "test-client",
            clientSecret: "test-secret",
            resource: server.mcpResourceUrl,
          });

          const started = yield* executor.oauth.start({
            owner: "org",
            client: CLIENT,
            clientOwner: "org",
            name: ConnectionName.make("main"),
            integration: INTEG,
            template: TEMPLATE,
          });
          expect(started.status).toBe("redirect");
          if (started.status !== "redirect") return;
          const callback = yield* server.completeAuthorizationCodeFlow({
            authorizationUrl: started.authorizationUrl,
          });
          const connection = yield* executor.oauth.complete({
            state: started.state,
            code: callback.code,
          });

          expect(connection.missingOAuthScopes).toEqual([]);
          const row = yield* Effect.promise(() =>
            config.db.findFirst("connection", {
              where: (b) => b("name", "=", "main"),
            }),
          );
          expect(row?.provider_state).toBeNull();
        }),
      ),
  );
});

// Multi-site providers (Datadog) statically advertise one region's token
// endpoint but issue authorization codes redeemable only at the *regional* host
// the org lives on, signalled by the callback's non-standard `domain`/`site`
// param. The token endpoint host must rebind to that region for both the
// initial exchange and later refreshes — but only when the callback host is a
// trusted sibling subdomain, never an attacker-influenced arbitrary origin.
describe("oauth.complete regional token-endpoint rebind (Datadog multi-site)", () => {
  // Configured (statically advertised) host: the leftmost label differs from
  // the org's region, but they share the `datadoghq.test` parent.
  const ADVERTISED_TOKEN_URL = "https://app.datadoghq.test/token";

  it.effect(
    "redeems + refreshes at the callback's sibling-subdomain region, never the advertised host",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* serveOAuthTestServer({ scopes: ["read"] });
          const { executor, config } = yield* makeTestWorkspaceHarness({ plugins });
          yield* executor.acme.seed();

          // Reroute the https regional/advertised hosts back to the loopback test
          // AS so the real exchange/refresh path drives the rebind decision while
          // hitting a live server. Restored when the test scope closes.
          const tokenCalls: TokenEndpointCall[] = [];
          yield* Effect.acquireRelease(
            Effect.sync(() => routeTokenEndpointToLoopback(server, tokenCalls)),
            (restore) => Effect.sync(restore),
          );

          // Authorize on the loopback AS (passthrough), but advertise the US1-style
          // token host the way Datadog's AS metadata does.
          yield* executor.oauth.createClient({
            owner: "org",
            slug: CLIENT,
            authorizationUrl: server.authorizationEndpoint,
            tokenUrl: ADVERTISED_TOKEN_URL,
            grant: "authorization_code",
            clientId: "test-client",
            clientSecret: "test-secret",
            resource: server.mcpResourceUrl,
          });

          const started = yield* executor.oauth.start({
            owner: "org",
            client: CLIENT,
            clientOwner: "org",
            name: ConnectionName.make("main"),
            integration: INTEG,
            template: TEMPLATE,
          });
          expect(started.status).toBe("redirect");
          if (started.status !== "redirect") return;
          const callback = yield* server.completeAuthorizationCodeFlow({
            authorizationUrl: started.authorizationUrl,
          });

          // The callback carries the org's actual region as a sibling subdomain.
          yield* executor.oauth.complete({
            state: started.state,
            code: callback.code,
            callbackDomain: "us5.datadoghq.test",
          });

          // The code was redeemed at the regional host, not the advertised one.
          const exchangeCall = tokenCalls.find((c) => c.grantType === "authorization_code");
          expect(exchangeCall?.host).toBe("us5.datadoghq.test");

          // The regional token endpoint is persisted on the connection so later
          // refreshes target the same region (the AS metadata still says US1).
          const row = yield* Effect.promise(() =>
            config.db.findFirst("connection", { where: (b) => b("name", "=", "main") }),
          );
          expect(row?.oauth_token_url).toBe("https://us5.datadoghq.test/token");

          // Mint, then expire so the next resolve must refresh.
          const firstToken = (yield* executor.execute(
            ToolAddress.make("tools.acme.org.main.whoami"),
            {},
          )) as { token: string };
          expect(firstToken.token).toMatch(/^at_/);
          yield* Effect.promise(() =>
            config.db.updateMany("connection", {
              where: (b) => b("name", "=", "main"),
              set: { expires_at: Date.now() - 60_000 },
            }),
          );
          const refreshedToken = (yield* executor.execute(
            ToolAddress.make("tools.acme.org.main.whoami"),
            {},
          )) as { token: string };
          expect(refreshedToken.token).toMatch(/^at_/);
          expect(refreshedToken.token).not.toBe(firstToken.token);

          // The refresh hit the persisted region too …
          const refreshCall = tokenCalls.find((c) => c.grantType === "refresh_token");
          expect(refreshCall?.host).toBe("us5.datadoghq.test");
          // … and the statically advertised host was never contacted.
          expect(tokenCalls.some((c) => c.host === "app.datadoghq.test")).toBe(false);
        }),
      ),
  );

  it.effect("ignores a non-sibling callback domain — exchange stays on the advertised host", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const { executor, config } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();

        const tokenCalls: TokenEndpointCall[] = [];
        yield* Effect.acquireRelease(
          Effect.sync(() => routeTokenEndpointToLoopback(server, tokenCalls)),
          (restore) => Effect.sync(restore),
        );

        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: ADVERTISED_TOKEN_URL,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        });

        const started = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
        });
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;
        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });

        // An attacker-influenced callback host that is NOT a sibling subdomain of
        // the configured token host (`evil.example.test` vs `app.datadoghq.test`).
        // The token request carries the client secret + code + PKCE verifier, so
        // the rebind must refuse and fall back to the advertised host.
        yield* executor.oauth.complete({
          state: started.state,
          code: callback.code,
          callbackDomain: "evil.example.test",
        });

        const exchangeCall = tokenCalls.find((c) => c.grantType === "authorization_code");
        expect(exchangeCall?.host).toBe("app.datadoghq.test");
        expect(tokenCalls.some((c) => c.host === "evil.example.test")).toBe(false);

        // Nothing regional was persisted: refresh keeps using the configured host.
        const row = yield* Effect.promise(() =>
          config.db.findFirst("connection", { where: (b) => b("name", "=", "main") }),
        );
        expect(row?.oauth_token_url ?? null).toBeNull();
      }),
    ),
  );
});

describe("missingGrantedOAuthScopes canonicalization", () => {
  it("treats Microsoft fully-qualified granted scopes as covering short-form requests", () => {
    const missing = missingGrantedOAuthScopes(
      [
        "offline_access",
        "User.Read",
        "https://graph.microsoft.com/.default",
        "Mail.ReadWrite",
        "Mail.Send",
        "MailboxSettings.ReadWrite",
      ],
      [
        "https://graph.microsoft.com/Mail.ReadWrite",
        "https://graph.microsoft.com/Mail.Send",
        "https://graph.microsoft.com/MailboxSettings.ReadWrite",
        "https://graph.microsoft.com/User.Read",
      ].join(" "),
    );
    expect(missing).toEqual([]);
  });

  it("still reports genuinely ungranted scopes under the qualified Microsoft shape", () => {
    const missing = missingGrantedOAuthScopes(
      ["User.Read", "Mail.ReadWrite", "Mail.Send"],
      "https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.ReadWrite",
    );
    expect(missing).toEqual(["Mail.Send"]);
  });

  it("maps Google userinfo aliases and ignores identity meta-scopes", () => {
    const missing = missingGrantedOAuthScopes(
      ["openid", "email", "profile", "https://www.googleapis.com/auth/calendar"],
      [
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/calendar",
      ].join(" "),
    );
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reactive refresh: an upstream 401 re-mints the access token and retries once.
//
// `expires_at` is only ever the authorization server's ADVERTISED lifetime. The
// upstream rejecting the token is the authoritative word on whether it is still
// good, and the two diverge routinely: server-side revocation, an identity
// provider's idle-timeout policy shorter than the token lifetime, and the case
// these tests pin hardest — an AS that omits `expires_in` entirely, leaving a
// null expiry that the proactive check can never fire on.
// ---------------------------------------------------------------------------

/** A plugin whose tool authenticates for real: any token in `revoked` gets the
 *  same `connection_rejected` / HTTP 401 shape every protocol plugin emits;
 *  anything else succeeds. Modelling revocation (rather than "only the newest
 *  token works") is what lets a test assert that the RETRY succeeded — the
 *  re-minted token is simply one the upstream never revoked. */
const makeRejectingPlugin = (state: {
  revoked: Set<string>;
  /** Reject every token, even a freshly minted one — a dead grant. */
  rejectEverything?: boolean;
  calls: string[];
}) =>
  definePlugin(() => ({
    id: "acme" as const,
    storage: () => ({}),
    resolveTools: () =>
      Effect.succeed({ tools: [{ name: ToolName.make("whoami"), description: "whoami" }] }),
    describeAuthMethods: () => [
      {
        id: "oauth",
        label: "OAuth2",
        kind: "oauth" as const,
        template: String(TEMPLATE),
        oauth: { scopes: [] },
      },
    ],
    invokeTool: ({ credential }) => {
      const token = credential.value;
      state.calls.push(String(token));
      if (token !== null && !state.rejectEverything && !state.revoked.has(token)) {
        return Effect.succeed(ToolResult.ok({ token }));
      }
      return Effect.succeed(
        authToolFailure({
          code: "connection_rejected",
          status: 401,
          message: "Upstream rejected credentials with HTTP 401.",
          integration: { id: String(credential.integration) },
          credential: { kind: "upstream", label: String(credential.connection) },
        }),
      );
    },
    extension: (ctx) => ({
      seed: () => ctx.core.integrations.register({ slug: INTEG, description: "Acme", config: {} }),
    }),
  }))();

/** Mint a connection against `server` and return the harness + call log. */
const connectRejecting = (options?: { readonly tokenExpiresInSeconds?: number }) =>
  Effect.gen(function* () {
    const server = yield* serveOAuthTestServer({
      scopes: ["read"],
      ...(options?.tokenExpiresInSeconds !== undefined
        ? { tokenExpiresInSeconds: options.tokenExpiresInSeconds }
        : {}),
    });
    const state = {
      revoked: new Set<string>(),
      rejectEverything: false,
      calls: [] as string[],
    };
    const issuedLatest = Effect.gen(function* () {
      const issued = yield* server.issuedAccessTokens;
      return issued.length > 0 ? issued[issued.length - 1]! : null;
    });
    const harness = yield* makeTestWorkspaceHarness({
      plugins: [memoryCredentialsPlugin(), makeRejectingPlugin(state)] as const,
    });
    const { executor, config } = harness;
    yield* executor.acme.seed();
    yield* executor.oauth.createClient({
      owner: "org",
      slug: CLIENT,
      authorizationUrl: server.authorizationEndpoint,
      tokenUrl: server.tokenEndpoint,
      grant: "authorization_code",
      clientId: "test-client",
      clientSecret: "test-secret",
    });
    const started = yield* executor.oauth.start({
      owner: "org",
      client: CLIENT,
      clientOwner: "org",
      name: ConnectionName.make("mine"),
      integration: INTEG,
      template: TEMPLATE,
    });
    if (started.status !== "redirect") {
      return yield* Effect.die("expected a redirect-status OAuth start");
    }
    const callback = yield* server.completeAuthorizationCodeFlow({
      authorizationUrl: started.authorizationUrl,
    });
    yield* executor.oauth.complete({ state: started.state, code: callback.code });
    return { server, state, executor, config, issuedLatest };
  });

const ADDRESS = ToolAddress.make("tools.acme.org.mine.whoami");

/** Mark every token the AS has issued so far as no longer honoured upstream —
 *  the state a revocation or an idle-timeout policy leaves behind. */
const revokeIssuedSoFar = (
  server: { readonly issuedAccessTokens: Effect.Effect<readonly string[]> },
  state: { revoked: Set<string> },
) =>
  Effect.gen(function* () {
    for (const token of yield* server.issuedAccessTokens) state.revoked.add(token);
  });

const refreshGrants = (requests: readonly { readonly path: string; readonly body: string }[]) =>
  requests.filter((r) => r.path === "/token" && r.body.includes("grant_type=refresh_token"));

describe("reactive OAuth refresh on upstream 401", () => {
  it.effect(
    "re-mints and retries once when the upstream rejects a token it still believes valid",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { server, state, executor, issuedLatest } = yield* connectRejecting();

          // Simulate the divergence: the AS says the token is good for an hour,
          // but the upstream has already stopped honouring it (revoked / idle
          // timeout). Nothing about `expires_at` reflects this.
          yield* revokeIssuedSoFar(server, state);
          yield* server.clearRequests;

          const result = (yield* executor.execute(ADDRESS, {})) as {
            data: { token: string };
          };

          // The retry ran against a token the upstream would accept, so the call
          // succeeded rather than surfacing the 401 to the user.
          const latest = yield* issuedLatest;
          expect(result.data.token).toBe(latest);
          expect(state.calls).toHaveLength(2);
          expect(state.calls[0]).not.toBe(state.calls[1]);

          // Exactly one refresh grant — the retry is single-shot, not a loop.
          expect(refreshGrants(yield* server.requests)).toHaveLength(1);
        }),
      ),
  );

  it.effect("recovers a null-expiry connection, which the proactive check can never fire on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server, state, executor, config, issuedLatest } = yield* connectRejecting();

        // An AS that omits `expires_in` leaves expires_at null. `shouldRefreshToken`
        // returns false for null forever, so before the reactive path these
        // connections could never refresh at all — they died silently and only a
        // manual reconnect brought them back. 5 such rows existed in production.
        yield* Effect.promise(() =>
          config.db.updateMany("connection", {
            where: (b) => b("name", "=", "mine"),
            set: { expires_at: null },
          }),
        );
        yield* revokeIssuedSoFar(server, state);
        yield* server.clearRequests;

        const result = (yield* executor.execute(ADDRESS, {})) as {
          data: { token: string };
        };

        expect(result.data.token).toBe(yield* issuedLatest);
        expect(refreshGrants(yield* server.requests)).toHaveLength(1);
      }),
    ),
  );

  it.effect("persists the re-minted token so the next call needs no second refresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server, state, executor, issuedLatest } = yield* connectRejecting();
        yield* revokeIssuedSoFar(server, state);
        yield* executor.execute(ADDRESS, {});

        // The re-minted token is not revoked, so a second call must reuse the
        // stored value rather than refreshing again.
        const current = yield* issuedLatest;
        yield* server.clearRequests;

        const result = (yield* executor.execute(ADDRESS, {})) as {
          data: { token: string };
        };
        expect(result.data.token).toBe(current);
        expect(refreshGrants(yield* server.requests)).toHaveLength(0);
      }),
    ),
  );

  it.effect("surfaces the upstream's own 401 when the re-minted token is also rejected", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server, state, executor } = yield* connectRejecting();

        // The upstream rejects everything, including whatever the refresh mints
        // — a genuinely dead grant, not a stale token. The user must see the
        // upstream's auth failure and its reconnect guidance, NOT a masked
        // error or a retry loop.
        state.rejectEverything = true;
        yield* server.clearRequests;

        const result = yield* executor.execute(ADDRESS, {});

        expect(result).toMatchObject({
          ok: false,
          error: { code: "connection_rejected", status: 401 },
        });
        // Tried twice, refreshed once, then stopped.
        expect(state.calls).toHaveLength(2);
        expect(refreshGrants(yield* server.requests)).toHaveLength(1);
      }),
    ),
  );

  it.effect("does not retry a 403 — re-minting the same grant returns the same answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const calls: string[] = [];
        const forbiddenPlugin = definePlugin(() => ({
          id: "acme" as const,
          storage: () => ({}),
          resolveTools: () =>
            Effect.succeed({ tools: [{ name: ToolName.make("whoami"), description: "whoami" }] }),
          describeAuthMethods: () => [
            {
              id: "oauth",
              label: "OAuth2",
              kind: "oauth" as const,
              template: String(TEMPLATE),
              oauth: { scopes: [] },
            },
          ],
          invokeTool: ({ credential }) => {
            calls.push(String(credential.value));
            return Effect.succeed(
              authToolFailure({
                code: "connection_rejected",
                status: 403,
                message: "Upstream rejected credentials with HTTP 403.",
                integration: { id: String(credential.integration) },
                credential: { kind: "upstream", label: String(credential.connection) },
              }),
            );
          },
          extension: (ctx) => ({
            seed: () =>
              ctx.core.integrations.register({ slug: INTEG, description: "Acme", config: {} }),
          }),
        }))();

        const { executor } = yield* makeTestWorkspaceHarness({
          plugins: [memoryCredentialsPlugin(), forbiddenPlugin] as const,
        });
        yield* executor.acme.seed();
        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        });
        const started = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("mine"),
          integration: INTEG,
          template: TEMPLATE,
        });
        if (started.status !== "redirect") return;
        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });
        yield* executor.oauth.complete({ state: started.state, code: callback.code });
        yield* server.clearRequests;

        const result = yield* executor.execute(ADDRESS, {});

        // A 403 is authenticated-but-not-permitted. Retrying would burn a
        // refresh-token rotation per call and never converge.
        expect(result).toMatchObject({ ok: false, error: { status: 403 } });
        expect(calls).toHaveLength(1);
        expect(refreshGrants(yield* server.requests)).toHaveLength(0);
      }),
    ),
  );

  it.effect("does not retry when the connection holds no refresh token", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server, state, executor, config } = yield* connectRejecting();

        // Nothing to re-mint from: the only recovery is a human reconnect, so
        // the upstream's failure must reach the caller on the first try.
        yield* Effect.promise(() =>
          config.db.updateMany("connection", {
            where: (b) => b("name", "=", "mine"),
            set: { refresh_item_id: null },
          }),
        );
        yield* revokeIssuedSoFar(server, state);
        yield* server.clearRequests;

        const result = yield* executor.execute(ADDRESS, {});

        expect(result).toMatchObject({ ok: false, error: { status: 401 } });
        expect(state.calls).toHaveLength(1);
        expect(refreshGrants(yield* server.requests)).toHaveLength(0);
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// RFC 8707 resource omission for a resource-less client (#1789)
//
// A client persisted with NO resource sends no `resource` parameter on ANY
// request — authorize, code exchange, refresh, client-credentials. Microsoft
// Entra v2 rejects requests that carry `resource` next to a v2 `scope`
// (AADSTS9010010), and the way out is a client whose resource is absent; that
// absence must hold on every grant, or the token audience diverges between
// authorize and token. The mirror-image assertions — a client WITH a resource
// sends it on authorize + exchange + refresh — live in the tests above.
// ---------------------------------------------------------------------------
describe("resource-less client sends no resource parameter (#1789)", () => {
  it.effect("authorize, code exchange, and refresh all omit `resource`", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const { executor, config } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();

        // `resource: null` — explicitly none, not merely unset.
        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
          resource: null,
        });

        const started = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
        });
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;
        expect(new URL(started.authorizationUrl).searchParams.has("resource")).toBe(false);

        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });
        yield* executor.oauth.complete({ state: started.state, code: callback.code });

        // Force expiry so the next execute refreshes.
        yield* Effect.promise(() =>
          config.db.updateMany("connection", {
            where: (b) => b("name", "=", "main"),
            set: { expires_at: Date.now() - 60_000 },
          }),
        );
        const refreshed = (yield* executor.execute(
          ToolAddress.make("tools.acme.org.main.whoami"),
          {},
        )) as { token: string };
        expect(refreshed.token).toMatch(/^at_/);

        // What the authorization server actually SAW: the authorize request,
        // the code exchange, and the refresh each carried no `resource`.
        const requests = yield* server.requests;
        const authorize = requests.find((r) => r.path === "/authorize" && r.method === "GET");
        expect(authorize).toBeDefined();
        expect(authorize?.query.resource ?? null).toBeNull();
        const exchange = requests.find(
          (r) => r.path === "/token" && r.body.includes("grant_type=authorization_code"),
        );
        expect(exchange).toBeDefined();
        expect(exchange?.body ?? "").not.toContain("resource=");
        const refresh = requests.find(
          (r) => r.path === "/token" && r.body.includes("grant_type=refresh_token"),
        );
        expect(refresh).toBeDefined();
        expect(refresh?.body ?? "").not.toContain("resource=");
      }),
    ),
  );

  it.effect("client_credentials omits `resource` for a resource-less client", () =>
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
          grant: "client_credentials",
          clientId: "test-client",
          clientSecret: "test-secret",
          resource: null,
        });

        const started = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("cc"),
          integration: INTEG,
          template: TEMPLATE,
        });
        expect(started.status).toBe("connected");

        const requests = yield* server.requests;
        const grant = requests.find(
          (r) => r.path === "/token" && r.body.includes("grant_type=client_credentials"),
        );
        expect(grant).toBeDefined();
        expect(grant?.body ?? "").not.toContain("resource=");
      }),
    ),
  );

  it.effect("client_credentials sends `resource` when the client has one", () =>
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
          grant: "client_credentials",
          clientId: "test-client",
          clientSecret: "test-secret",
          resource: server.mcpResourceUrl,
        });

        const started = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("cc"),
          integration: INTEG,
          template: TEMPLATE,
        });
        expect(started.status).toBe("connected");

        const requests = yield* server.requests;
        const grant = requests.find(
          (r) => r.path === "/token" && r.body.includes("grant_type=client_credentials"),
        );
        expect(grant?.body).toContain(`resource=${encodeURIComponent(server.mcpResourceUrl)}`);
      }),
    ),
  );
});
