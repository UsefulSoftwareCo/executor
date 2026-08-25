// ---------------------------------------------------------------------------
// The enterprise-managed credential lifecycle, driven through the executor's
// own surfaces: connect mints a connection with no browser step, and the token
// renewal that follows re-runs the ID-JAG chain without a user.
//
// The ID-JAG's own expiry has no tier here on purpose: the client never stores
// one (see `mintEnterpriseManagedAccessToken`), so "the assertion expired" can
// only be observed at the protocol boundary, where `oauth-ema.test.ts` covers
// it against a Resource Authorization Server that enforces `exp`.
// ---------------------------------------------------------------------------

import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ToolAddress,
  ToolName,
} from "./ids";
import type { OAuthService } from "./oauth-client";
import { definePlugin } from "./plugin";
import { makeTestWorkspaceHarness, memoryCredentialsPlugin } from "./test-config";
import { serveOAuthTestServer, type OAuthTestServerShape } from "./testing/oauth-test-server";

const INTEG = IntegrationSlug.make("acme");
const TEMPLATE = AuthTemplateSlug.make("oauth");
const IDP_CLIENT = OAuthClientSlug.make("enterprise-idp");
const RESOURCE_CLIENT = OAuthClientSlug.make("mcp-server-app");
const CONNECTION = ConnectionName.make("work");
const TOOL = ToolAddress.make("tools.acme.org.work.whoami");

const CLIENT_AT_IDP = "client-at-idp";
const CLIENT_AT_RESOURCE = "client-at-resource";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token" as const;

const oauthPlugin = definePlugin(() => ({
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
      // A declared scope, so the assertions below follow one concrete scope
      // through the exchange, the assertion, the redemption, and the stored row.
      oauth: { scopes: ["mcp.read"] },
    },
  ],
  invokeTool: ({ credential }) => Effect.succeed({ token: credential.value }),
  extension: (ctx) => ({
    seed: () => ctx.core.integrations.register({ slug: INTEG, description: "Acme", config: {} }),
  }),
}))();

const plugins = [memoryCredentialsPlugin(), oauthPlugin] as const;

interface EnterpriseServers {
  readonly idp: OAuthTestServerShape;
  readonly resource: OAuthTestServerShape;
  readonly subjectToken: string;
}

const enterpriseServers = (options: {
  readonly denyExchangeWith?: { readonly error: string; readonly errorDescription: string };
  readonly advertiseProfile?: boolean;
  /** Short-lived access tokens put every resolve inside the refresh skew, which
   *  is how the renewal path is exercised without waiting an hour. */
  readonly resourceTokenExpiresInSeconds?: number;
}) =>
  Effect.gen(function* () {
    const idp = yield* serveOAuthTestServer({
      clients: { [CLIENT_AT_IDP]: null },
      scopes: ["mcp.read"],
      enterpriseIdp: {
        resourceClientIds: { [CLIENT_AT_IDP]: CLIENT_AT_RESOURCE },
        ...(options.denyExchangeWith ? { denyExchangeWith: options.denyExchangeWith } : {}),
      },
    });
    const resource = yield* serveOAuthTestServer({
      clients: { [CLIENT_AT_RESOURCE]: null },
      scopes: ["mcp.read"],
      ...(options.resourceTokenExpiresInSeconds === undefined
        ? {}
        : { tokenExpiresInSeconds: options.resourceTokenExpiresInSeconds }),
      ...(options.advertiseProfile === false
        ? {}
        : { enterpriseResourceServer: { trustedIdpIssuer: idp.issuerUrl } }),
    });
    const session = yield* idp.completeAuthorizationCodeTokenFlow({
      clientId: CLIENT_AT_IDP,
      clientSecret: "",
      scopes: ["mcp.read"],
    });
    return { idp, resource, subjectToken: session.accessToken } satisfies EnterpriseServers;
  });

