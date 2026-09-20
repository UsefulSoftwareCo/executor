import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import type * as Tracer from "effect/Tracer";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  OAuthState,
  Subject,
  Tenant,
  ToolAddress,
  ToolName,
} from "./ids";
import {
  firstPartyOAuthClientSlug,
  type FirstPartyOAuthClientConfig,
  type OAuthStartError,
} from "./oauth-client";
import { createExecutor } from "./executor";
import { decodeOAuthCallbackState } from "./oauth";
import { definePlugin } from "./plugin";
import { makeTestWorkspaceHarness, memoryCredentialsPlugin } from "./test-config";
import { scopesFromAuthorizeUrl, serveOAuthTestServer } from "./testing/oauth-test-server";

// First-party OAuth clients: host-operated apps declared in executor config
// (`firstPartyOAuthClients`), addressed as `first-party:<name>`. Resolved from
// config, never storage — these tests prove the whole lifecycle (start →
// complete → execute → refresh) runs off the config-declared identity, that the
// client CRUD surface rejects the reserved namespace, and that listings project
// the app without ever having written its secret to a credential provider.

const INTEG = IntegrationSlug.make("acme");
const TEMPLATE = AuthTemplateSlug.make("oauth");
const FIRST_PARTY = firstPartyOAuthClientSlug("acme");

const makeRecordingTracer = (spans: Map<string, Map<string, unknown>>): Tracer.Tracer => ({
  span: (options) => {
    const attributes = new Map<string, unknown>();
    spans.set(options.name, attributes);
    let status: Tracer.SpanStatus = { _tag: "Started", startTime: options.startTime };
    return {
      _tag: "Span",
      name: options.name,
      spanId: "0000000000000001",
      traceId: "00000000000000000000000000000001",
      parent: options.parent,
      annotations: options.annotations,
      get status() {
        return status;
      },
      attributes,
      links: options.links,
      sampled: options.sampled,
      kind: options.kind,
      end: (endTime, exit) => {
        status = { _tag: "Ended", startTime: options.startTime, endTime, exit };
      },
      attribute: (key, value) => {
        attributes.set(key, value);
      },
      event: () => undefined,
      addLinks: () => undefined,
    };
  },
});

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

const firstPartyClientFor = (server: {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
}): FirstPartyOAuthClientConfig => ({
  name: "acme",
  authorizationUrl: server.authorizationEndpoint,
  tokenUrl: server.tokenEndpoint,
  clientId: "test-client",
  clientSecret: "test-secret",
  integrations: [INTEG],
});

