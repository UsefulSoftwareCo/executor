// ---------------------------------------------------------------------------
// Work identity — acquiring, holding and losing the enterprise assertion that
// enterprise-managed authorization consumes.
//
// `oauth-ema-lifecycle.test.ts` covers the caller-supplied-assertion world: the
// connect request carries the assertion, the connection keeps a private copy,
// and when that copy dies the CONNECTION is dead. This file covers the world the
// console lives in, where the product acquires the assertion itself, and where
// the two claims that follow from that are the whole point:
//
//   1. custody is the IdP REFRESH token (draft §4.5), so renewal outlives the
//      ID token that would otherwise kill every managed connection within the
//      hour, and
//   2. the identity is SHARED by every connection made from it, so its death is
//      one fact with one remedy — re-link once — rather than N dead connections
//      needing N reconnects.
//
// Both are asserted through the executor's own surfaces and the identity
// provider's request ledger, never by reading private state.
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
const SECOND_CONNECTION = ConnectionName.make("work2");
const TOOL = ToolAddress.make("tools.acme.org.work.whoami");
const SECOND_TOOL = ToolAddress.make("tools.acme.org.work2.whoami");

const CLIENT_AT_IDP = "client-at-idp";
const CLIENT_AT_RESOURCE = "client-at-resource";
const REFRESH_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:refresh_token" as const;
const ID_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id_token" as const;

/** The enterprise account the IdP fixture signs the user in as. `exp` is far
 *  enough out that nothing here depends on wall-clock drift; the point of the
 *  ID-token custody tier is the RECORDED deadline, not reaching it. */
const ID_TOKEN_EXP_SECONDS = Math.floor(Date.now() / 1000) + 3600;
const ACCOUNT_CLAIMS = {
  sub: "00u-enterprise-1",
  email: "alice@enterprise.test",
  exp: ID_TOKEN_EXP_SECONDS,
} as const;

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
      oauth: { scopes: ["mcp.read"] },
    },
  ],
  invokeTool: ({ credential }) => Effect.succeed({ token: credential.value }),
  extension: (ctx) => ({
    seed: () => ctx.core.integrations.register({ slug: INTEG, description: "Acme", config: {} }),
  }),
}))();

/** A workspace with its OWN credential store. The store must not be shared: a
 *  work identity is filed under an id derived only from (owner, IdP app), so a
 *  store shared across tests would let one test's held identity be resolved by
 *  the next — which is exactly the sharing the feature relies on in production
 *  and exactly the wrong thing between test cases. */
const workspace = () =>
  makeTestWorkspaceHarness({ plugins: [memoryCredentialsPlugin(), oauthPlugin] as const });

interface EnterpriseServers {
  readonly idp: OAuthTestServerShape;
  readonly resource: OAuthTestServerShape;
}

const enterpriseServers = (
  options: {
    /** Stand in for an identity provider that hands back no refresh token, which
     *  forces the link onto ID-token custody. */
    readonly issueRefreshToken?: boolean;
    readonly resourceTokenExpiresInSeconds?: number;
  } = {},
) =>
  Effect.gen(function* () {
    const idp = yield* serveOAuthTestServer({
      clients: { [CLIENT_AT_IDP]: null },
      scopes: ["mcp.read"],
      idTokenClaims: ACCOUNT_CLAIMS,
      ...(options.issueRefreshToken === undefined
        ? {}
        : { issueRefreshToken: options.issueRefreshToken }),
      enterpriseIdp: { resourceClientIds: { [CLIENT_AT_IDP]: CLIENT_AT_RESOURCE } },
    });
    const resource = yield* serveOAuthTestServer({
      clients: { [CLIENT_AT_RESOURCE]: null },
      scopes: ["mcp.read"],
      ...(options.resourceTokenExpiresInSeconds === undefined
        ? {}
        : { tokenExpiresInSeconds: options.resourceTokenExpiresInSeconds }),
      enterpriseResourceServer: { trustedIdpIssuer: idp.issuerUrl },
    });
    return { idp, resource } satisfies EnterpriseServers;
  });

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

const WORK_IDENTITY = {
  owner: "org",
  idpClient: IDP_CLIENT,
  idpClientOwner: "org",
} as const;

/** Drive the whole link the way a browser does: ask for the authorization URL,
 *  sign in at the identity provider, hand the code back. No private state is
 *  touched — everything below observes the result through `workIdentityStatus`
 *  and through what the identity provider was later asked. */
