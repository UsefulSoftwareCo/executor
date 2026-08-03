import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ToolAddress,
  ToolName,
} from "./ids";
import {
  firstPartyOAuthClientSlug,
  type FirstPartyOAuthClientConfig,
  type OAuthStartError,
} from "./oauth-client";
import { definePlugin } from "./plugin";
import { makeTestWorkspaceHarness, memoryCredentialsPlugin } from "./test-config";
import { serveOAuthTestServer } from "./testing/oauth-test-server";

// First-party OAuth clients: host-operated apps declared in executor config
// (`firstPartyOAuthClients`), addressed as `first-party:<name>`. Resolved from
// config, never storage — these tests prove the whole lifecycle (start →
// complete → execute → refresh) runs off the config-declared identity, that the
// client CRUD surface rejects the reserved namespace, and that listings project
// the app without ever having written its secret to a credential provider.

const INTEG = IntegrationSlug.make("acme");
const TEMPLATE = AuthTemplateSlug.make("oauth");
const FIRST_PARTY = firstPartyOAuthClientSlug("acme");

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
    () =>
      Effect.scoped(
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
          if (started.status !== "redirect") return;

          const callback = yield* server.completeAuthorizationCodeFlow({
            authorizationUrl: started.authorizationUrl,
          });
          const connection = yield* executor.oauth.complete({
            state: started.state,
            code: callback.code,
          });
          expect(String(connection.address)).toBe("tools.acme.org.mainAccount");

          const out = (yield* executor.execute(
            ToolAddress.make("tools.acme.org.mainAccount.whoami"),
            {},
          )) as { token: string };
          expect(out.token).toMatch(/^at_/);
          expect(yield* server.acceptsAccessToken(out.token)).toBe(true);
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
          firstPartyOAuthClients: [firstPartyClientFor(server)],
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
        expect(firstParty.origin).toEqual({ kind: "first_party", integrations: [INTEG] });
        expect(firstParty.clientId).toBe("test-client");
        expect("clientSecret" in firstParty).toBe(false);
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