describe("first-party oauth clients", () => {
  it.effect(
    "start → complete through a config-declared client mints an executable connection",
    () => {
      const spans = new Map<string, Map<string, unknown>>();
      return Effect.scoped(
        Effect.gen(function* () {
          const server = yield* serveOAuthTestServer({ scopes: ["read"] });
          const { executor } = yield* makeTestWorkspaceHarness({
            plugins,
            firstPartyOAuthClients: [firstPartyClientFor(server)],
          });
          yield* executor.acme.seed();

          // No createClient call — the app exists purely in config.
          const started = yield* executor.oauth.start({
            owner: "org",
            client: FIRST_PARTY,
            clientOwner: "org",
            name: ConnectionName.make("main-account"),
            integration: INTEG,
            template: TEMPLATE,
          });
          expect(started.status).toBe("redirect");
          expect(
            spans.get("test.oauth.first_party")?.get("executor.oauth.client_first_party"),
          ).toBe(true);
          if (started.status !== "redirect") return;

          const callback = yield* server.completeAuthorizationCodeFlow({
            authorizationUrl: started.authorizationUrl,
          });
          const connection = yield* executor.oauth.complete({
            state: started.state,
            code: callback.code,
          });
          expect(String(connection.address)).toBe("tools.acme.org.mainAccount");
          expect(
            spans.get("executor.oauth.complete")?.get("executor.oauth.client_first_party"),
          ).toBe(true);

          const out = (yield* executor.execute(
            ToolAddress.make("tools.acme.org.mainAccount.whoami"),
            {},
          )) as { token: string };
          expect(out.token).toMatch(/^at_/);
          expect(yield* server.acceptsAccessToken(out.token)).toBe(true);
        }),
      ).pipe(
        Effect.withSpan("test.oauth.first_party"),
        Effect.withTracer(makeRecordingTracer(spans)),
      );
    },
  );

  it.effect("an authorization scope override supports scope-less provider app tokens", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["repo"] });
        const { executor } = yield* makeTestWorkspaceHarness({
          plugins,
          firstPartyOAuthClients: [{ ...firstPartyClientFor(server), authorizationScopes: [] }],
        });
        yield* executor.acme.seed(["repo"]);

        const started = yield* executor.oauth.start({
          owner: "org",
          client: FIRST_PARTY,
          clientOwner: "org",
          name: ConnectionName.make("github-app"),
          integration: INTEG,
          template: TEMPLATE,
        });
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;
        expect(scopesFromAuthorizeUrl(started.authorizationUrl)).toEqual([]);

        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });
        const connection = yield* executor.oauth.complete({
          state: started.state,
          code: callback.code,
        });
        expect(connection.oauthScope).toBeNull();
      }),
    ),
  );

  it.effect("applies first-party lifecycle scopes, separators, and authorize parameters", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read", "offline_access"] });
        const { executor } = yield* makeTestWorkspaceHarness({
          plugins,
          firstPartyOAuthClients: [
            {
              ...firstPartyClientFor(server),
              allowedScopes: ["read", "offline_access"],
              additionalAuthorizationScopes: ["offline_access"],
              authorizationScopeSeparator: ",",
              authorizationExtraParams: { audience: "api.example.com", prompt: "consent" },
            },
          ],
        });
        yield* executor.acme.seed(["read"]);

        const started = yield* executor.oauth.start({
          owner: "org",
          client: FIRST_PARTY,
          clientOwner: "org",
          name: ConnectionName.make("lifecycle"),
          integration: INTEG,
          template: TEMPLATE,
        });
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;
        const authorizationUrl = new URL(started.authorizationUrl);
        expect(authorizationUrl.searchParams.get("scope")).toBe("read,offline_access");
        expect(authorizationUrl.searchParams.get("audience")).toBe("api.example.com");
        expect(authorizationUrl.searchParams.get("prompt")).toBe("consent");
      }),
    ),
  );

  it.effect("refresh resolves the config-declared client (no oauth_client row exists)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const harness = yield* makeTestWorkspaceHarness({
          plugins,
          firstPartyOAuthClients: [firstPartyClientFor(server)],
        });
        const { executor, config } = harness;
        yield* executor.acme.seed();

        const started = yield* executor.oauth.start({
          owner: "org",
          client: FIRST_PARTY,
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
        });
        if (started.status !== "redirect") return;
        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });
        yield* executor.oauth.complete({ state: started.state, code: callback.code });

        const firstToken = (yield* executor.execute(
          ToolAddress.make("tools.acme.org.main.whoami"),
          {},
        )) as { token: string };

        // Force expiry so the next resolve refreshes through the config client.
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
        expect(refreshedToken.token).not.toBe(firstToken.token);
        expect(yield* server.acceptsAccessToken(refreshedToken.token)).toBe(true);
      }),
    ),
  );

  it.effect("listClients projects the first-party app ahead of stored rows, secretless", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const { executor } = yield* makeTestWorkspaceHarness({
          plugins,
          firstPartyOAuthClients: [
            {
              ...firstPartyClientFor(server),
              resource: server.resourceUrl,
              allowedScopes: ["openid", "read"],
            },
          ],
        });
        yield* executor.acme.seed();

        yield* executor.oauth.createClient({
          owner: "org",
          slug: OAuthClientSlug.make("byo-app"),
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "byo-client",
          clientSecret: "byo-secret",
        });

        const clients = yield* executor.oauth.listClients();
        expect(clients.map((c) => String(c.slug))).toEqual(["first-party:acme", "byo-app"]);
        const firstParty = clients[0]!;
        expect(firstParty.origin).toEqual({
          kind: "first_party",
          integrations: [INTEG],
          allowedScopes: ["openid", "read"],
        });
        expect(firstParty.clientId).toBe("test-client");
        expect(firstParty.resource).toBe(server.resourceUrl);
        expect("clientSecret" in firstParty).toBe(false);
      }),
    ),
  );

  it.effect("listing policies use the acting identity and re-evaluate within an executor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        let enabled = true;
        const { executor } = yield* makeTestWorkspaceHarness({
          plugins,
          subject: "review-user",
          tenant: "review-org",
          firstPartyOAuthClients: [
            {
              ...firstPartyClientFor(server),
              isListed: (context) =>
                Effect.sync(() => {
                  expect(context).toEqual({ userId: "review-user", organizationId: "review-org" });
                  return enabled;
                }),
            },
          ],
        });
        expect((yield* executor.oauth.listClients()).map((client) => String(client.slug))).toEqual([
          "first-party:acme",
        ]);
        enabled = false;
        expect(yield* executor.oauth.listClients()).toEqual([]);
        yield* executor.acme.seed();
        const started = yield* executor.oauth.start({
          owner: "org",
          client: FIRST_PARTY,
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
        });
        expect(started.status).toBe("redirect");
      }),
    ),
  );

  it.effect("an unlisted first-party app is withheld from listings but still refreshes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const harness = yield* makeTestWorkspaceHarness({
          plugins,
          firstPartyOAuthClients: [
            {
              ...firstPartyClientFor(server),
              unlisted: true,
              isListed: () => Effect.succeed(true),
            },
          ],
        });
        const { executor, config } = harness;
        yield* executor.acme.seed();

        yield* executor.oauth.createClient({
          owner: "org",
          slug: OAuthClientSlug.make("byo-app"),
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "byo-client",
          clientSecret: "byo-secret",
        });

        // Withheld from the surface that OFFERS an app for a new connection.
        const clients = yield* executor.oauth.listClients();
        expect(clients.map((c) => String(c.slug))).toEqual(["byo-app"]);

        // …yet the app itself is untouched: a connection resolves, mints, and
        // renews through it exactly as a listed one would.
        const started = yield* executor.oauth.start({
          owner: "org",
          client: FIRST_PARTY,
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

        const firstToken = (yield* executor.execute(
          ToolAddress.make("tools.acme.org.main.whoami"),
          {},
        )) as { token: string };

        // Force expiry so the next resolve must refresh through the config client.
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
        expect(refreshedToken.token).not.toBe(firstToken.token);
        expect(yield* server.acceptsAccessToken(refreshedToken.token)).toBe(true);
      }),
    ),
  );

  it.effect("a scope-limited first-party app rejects an integration outside its policy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read", "write"] });
        const { executor } = yield* makeTestWorkspaceHarness({
          plugins,
          firstPartyOAuthClients: [{ ...firstPartyClientFor(server), allowedScopes: ["read"] }],
        });
        yield* executor.acme.seed(["write"]);

        const error = yield* executor.oauth
          .start({
            owner: "org",
            client: FIRST_PARTY,
            clientOwner: "org",
            name: ConnectionName.make("blocked"),
            integration: INTEG,
            template: TEMPLATE,
          })
          .pipe(Effect.flip);

        expect(Predicate.isTagged("OAuthStartError")(error)).toBe(true);
        const startError = error as OAuthStartError;
        expect(startError.message).toContain("not enabled for integration acme");
      }),
    ),
  );

  it.effect("createClient and removeClient reject the reserved first-party namespace", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const { executor } = yield* makeTestWorkspaceHarness({
          plugins,
          firstPartyOAuthClients: [firstPartyClientFor(server)],
        });

        const createError = yield* executor.oauth
          .createClient({
            owner: "org",
            slug: FIRST_PARTY,
            authorizationUrl: server.authorizationEndpoint,
            tokenUrl: server.tokenEndpoint,
            grant: "authorization_code",
            clientId: "impostor",
            clientSecret: "impostor-secret",
          })
          .pipe(Effect.flip);
        expect(createError.message).toContain("reserved first-party namespace");

        const removeError = yield* executor.oauth
          .removeClient("org", FIRST_PARTY)
          .pipe(Effect.flip);
        expect(removeError.message).toContain("cannot be removed");
      }),
    ),
  );

  it.effect("start with an undeclared first-party slug fails as client-not-found", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* serveOAuthTestServer({ scopes: ["read"] });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();

        const error = yield* executor.oauth
          .start({
            owner: "org",
            client: firstPartyOAuthClientSlug("nope"),
            clientOwner: "org",
            name: ConnectionName.make("main"),
            integration: INTEG,
            template: TEMPLATE,
          })
          .pipe(Effect.flip);
        // `OAuthStartError` carries a typed `message`; the `Predicate.isTagged`
        // guard narrows the union so this read is on a typed failure.
        expect(Predicate.isTagged("OAuthStartError")(error)).toBe(true);
        const startError = error as OAuthStartError;
        expect(startError.message).toContain("not found");
      }),
    ),
  );

  it.effect("a Personal connection can mint through a first-party app", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const { executor } = yield* makeTestWorkspaceHarness({
          plugins,
          firstPartyOAuthClients: [firstPartyClientFor(server)],
        });
        yield* executor.acme.seed();

        const started = yield* executor.oauth.start({
          owner: "user",
          client: FIRST_PARTY,
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
        expect(String(connection.address)).toBe("tools.acme.user.mine");
      }),
    ),
  );
});