const linkWorkIdentity = (oauth: OAuthService, servers: EnterpriseServers) =>
  Effect.gen(function* () {
    const started = yield* oauth.startWorkIdentityLink(WORK_IDENTITY);
    const callback = yield* servers.idp.completeAuthorizationCodeFlow({
      authorizationUrl: started.authorizationUrl,
    });
    return yield* oauth.completeWorkIdentityLink({
      state: started.state,
      code: callback.code,
    });
  });

/** A connect that names the identity provider but carries NO assertion — the
 *  console's request. Everything about which subject is presented, and who owns
 *  it, is resolved server-side. */
const connectWithHeldIdentity = (name: ConnectionName = CONNECTION) =>
  ({
    owner: "org",
    client: RESOURCE_CLIENT,
    clientOwner: "org",
    name,
    integration: INTEG,
    template: TEMPLATE,
    enterprise: { idpClient: IDP_CLIENT, idpClientOwner: "org" },
  }) as const;

const tokenExchanges = (servers: EnterpriseServers) =>
  servers.idp.requests.pipe(
    Effect.map((entries) =>
      entries
        .filter((entry) => entry.path === "/token" && entry.body.includes("token-exchange"))
        .map((entry) => new URLSearchParams(entry.body)),
    ),
  );

const healthOf = (
  connections: readonly { readonly name: ConnectionName; readonly lastHealth?: unknown }[],
  name: ConnectionName,
) => connections.find((entry) => String(entry.name) === String(name))?.lastHealth;

