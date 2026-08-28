// ---------------------------------------------------------------------------
// The enterprise-managed rollout gate, driven through the executor's own OAuth
// surface against a real ID-JAG-speaking IdP and Resource Authorization Server.
//
// Three properties here are security properties rather than behavior checks,
// and each has a test whose failure would be a real hole:
//
//   - a withheld verdict takes the SAME exit as a server that never implemented
//     the profile, and spends no identity assertion getting there;
//   - the gate is consulted EXACTLY ONCE per connect and NEVER after the IdP has
//     ruled, so a policy denial can never be re-routed through a flag check;
//   - the gate is a connect-time decision only, so an existing enterprise-managed
//     connection keeps renewing no matter what the flag says afterwards.
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
import type {
  EnterpriseManagedRollout,
  EnterpriseManagedRolloutContext,
  EnterpriseManagedRolloutDecision,
  EnterpriseManagedRolloutEvent,
} from "./oauth-ema";
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

const TENANT = "org_rollout";
const SUBJECT = "user_rollout";

const ENABLED: EnterpriseManagedRolloutDecision = { kind: "enabled" };
const DISABLED: EnterpriseManagedRolloutDecision = {
  kind: "withheld",
  reason: "disabled",
};
const UNAVAILABLE: EnterpriseManagedRolloutDecision = {
  kind: "withheld",
  reason: "evaluation-unavailable",
};

// ---------------------------------------------------------------------------
// A gate that answers from a script and remembers every question.
//
// It is injected through the SAME production seam a host uses
// (`ExecutorConfig.enterpriseManagedRollout`) — no module mock, no spy on a
// private helper — so what these tests observe is what a real host would see.
// ---------------------------------------------------------------------------

interface ScriptedRollout {
  readonly rollout: EnterpriseManagedRollout;
  /** One entry per consultation, in order. */
  readonly consultations: () => readonly EnterpriseManagedRolloutContext[];
  readonly events: () => readonly EnterpriseManagedRolloutEvent[];
}

const scriptedRollout = (options: {
  /** Verdict for the nth consultation; the last entry repeats forever. */
  readonly answers: readonly EnterpriseManagedRolloutDecision[];
  /** Make `record` blow up, to prove observation cannot reach the caller. */
  readonly recordDies?: boolean;
}): ScriptedRollout => {
  const consultations: EnterpriseManagedRolloutContext[] = [];
  const events: EnterpriseManagedRolloutEvent[] = [];
  return {
    consultations: () => consultations,
    events: () => events,
    rollout: {
      decide: (context) =>
        Effect.sync(() => {
          consultations.push(context);
          const index = Math.min(consultations.length - 1, options.answers.length - 1);
          return options.answers[index] ?? ENABLED;
        }),
      record: (event) =>
        options.recordDies
          ? Effect.die("the flag service exploded")
          : Effect.sync(() => {
              events.push(event);
            }),
    },
  };
};

const eventKinds = (spy: ScriptedRollout): readonly string[] =>
  spy.events().map((event) => event.kind);

// ---------------------------------------------------------------------------
// Fixture: an integration whose only auth method is the enterprise-managed
// OAuth client, plus the two client registrations the profile needs.
// ---------------------------------------------------------------------------

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
      oauth: { scopes: ["mcp.read"] },
    },
  ],
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

interface EnterpriseServers {
  readonly idp: OAuthTestServerShape;
  readonly resource: OAuthTestServerShape;
  readonly subjectToken: string;
}

const enterpriseServers = (options: {
  readonly denyExchangeWith?: {
    readonly error: string;
    readonly errorDescription: string;
  };
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
      enterpriseResourceServer: { trustedIdpIssuer: idp.issuerUrl },
    });
    const session = yield* idp.completeAuthorizationCodeTokenFlow({
      clientId: CLIENT_AT_IDP,
      clientSecret: "",
      scopes: ["mcp.read"],
    });
    return {
      idp,
      resource,
      subjectToken: session.accessToken,
    } satisfies EnterpriseServers;
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