describe("first-party authorization setup", () => {
  const setup = {
    title: "Connect GitHub",
    description: "Choose repositories before authorizing your account.",
    actionLabel: "Install GitHub App",
    actionUrl: "https://github.com/apps/example/installations/new",
  };
  const firstParty: FirstPartyOAuthClientConfig = {
    name: "acme",
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    clientId: "test-client",
    clientSecret: "test-secret",
    authorizationScopes: [],
    authorizationSetup: setup,
  };
  const startInput = {
    owner: "user" as const,
    client: FIRST_PARTY,
    clientOwner: "org" as const,
    name: ConnectionName.make("setup"),
    integration: INTEG,
    template: TEMPLATE,
  };

  it.effect(
    "keeps PKCE, organization routing and custom callbacks through setup and reconnect",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { executor } = yield* makeTestWorkspaceHarness({
            plugins,
            firstPartyOAuthClients: [firstParty],
            redirectUri: "https://executor.example/api/oauth/callback",
            oauthCallbackStateOrgSlug: "example-org",
          });
          yield* executor.acme.seed(["repo"]);
          // The default (no newConnection flag) is also the reconnect path.
          const started = yield* executor.oauth.start({
            ...startInput,
            redirectUri: "https://client.example/custom-callback",
          });
          expect(started.status).toBe("redirect");
          if (started.status !== "redirect") return;
          const setupUrl = new URL(started.authorizationUrl);
          expect(setupUrl.origin + setupUrl.pathname).toBe(
            "https://executor.example/api/oauth/setup",
          );
          expect(decodeOAuthCallbackState(setupUrl.searchParams.get("state"))).toEqual({
            state: started.state,
            orgSlug: "example-org",
          });
          const resolved = yield* executor.oauth.getSetup(started.state);
          expect(resolved.setup).toEqual(setup);
          const provider = new URL(resolved.authorizationUrl);
          expect(provider.origin + provider.pathname).toBe(firstParty.authorizationUrl);
          expect(provider.searchParams.get("client_id")).toBe("test-client");
          expect(provider.searchParams.get("redirect_uri")).toBe(
            "https://client.example/custom-callback",
          );
          expect(provider.searchParams.get("state")).toBe(setupUrl.searchParams.get("state"));
          expect(provider.searchParams.get("code_challenge_method")).toBe("S256");
          expect(provider.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
          expect(provider.searchParams.has("scope")).toBe(false);
          expect(JSON.stringify(resolved)).not.toContain("test-secret");
          // Reading guidance does not consume the authorization session.
          expect(yield* executor.oauth.getSetup(started.state)).toEqual(resolved);
          yield* executor.oauth.cancel(started.state);
          expect(
            Predicate.isTagged(
              yield* executor.oauth.getSetup(started.state).pipe(Effect.flip),
              "OAuthSessionNotFoundError",
            ),
          ).toBe(true);
        }),
      ),
  );

  it.effect(
    "does not disclose another user's or tenant's continuation and rejects expired sessions",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { executor, config } = yield* makeTestWorkspaceHarness({
            plugins,
            firstPartyOAuthClients: [firstParty],
          });
          yield* executor.acme.seed();
          const started = yield* executor.oauth.start(startInput);
          if (started.status !== "redirect") return yield* Effect.die("expected redirect");
          for (const scope of [
            { subject: Subject.make("another-user") },
            { tenant: Tenant.make("another-tenant") },
          ]) {
            const other = yield* createExecutor({ ...config, ...scope });
            yield* Effect.addFinalizer(() => other.close().pipe(Effect.ignore));
            expect(
              Predicate.isTagged(
                yield* other.oauth.getSetup(started.state).pipe(Effect.flip),
                "OAuthSessionNotFoundError",
              ),
            ).toBe(true);
          }
          expect(
            Predicate.isTagged(
              yield* executor.oauth.getSetup(OAuthState.make("unknown")).pipe(Effect.flip),
              "OAuthSessionNotFoundError",
            ),
          ).toBe(true);
          yield* Effect.promise(() =>
            config.db.updateMany("oauth_session", {
              where: (b) => b("state", "=", String(started.state)),
              set: { expires_at: Date.now() - 1 },
            }),
          );
          expect(
            Predicate.isTagged(
              yield* executor.oauth.getSetup(started.state).pipe(Effect.flip),
              "OAuthSessionNotFoundError",
            ),
          ).toBe(true);
        }),
      ),
  );

  it.effect("requires a host callback to serve setup even with a caller-provided callback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor } = yield* makeTestWorkspaceHarness({
          plugins,
          firstPartyOAuthClients: [firstParty],
          redirectUri: null,
        });
        yield* executor.acme.seed();
        const error = yield* executor.oauth
          .start({ ...startInput, redirectUri: "https://client.example/callback" })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(error, "OAuthStartError")).toBe(true);
      }),
    ),
  );
});