describe("work identity — linking", () => {
  it.effect("takes custody of the identity provider's refresh token, not its ID token", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const servers = yield* enterpriseServers();
        const { executor } = yield* workspace();
        yield* executor.acme.seed();
        yield* registerClients(executor.oauth.createClient, servers);

        expect(
          (yield* executor.oauth.workIdentityStatus(WORK_IDENTITY)).status,
          "nothing is held before the user links",
        ).toBe("unlinked");

        const linked = yield* linkWorkIdentity(executor.oauth, servers);

        assert(linked.status === "linked");
        expect(
          linked.subjectTokenType,
          "draft §4.5: the durable subject is the refresh token — an ID token in custody would strand every managed connection at its first expiry",
        ).toBe(REFRESH_TOKEN_TYPE);
        expect(
          linked.expiresAt,
          "a refresh token has no client-visible expiry, and claiming one would be a deadline we invented",
        ).toBeNull();
        expect(linked.subject, "the account is named from the ID token's claims").toBe(
          ACCOUNT_CLAIMS.sub,
        );
        expect(linked.label).toBe(ACCOUNT_CLAIMS.email);
        expect(linked.idpClient).toBe(IDP_CLIENT);
      }),
    ),
  );

  it.effect("requests openid and offline_access so both of those facts are obtainable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const servers = yield* enterpriseServers();
        const { executor } = yield* workspace();
        yield* executor.acme.seed();
        yield* registerClients(executor.oauth.createClient, servers);

        const started = yield* executor.oauth.startWorkIdentityLink(WORK_IDENTITY);

        const scope = new URL(started.authorizationUrl).searchParams.get("scope");
        expect(
          scope?.split(" ").sort(),
          "`openid` is where the account claims come from and `offline_access` is where the refresh token comes from; dropping either quietly costs the link its identity or its durability",
        ).toEqual(["offline_access", "openid"]);
        expect(
          new URL(started.authorizationUrl).searchParams.get("code_challenge_method"),
          "the link runs the same PKCE authorization-code flow as every other browser flow here",
        ).toBe("S256");
      }),
    ),
  );

  it.effect(
    "records ID-token custody, with its deadline, when the IdP issues no refresh token",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const servers = yield* enterpriseServers({ issueRefreshToken: false });
          const { executor } = yield* workspace();
          yield* executor.acme.seed();
          yield* registerClients(executor.oauth.createClient, servers);

          const linked = yield* linkWorkIdentity(executor.oauth, servers);

          assert(linked.status === "linked");
          expect(
            linked.subjectTokenType,
            "custody of an ID token is a real degradation, so it is recorded as a different kind of custody rather than passed off as the durable one",
          ).toBe(ID_TOKEN_TYPE);
          expect(
            linked.expiresAt,
            "and it carries the deadline the product needs to warn before renewal starts failing",
          ).toBe(ID_TOKEN_EXP_SECONDS * 1000);
        }),
      ),
  );

  it.effect("forgets a linked identity on unlink", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const servers = yield* enterpriseServers();
        const { executor } = yield* workspace();
        yield* executor.acme.seed();
        yield* registerClients(executor.oauth.createClient, servers);
        yield* linkWorkIdentity(executor.oauth, servers);

        yield* executor.oauth.unlinkWorkIdentity(WORK_IDENTITY);
        expect((yield* executor.oauth.workIdentityStatus(WORK_IDENTITY)).status).toBe("unlinked");

        yield* executor.oauth.unlinkWorkIdentity(WORK_IDENTITY);
        expect(
          (yield* executor.oauth.workIdentityStatus(WORK_IDENTITY)).status,
          "unlinking twice is the same outcome as unlinking once",
        ).toBe("unlinked");
      }),
    ),
  );

  it.effect("refuses to link through an app registered for another grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const servers = yield* enterpriseServers();
        const { executor } = yield* workspace();
        yield* executor.acme.seed();
        yield* registerClients(executor.oauth.createClient, servers);

        const failure = yield* executor.oauth
          .startWorkIdentityLink({ ...WORK_IDENTITY, idpClient: RESOURCE_CLIENT })
          .pipe(Effect.flip);

        assert(Predicate.isTagged(failure, "WorkIdentityLinkError"));
        expect(
          failure.message,
          "the id_jag app is the MCP server's registration; running an authorization-code flow through it would fail at the provider with an opaque error page",
        ).toContain("id_jag");
      }),
    ),
  );

  it.effect("will not let a link's state be completed as a connection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const servers = yield* enterpriseServers();
        const { executor } = yield* workspace();
        yield* executor.acme.seed();
        yield* registerClients(executor.oauth.createClient, servers);

        const started = yield* executor.oauth.startWorkIdentityLink(WORK_IDENTITY);
        const callback = yield* servers.idp.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });

        const failure = yield* executor.oauth
          .complete({ state: started.state, code: callback.code })
          .pipe(Effect.flip);

        assert(
          Predicate.isTagged(failure, "OAuthCompleteError"),
          "a link session carries sentinel integration/name/template columns; minting a connection out of them would produce a connection named after a placeholder",
        );
        expect(failure.restartRequired).toBe(true);
        expect(
          (yield* executor.connections.list()).length,
          "and nothing was minted on the way to refusing",
        ).toBe(0);
      }),
    ),
  );

  it.effect("routes a shared callback to the flow its session belongs to", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const servers = yield* enterpriseServers();
        const { executor } = yield* workspace();
        yield* executor.acme.seed();
        yield* registerClients(executor.oauth.createClient, servers);

        const started = yield* executor.oauth.startWorkIdentityLink(WORK_IDENTITY);
        const callback = yield* servers.idp.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });

        const completion = yield* executor.oauth.completeCallback({
          state: started.state,
          code: callback.code,
        });

        assert(
          completion.kind === "work-identity",
          "both browser flows share one redirect URI, so the in-flight session — not the URL — is what says which one came back",
        );
        expect(completion.workIdentity.status).toBe("linked");
      }),
    ),
  );
});