/** How many RFC 8693 token exchanges the IdP has served. The identity assertion
 *  is spent here, so this is the measure of "did the client actually try". */
const tokenExchangeCount = (servers: EnterpriseServers) =>
  servers.idp.requests.pipe(
    Effect.map(
      (entries) =>
        entries.filter((entry) => entry.path === "/token" && entry.body.includes("token-exchange"))
          .length,
    ),
  );

const harness = (rollout: EnterpriseManagedRollout | undefined) =>
  makeTestWorkspaceHarness({
    plugins,
    tenant: TENANT,
    subject: SUBJECT,
    enterpriseManagedRollout: rollout,
  });

describe("enterprise-managed rollout gate", () => {
  it.effect("attempts the enterprise-managed path when the gate allows it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const servers = yield* enterpriseServers({});
        const spy = scriptedRollout({ answers: [ENABLED] });
        const { executor } = yield* harness(spy.rollout);
        yield* executor.acme.seed();
        yield* registerClients(executor.oauth.createClient, servers);

        const started = yield* executor.oauth.start(startEnterpriseConnect(servers));

        assert(started.status === "connected");
        expect(
          spy.consultations().length,
          "one connect asks the gate once — never per request, never per step",
        ).toBe(1);
        expect(spy.consultations()[0], "the gate is handed the identity it rolls out by").toEqual({
          userId: SUBJECT,
          organizationId: TENANT,
          integration: INTEG,
        });
        expect(eventKinds(spy)).toEqual(["attempted", "connected"]);
      }),
    ),
  );

  it.effect("falls back to the interactive flow when the gate withholds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const servers = yield* enterpriseServers({});
        const spy = scriptedRollout({ answers: [DISABLED] });
        const { executor } = yield* harness(spy.rollout);
        yield* executor.acme.seed();
        yield* registerClients(executor.oauth.createClient, servers);

        const started = yield* executor.oauth.start(startEnterpriseConnect(servers));

        expect(
          started.status,
          "a user outside the rollout gets exactly what a user connecting to a server without the profile gets",
        ).toBe("redirect");
        expect(
          yield* tokenExchangeCount(servers),
          "the gate runs before discovery, so a withheld connect spends no identity assertion and makes no request",
        ).toBe(0);
        expect(spy.events()[0]?.decision).toEqual(DISABLED);
      }),
    ),
  );

  it.effect("fails closed to the interactive flow when the gate cannot reach a verdict", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const servers = yield* enterpriseServers({});
        const spy = scriptedRollout({ answers: [UNAVAILABLE] });
        const { executor } = yield* harness(spy.rollout);
        yield* executor.acme.seed();
        yield* registerClients(executor.oauth.createClient, servers);

        const started = yield* executor.oauth.start(startEnterpriseConnect(servers));

        expect(
          started.status,
          "an unreachable flag service degrades the rollout; it must never fail the connect",
        ).toBe("redirect");
        expect(yield* tokenExchangeCount(servers)).toBe(0);
        expect(
          spy.events()[0]?.decision,
          "the reason travels, so an outage is distinguishable from a deliberate 'not yet'",
        ).toEqual(UNAVAILABLE);
      }),
    ),
  );

  it.effect("attempts the enterprise-managed path when no host injected a gate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const servers = yield* enterpriseServers({});
        const { executor } = yield* harness(undefined);
        yield* executor.acme.seed();
        yield* registerClients(executor.oauth.createClient, servers);

        const started = yield* executor.oauth.start(startEnterpriseConnect(servers));

        expect(
          started.status,
          "desktop, CLI, local and self-host have no flag service, and their behavior must not change because cloud grew one",
        ).toBe("connected");
      }),
    ),
  );

  it.effect("never consults the gate again after the identity provider has denied", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const servers = yield* enterpriseServers({
          denyExchangeWith: {
            error: "unauthorized_client",
            errorDescription: "This client is not approved for the requested MCP server.",
          },
        });
        // The gate allows the attempt, then flips to every withheld verdict
        // there is. If ANY code path re-read the flag after the denial, one of
        // those answers would route this connect into the interactive flow —
        // which is precisely the escape hatch around enterprise policy the
        // profile exists to prevent.
        const spy = scriptedRollout({
          answers: [ENABLED, DISABLED, UNAVAILABLE],
        });
        const { executor } = yield* harness(spy.rollout);
        yield* executor.acme.seed();
        yield* registerClients(executor.oauth.createClient, servers);

        const failure = yield* executor.oauth
          .start(startEnterpriseConnect(servers))
          .pipe(Effect.flip);

        assert(Predicate.isTagged(failure, "OAuthStartError"));
        expect(
          failure.blockedByAdmin,
          "the administrator's decision stands, and the flag is not a way around it",
        ).toBe(true);
        expect(failure.oauthErrorCode).toBe("unauthorized_client");
        expect(
          spy.consultations().length,
          "the gate is asked once, before discovery, and never again",
        ).toBe(1);
        expect(
          (yield* executor.connections.list()).length,
          "a denied connect leaves no connection behind for the flag to rescue",
        ).toBe(0);
        expect(eventKinds(spy)).toEqual(["attempted", "blocked-by-admin"]);
        const blocked = spy.events()[1];
        assert(blocked?.kind === "blocked-by-admin");
        expect(blocked.oauthErrorCode, "the IdP's own code is what makes the event useful").toBe(
          "unauthorized_client",
        );
      }),
    ),
  );

  it.effect("never re-evaluates the gate when renewing an existing connection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const servers = yield* enterpriseServers({
          resourceTokenExpiresInSeconds: 1,
        });
        // Allowed for the connect, withheld from then on: the rollout is dialled
        // back after this connection already exists.
        const spy = scriptedRollout({ answers: [ENABLED, DISABLED] });
        const { executor } = yield* harness(spy.rollout);
        yield* executor.acme.seed();
        yield* registerClients(executor.oauth.createClient, servers);
        yield* executor.oauth.start(startEnterpriseConnect(servers));
        const consultationsAtConnect = spy.consultations().length;

        // Short-lived access tokens put the second execute inside the refresh
        // skew, so this drives the real credential-renewal path.
        const first = (yield* executor.execute(TOOL, {})) as {
          readonly token: string;
        };
        const second = (yield* executor.execute(TOOL, {})) as {
          readonly token: string;
        };

        expect(second.token, "the expiring token was replaced").not.toBe(first.token);
        expect(
          yield* servers.resource.acceptsAccessToken(second.token),
          "turning the flag off must not strand or silently downgrade a live managed connection",
        ).toBe(true);
        expect(
          spy.consultations().length,
          "credential resolution never asks the flag service anything — it follows the state persisted on the connection",
        ).toBe(consultationsAtConnect);
      }),
    ),
  );

  it.effect("keeps every credential out of the rollout events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const servers = yield* enterpriseServers({});
        const spy = scriptedRollout({ answers: [ENABLED] });
        const { executor } = yield* harness(spy.rollout);
        yield* executor.acme.seed();
        yield* registerClients(executor.oauth.createClient, servers);

        const started = yield* executor.oauth.start(startEnterpriseConnect(servers));
        assert(started.status === "connected");

        const minted = (yield* executor.execute(TOOL, {})) as {
          readonly token: string;
        };
        const recorded = JSON.stringify(spy.events());

        expect(
          recorded,
          "the identity assertion is the credential this whole profile turns on; it must never reach an analytics sink",
        ).not.toContain(servers.subjectToken);
        expect(recorded, "nor may the access token it was exchanged for").not.toContain(
          minted.token,
        );
      }),
    ),
  );

  it.effect("cannot be failed by a rollout observer that throws", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const servers = yield* enterpriseServers({});
        const spy = scriptedRollout({ answers: [ENABLED], recordDies: true });
        const { executor } = yield* harness(spy.rollout);
        yield* executor.acme.seed();
        yield* registerClients(executor.oauth.createClient, servers);

        const started = yield* executor.oauth.start(startEnterpriseConnect(servers));

        expect(
          started.status,
          "analytics is an observer; a broken one can never cost a user their connection",
        ).toBe("connected");
      }),
    ),
  );
});