/** Register the two client identities the profile needs: one at the enterprise
 *  IdP (authenticates the token exchange) and one at the MCP server's
 *  authorization server (authenticates the redemption, and is the client the
 *  ID-JAG's `client_id` claim names). */
const registerClients = (createClient: OAuthService["createClient"], servers: EnterpriseServers) =>
  Effect.gen(function* () {
    yield* createClient({
      owner: "org",
      slug: IDP_CLIENT,
      authorizationUrl: servers.idp.authorizationEndpoint,
      tokenUrl: servers.idp.tokenEndpoint,
      grant: "authorization_code",
      clientId: CLIENT_AT_IDP,
      clientSecret: "",
    });
    yield* createClient({
      owner: "org",
      slug: RESOURCE_CLIENT,
      authorizationUrl: servers.resource.authorizationEndpoint,
      tokenUrl: servers.resource.tokenEndpoint,
      grant: "id_jag",
      clientId: CLIENT_AT_RESOURCE,
      clientSecret: "",
      resource: servers.resource.mcpResourceUrl,
    });
  });

const startEnterpriseConnect = (servers: EnterpriseServers) =>
  ({
    owner: "org",
    client: RESOURCE_CLIENT,
    clientOwner: "org",
    name: CONNECTION,
    integration: INTEG,
    template: TEMPLATE,
    enterprise: {
      idpClient: IDP_CLIENT,
      idpClientOwner: "org",
      subjectToken: servers.subjectToken,
      subjectTokenType: ACCESS_TOKEN_TYPE,
    },
  }) as const;

const tokenExchangeCount = (servers: EnterpriseServers) =>
  servers.idp.requests.pipe(
    Effect.map(
      (entries) =>
        entries.filter((entry) => entry.path === "/token" && entry.body.includes("token-exchange"))
          .length,
    ),
  );