describe("work identity — enterprise-managed connect", () => {
  it.effect("connects with no assertion on the request, presenting the held refresh token", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const servers = yield* enterpriseServers();
        const { executor } = yield* workspace();
        yield* executor.acme.seed();
        yield* registerClients(executor.oauth.createClient, servers);
        yield* linkWorkIdentity(executor.oauth, servers);

        const started = yield* executor.oauth.start(connectWithHeldIdentity());

        assert(
          started.status === "connected",
          "a linked user connects an enterprise-managed server with neither an assertion in hand nor a consent screen",
        );
        const exchanges = yield* tokenExchanges(servers);
        expect(exchanges.length).toBe(1);
        expect(
          exchanges[0]?.get("subject_token_type"),
          "the exchange presents the durable subject the link took custody of",
        ).toBe(REFRESH_TOKEN_TYPE);

        const invoked = (yield* executor.execute(TOOL, {})) as { readonly token: string };
        expect(
          yield* servers.resource.acceptsAccessToken(invoked.token),
          "and the tool call rides the token the chain minted",
        ).toBe(true);
      }),
    ),
  );

  it.effect("tells an unlinked user to link, rather than failing as a credential problem", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const servers = yield* enterpriseServers();
        const { executor } = yield* workspace();
        yield* executor.acme.seed();
        yield* registerClients(executor.oauth.createClient, servers);

        const failure = yield* executor.oauth.start(connectWithHeldIdentity()).pipe(Effect.flip);

        assert(Predicate.isTagged(failure, "OAuthStartError"));
        expect(
          failure.workIdentityLinkRequired,
          "a console decides from this field whether to offer the LINK; it cannot decide that from a sentence, and retrying or offering per-server consent are both the wrong move",
        ).toBe(true);
        expect(
          failure.blockedByAdmin,
          "nothing was asked of the identity provider, so no administrator refused anything",
        ).toBeUndefined();
        expect(
          (yield* tokenExchanges(servers)).length,
          "and no assertion was spent finding that out",
        ).toBe(0);
      }),
    ),
  );

  it.effect("leaves the explicit-assertion path exactly as it was", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const servers = yield* enterpriseServers();
        const { executor } = yield* workspace();
        yield* executor.acme.seed();
        yield* registerClients(executor.oauth.createClient, servers);

        // A headless caller holding its own assertion, with NOTHING linked.
        const session = yield* servers.idp.completeAuthorizationCodeTokenFlow({
          clientId: CLIENT_AT_IDP,
          clientSecret: "",
          scopes: ["mcp.read"],
        });
        const started = yield* executor.oauth.start({
          ...connectWithHeldIdentity(),
          enterprise: {
            idpClient: IDP_CLIENT,
            idpClientOwner: "org",
            subjectToken: session.accessToken,
            subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
          },
        });

        assert(started.status === "connected");
        const exchanges = yield* tokenExchanges(servers);
        expect(
          exchanges[0]?.get("subject_token_type"),
          "what the caller passed is what is presented — resolution never overrides an explicit assertion",
        ).toBe("urn:ietf:params:oauth:token-type:access_token");
        expect(
          (yield* executor.oauth.workIdentityStatus(WORK_IDENTITY)).status,
          "and a caller-supplied assertion is the caller's, so it never becomes the user's held identity",
        ).toBe("unlinked");
      }),
    ),
  );
});

describe("work identity — rollout gate composability", () => {
  it.effect("gates the connect exactly once and does not gate the link at all", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const servers = yield* enterpriseServers();
        const consultations: string[] = [];
        const { executor } = yield* makeTestWorkspaceHarness({
          plugins: [memoryCredentialsPlugin(), oauthPlugin] as const,
          enterpriseManagedRollout: {
            decide: (context) =>
              Effect.sync(() => {
                consultations.push(String(context.integration));
                return { kind: "enabled" } as const;
              }),
            record: () => Effect.void,
          },
        });
        yield* executor.acme.seed();
        yield* registerClients(executor.oauth.createClient, servers);

        yield* linkWorkIdentity(executor.oauth, servers);
        expect(
          consultations,
          "linking an identity reaches no MCP server and spends no assertion, so gating it would be a second consultation buying nothing — and would make the rollout flag able to block a harmless, reusable action",
        ).toEqual([]);

        yield* executor.oauth.start(connectWithHeldIdentity());
        expect(
          consultations,
          "the connect is still gated, still exactly once, and still before anything leaves the process",
        ).toEqual([String(INTEG)]);

        yield* executor.execute(TOOL, {});
        expect(
          consultations,
          "and resolving credentials never re-consults it, so the flag can never strand a live connection",
        ).toEqual([String(INTEG)]);
      }),
    ),
  );
});

