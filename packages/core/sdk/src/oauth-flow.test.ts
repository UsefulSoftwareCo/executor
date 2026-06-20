import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  OAuthState,
  ToolAddress,
  ToolName,
} from "./ids";
import { OAuthStartError } from "./oauth-client";
import { definePlugin } from "./plugin";
import { makeTestWorkspaceHarness, memoryCredentialsPlugin } from "./test-config";
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
});