describe("enterprise-managed connections", () => {
  it.effect("connect mints a usable MCP credential with no browser step", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const servers = yield* enterpriseServers({});
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();
        yield* registerClients(executor.oauth.createClient, servers);

        const started = yield* executor.oauth.start(startEnterpriseConnect(servers));
        assert(
          started.status === "connected",
          "the identity assertion replaces per-server consent, so there is nothing to redirect to",
        );
        expect(started.connection.oauthScope).toBe("mcp.read");

        const invoked = (yield* executor.execute(TOOL, {})) as { readonly token: string };
        expect(
          yield* servers.resource.acceptsAccessToken(invoked.token),
          "the tool runs with a token the MCP server's authorization server issued",
        ).toBe(true);
        expect(yield* tokenExchangeCount(servers)).toBe(1);
      }),
    ),
  );

  it.effect("renews an expiring access token by re-running the chain, with no user", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const servers = yield* enterpriseServers({ resourceTokenExpiresInSeconds: 1 });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();
        yield* registerClients(executor.oauth.createClient, servers);
        yield* executor.oauth.start(startEnterpriseConnect(servers));

        const first = (yield* executor.execute(TOOL, {})) as { readonly token: string };
        const second = (yield* executor.execute(TOOL, {})) as { readonly token: string };

        expect(second.token, "the expiring token was replaced").not.toBe(first.token);
        expect(
          yield* servers.resource.acceptsAccessToken(second.token),
          "the replacement came from the resource authorization server",
        ).toBe(true);
        expect(
          yield* tokenExchangeCount(servers),
          "every renewal returns to the IdP, so enterprise policy is re-evaluated each time",
        ).toBeGreaterThan(1);
      }),
    ),
  );

  it.effect("marks the connection expired when the stored identity assertion dies", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const servers = yield* enterpriseServers({ resourceTokenExpiresInSeconds: 1 });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();
        yield* registerClients(executor.oauth.createClient, servers);
        yield* executor.oauth.start(startEnterpriseConnect(servers));

        yield* servers.idp.revokeAccessToken(servers.subjectToken);
        const failure = yield* executor.execute(TOOL, {}).pipe(Effect.flip);
        assert(
          Predicate.isTagged(failure, "CredentialResolutionError"),
          "a dead assertion is a credential verdict, not an execution fault",
        );
        expect(
          failure.reauthRequired,
          "only a fresh single sign-on can replace a revoked assertion",
        ).toBe(true);
        expect(
          failure.blockedByAdmin,
          "the assertion died; the administrator did not withdraw access",
        ).toBeUndefined();

        const connections = yield* executor.connections.list();
        const connection = connections.find((entry) => String(entry.name) === String(CONNECTION));
        expect(
          connection?.lastHealth?.status,
          "a dead assertion is recorded so the accounts list shows it without a probe",
        ).toBe("expired");
      }),
    ),
  );

  it.effect("reports a policy withdrawn after connect as blocked-by-admin, not as re-auth", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const servers = yield* enterpriseServers({ resourceTokenExpiresInSeconds: 1 });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();
        yield* registerClients(executor.oauth.createClient, servers);
        yield* executor.oauth.start(startEnterpriseConnect(servers));
        yield* executor.execute(TOOL, {});

        // The administrator revokes access AFTER the connection exists. Renewal
        // meets the denial where no user is present, which is the only place
        // `blockedByAdmin` is ever produced on a credential failure.
        yield* servers.idp.setTokenExchangeDenial({
          error: "access_denied",
          errorDescription: "This user is no longer approved for the requested MCP server.",
        });

        const failure = yield* executor.execute(TOOL, {}).pipe(Effect.flip);
        assert(
          Predicate.isTagged(failure, "CredentialResolutionError"),
          "an administrator decision is a credential verdict, not a transport failure that retries",
        );
        expect(
          failure.blockedByAdmin,
          "signing in again cannot help, and the interactive per-server flow must not be offered as a way around the policy",
        ).toBe(true);
        expect(failure.oauthErrorCode, "the IdP's own §5.2 code travels structurally").toBe(
          "access_denied",
        );

        const connections = yield* executor.connections.list();
        const connection = connections.find((entry) => String(entry.name) === String(CONNECTION));
        expect(
          connection?.lastHealth?.status,
          "the accounts list shows the blocked connection without another probe",
        ).toBe("expired");
      }),
    ),
  );

  it.effect("refuses to fall back to interactive OAuth when the IdP denies the exchange", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const servers = yield* enterpriseServers({
          denyExchangeWith: {
            error: "unauthorized_client",
            errorDescription: "This client is not approved for the requested MCP server.",
          },
        });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();
        yield* registerClients(executor.oauth.createClient, servers);

        const failure = yield* executor.oauth
          .start(startEnterpriseConnect(servers))
          .pipe(Effect.flip);

        assert(Predicate.isTagged(failure, "OAuthStartError"));
        expect(
          failure.blockedByAdmin,
          "the console must be able to branch on blocked-by-admin without reading prose: it decides whether the interactive flow may be offered as an alternative",
        ).toBe(true);
        expect(
          failure.oauthErrorCode,
          "the IdP's own verdict travels as a code, so support can trace the decision",
        ).toBe("unauthorized_client");
        expect(
          (yield* executor.connections.list()).length,
          "a denied connect leaves no half-made connection behind",
        ).toBe(0);
      }),
    ),
  );

  it.effect("falls back to the interactive flow when the server lacks the grant profile", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const servers = yield* enterpriseServers({ advertiseProfile: false });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();
        yield* registerClients(executor.oauth.createClient, servers);

        const started = yield* executor.oauth.start(startEnterpriseConnect(servers));

        expect(
          started.status,
          "a server that never implemented the profile still gets ordinary per-server consent",
        ).toBe("redirect");
        expect(
          yield* tokenExchangeCount(servers),
          "no identity assertion is spent on a server that cannot accept one",
        ).toBe(0);
      }),
    ),
  );
});