describe("work identity — lifecycle", () => {
  it.effect("renews after the ID token that started the link would have died", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const servers = yield* enterpriseServers({ resourceTokenExpiresInSeconds: 1 });
        const { executor } = yield* workspace();
        yield* executor.acme.seed();
        yield* registerClients(executor.oauth.createClient, servers);
        yield* linkWorkIdentity(executor.oauth, servers);
        yield* executor.oauth.start(connectWithHeldIdentity());

        // Kill everything the SSO issued that expires: the access token, and
        // with it the ID token minted beside it. Under the old design — an ID
        // token in custody — this is precisely the state a connection reaches
        // an hour after it was made, and every renewal from here fails.
        for (const token of yield* servers.idp.issuedAccessTokens) {
          yield* servers.idp.revokeAccessToken(token);
        }

        const first = (yield* executor.execute(TOOL, {})) as { readonly token: string };
        const second = (yield* executor.execute(TOOL, {})) as { readonly token: string };

        expect(second.token, "the expiring access token was replaced").not.toBe(first.token);
        expect(
          yield* servers.resource.acceptsAccessToken(second.token),
          "renewal still reaches the identity provider and still comes back with a usable token, because custody is the refresh token",
        ).toBe(true);
        const exchanges = yield* tokenExchanges(servers);
        expect(
          exchanges.length,
          "every renewal returns to the IdP, so enterprise policy is re-evaluated each time",
        ).toBeGreaterThan(1);
        expect(
          exchanges.every((params) => params.get("subject_token_type") === REFRESH_TOKEN_TYPE),
          "and every one of them presents the durable subject",
        ).toBe(true);
      }),
    ),
  );

  it.effect("turns a rejected identity into ONE re-link that revives every connection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const servers = yield* enterpriseServers({ resourceTokenExpiresInSeconds: 1 });
        const { executor } = yield* workspace();
        yield* executor.acme.seed();
        yield* registerClients(executor.oauth.createClient, servers);
        const linked = yield* linkWorkIdentity(executor.oauth, servers);
        assert(linked.status === "linked");
        yield* executor.oauth.start(connectWithHeldIdentity());
        yield* executor.oauth.start(connectWithHeldIdentity(SECOND_CONNECTION));
        yield* executor.execute(TOOL, {});
        yield* executor.execute(SECOND_TOOL, {});

        // The enterprise ends the user's sessions. Both connections renew from
        // the SAME held identity, so both meet it.
        expect(
          yield* servers.idp.revokeRefreshTokensFor(CLIENT_AT_IDP),
          "one link means one durable subject at the identity provider, however many connections were made from it",
        ).toBe(1);

        const failure = yield* executor.execute(TOOL, {}).pipe(Effect.flip);
        assert(
          Predicate.isTagged(failure, "CredentialResolutionError"),
          "a dead identity is a credential verdict, not an execution fault",
        );
        expect(
          failure.workIdentityRelinkRequired,
          "the remedy is a re-link, and a console that reads only `reauthRequired` would send the user to reconnect N connections instead",
        ).toBe(true);
        expect(failure.reauthRequired, "it is still definitive — no retry recovers it").toBe(true);
        expect(
          failure.blockedByAdmin,
          "the subject died; the administrator withdrew nothing",
        ).toBeUndefined();

        const status = yield* executor.oauth.workIdentityStatus(WORK_IDENTITY);
        assert(
          status.status === "needs_relink",
          "the rejection is recorded on the IDENTITY — one fact, not one per connection",
        );
        expect(status.revokedReason).toBe("rejected");
        expect(
          status.label,
          "and the account it names survives, so the user knows what to re-link",
        ).toBe(ACCOUNT_CLAIMS.email);

        const secondFailure = yield* executor.execute(SECOND_TOOL, {}).pipe(Effect.flip);
        assert(Predicate.isTagged(secondFailure, "CredentialResolutionError"));
        expect(
          secondFailure.workIdentityRelinkRequired,
          "the second connection reports the same one remedy",
        ).toBe(true);

        const stalled = yield* executor.connections.list();
        expect(
          healthOf(stalled, CONNECTION),
          "both connections show the problem without waiting for a probe",
        ).toMatchObject({ status: "expired" });
        expect(healthOf(stalled, SECOND_CONNECTION)).toMatchObject({ status: "expired" });

        // ONE re-link. No reconnect, no `oauth.start`, nothing touching either
        // connection — which is the claim: a dead work identity must not have
        // stamped a reauth verdict onto connections that never lost anything.
        const relinked = yield* linkWorkIdentity(executor.oauth, servers);
        expect(relinked.status).toBe("linked");

        const revivedFirst = (yield* executor.execute(TOOL, {})) as { readonly token: string };
        const revivedSecond = (yield* executor.execute(SECOND_TOOL, {})) as {
          readonly token: string;
        };
        expect(
          yield* servers.resource.acceptsAccessToken(revivedFirst.token),
          "the first connection renews again after the single re-link",
        ).toBe(true);
        expect(
          yield* servers.resource.acceptsAccessToken(revivedSecond.token),
          "and so does the second — which is the whole difference between a dead identity and N dead connections",
        ).toBe(true);
      }),
    ),
  );
});
