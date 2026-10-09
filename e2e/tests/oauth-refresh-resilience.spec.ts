/** Renewal failures are classified from the token endpoint's real wire responses. */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { createProfile, selectProfileAccounts } from "../support/profiles.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const AppProvider = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});
const SetupStatus = Schema.Struct({ status: Schema.String });
const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const Echo = Schema.Struct({
  refreshed: Schema.Boolean,
  authorization: Schema.NullOr(Schema.String),
});
const Read = Schema.Record(Schema.String, Echo);
/** The access token issued at sign-in (0) or by the issuer's nth refresh request. */
const presented = (generation: number) => ({
  refreshed: generation > 0,
  authorization:
    generation === 0
      ? "Bearer synthetic-access-token"
      : `Bearer synthetic-refreshed-token-${generation}`,
});
type TokenError = Exclude<
  Parameters<Effect.Success<typeof oauthSetupIssuer>["configure"]>[0]["tokenError"],
  null | undefined
>;
const privateError = { error_description: "PRIVATE_PROVIDER_ERROR" };
/**
 * How the token endpoint answers a refresh: an outage (503), rate limit (429), an OAuth
 * `server_error` or `temporarily_unavailable` error body with HTTP 400, a dropped
 * connection, a 200 without an access token, a refused client, another refusal, or a revoked
 * grant (`invalid_grant`).
 */
const refreshFailures = {
  unavailable: { status: 503, body: {} },
  rate_limited: { status: 429, body: {}, retryAfter: "30" },
  server_error: { status: 400, body: { error: "server_error", ...privateError } },
  temporarily_unavailable: {
    status: 400,
    body: { error: "temporarily_unavailable", ...privateError },
  },
  connection_reset: "reset",
  malformed: { status: 200, body: { token_type: "Bearer", expires_in: 20 } },
  // RFC 6749 §5.2 client authentication failures, with and without an error body.
  invalid_client: { status: 400, body: { error: "invalid_client", ...privateError } },
  invalid_client_challenge: {
    status: 401,
    body: { error: "invalid_client", ...privateError },
    challenge: 'Basic realm="token"',
  },
  client_challenge: { status: 401, body: {}, challenge: 'Basic realm="token"' },
  unauthorized_client: { status: 400, body: { error: "unauthorized_client", ...privateError } },
  invalid_request: { status: 400, body: { error: "invalid_request", ...privateError } },
  invalid_scope: { status: 400, body: { error: "invalid_scope", ...privateError } },
  // Slack's token endpoint answers HTTP 200 with its own error codes, such as internal_error.
  slack_internal_error: {
    status: 200,
    body: { ok: false, error: "internal_error", ...privateError },
  },
  invalid_grant: { status: 400, body: { error: "invalid_grant", ...privateError } },
} satisfies Record<string, TokenError>;
type RefreshFailure = keyof typeof refreshFailures;
/** Seconds a token lasts when a scenario needs it to expire before the next call. */
const shortLifetime = 1;
/** Longer than `shortLifetime`, measured from after the token was saved. */
const pastShortLifetime = "1200 millis";
const Failure = Schema.Struct({
  _tag: Schema.String,
  account: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  cause: Schema.optional(
    Schema.Struct({
      stage: Schema.String,
      status: Schema.optional(Schema.Number),
      providerError: Schema.optional(Schema.String),
    }),
  ),
  retryAfter: Schema.optional(Schema.String),
});

/** One synthetic issuer, a deployed app that reads its token, and helpers to connect accounts. */
const renewalFixture = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    evidence = yield* Evidence,
    telemetry = yield* Telemetry,
    http = yield* HttpClient.HttpClient;
  const issuer = yield* oauthSetupIssuer;
  const prefix = `/api/organizations/${actors.organization.id}`;
  // Tokens issued inside the host's 30-second renewal window renew on the next use.
  yield* issuer.configure({ refreshTokens: true, expiresIn: 20 });
  const name = `Renewal ${randomUUID().slice(0, 8)}`;
  /**
   * Deploy an app whose query presents each listed slot's token to the issuer's resource, and
   * whose mutation posts the first slot's token. A refused token is reported as an
   * authentication failure of the account that presented it, as provider helpers do.
   */
  const deploy = (appName: string, slots: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const reads = slots
        .map((slot) => `${slot}: await call(fetch, accounts.${slot}, "GET")`)
        .join(", ");
      const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
        name: appName,
        files: [
          {
            path: "index.ts",
            content: `import { defineApp, defineProvider, oauth2, query, mutation, object, router, ProviderError } from "apps";
const service = defineProvider({ name: ${JSON.stringify(appName)}, auth: { oauth: oauth2({ discover: ${JSON.stringify(`${issuer.origin}/mcp`)} }) } });
async function call(fetch, account, method) {
  const response = await fetch(${JSON.stringify(`${issuer.origin}/resource`)}, { method, headers: { authorization: "Bearer " + account.fields.access_token } });
  if (response.status === 401) throw new ProviderError({ reason: "unauthorized", status: 401, accountId: account.id });
  return await response.json();
}
export default defineApp({ accounts: { ${slots.map((slot) => `${slot}: service`).join(", ")} } }, async ({ accounts }) => ({
  tools: router({
    read: query({ input: object({}) }, async ({ fetch }) => ({ ${reads} })),
    write: mutation({ input: object({}) }, async ({ fetch }) => ({ ${slots[0]}: await call(fetch, accounts.${slots[0]}, "POST") })),
  }),
}));`,
          },
          appsManifest,
        ],
      });
      expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
      const app = yield* body(AppProvider, deployed);
      yield* Effect.addFinalizer(() =>
        api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
      );
      return app;
    });
  const app = yield* deploy(name, ["service"]);
  const provider = app.requirements.accounts.service.provider;

  /** Wait until background profile setup, which resolves the profile's accounts, is done. */
  const settled = (appId: string, profile: string) =>
    api.request(actors.owner, "GET", `${prefix}/apps/${appId}/profiles/${profile}`).pipe(
      Effect.flatMap((response) => body(SetupStatus, response)),
      Effect.flatMap((current) =>
        current.status !== "pending"
          ? Effect.void
          : Effect.fail(new Error("Profile setup has not finished")),
      ),
      Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
    );

  const connect = (label: string, appId = app.id) =>
    Effect.gen(function* () {
      const profile = yield* createProfile(actors.owner, `${prefix}/apps/${appId}`);
      const connection = yield* body(
        Resource,
        yield* api.request(actors.owner, "POST", `${prefix}/apps/${appId}/connections`, {
          requirement: "service",
          profile: profile.id,
        }),
      );
      const started = yield* api.request(
        actors.owner,
        "POST",
        `${prefix}/connections/${connection.id}/oauth/start`,
        { method: "oauth", label },
      );
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      const { authorizationUrl } = yield* body(SignIn, started);
      const callbackUrl = yield* Effect.scoped(
        Effect.gen(function* () {
          const consent = yield* HttpClient.withScope(http).get(authorizationUrl);
          expect(consent.status).toBe(302);
          const location = consent.headers.location;
          if (location === undefined) return yield* Effect.die("Issuer did not return a callback");
          return location;
        }),
      ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
      const completed = yield* api.request(
        actors.owner,
        "POST",
        `${prefix}/connections/${connection.id}/oauth/complete`,
        { callbackUrl },
      );
      expect(completed.status, JSON.stringify(completed.body)).toBe(200);
      const account = yield* body(Resource, completed);
      yield* Effect.addFinalizer(() =>
        api.request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`).pipe(Effect.orDie),
      );
      // Profile setup resolves the new account in the background. Let it finish so each
      // renewal below belongs to the call that the scenario makes.
      yield* settled(appId, profile.id);
      return { profile: profile.id, account: account.id };
    });
  const read = (profile: string) =>
    api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/tools/call`, {
      profile,
      tool: "read",
      kind: "query",
      input: {},
    });
  const expectRead = (profile: string, generation: number) =>
    Effect.gen(function* () {
      const response = yield* read(profile);
      expect(
        response.status,
        `${JSON.stringify(response.body)}, checks=${JSON.stringify((yield* issuer.metrics).refreshChecks)}`,
      ).toBe(200);
      expect(yield* body(Read, response)).toEqual({ service: presented(generation) });
    });
  const refreshes = issuer.metrics.pipe(Effect.map((metrics) => metrics.refreshes));
  const assertPrivate = (value: unknown) => {
    const json = JSON.stringify(value);
    for (const marker of [
      "PRIVATE_PROVIDER_ERROR",
      "synthetic-refresh-",
      "synthetic-client-secret",
      "synthetic-access-token",
    ])
      expect(json).not.toContain(marker);
  };
  const spans = Effect.gen(function* () {
    const id = (yield* evidence.requests).at(-1)?.traceId;
    if (id === undefined) return yield* Effect.die("Missing request trace");
    return yield* telemetry.query(id).pipe(
      Effect.flatMap((result) =>
        result.data.some(({ span }) => span.operationName === "oauth.resolve")
          ? Effect.succeed(result)
          : Effect.fail(new Error("Request trace has not arrived")),
      ),
      Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }),
    );
  });

  return {
    api,
    actors,
    issuer,
    prefix,
    name,
    deploy,
    app,
    provider,
    settled,
    connect,
    read,
    expectRead,
    refreshes,
    assertPrivate,
    spans,
    evidence,
  };
});

layer(HostedLive, { excludeTestServices: true })("OAuth refresh resilience", (it) => {
  it.effect(scenarios.oauthRefreshResilience.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const {
          api,
          actors,
          issuer,
          prefix,
          name,
          deploy,
          provider,
          settled,
          connect,
          read,
          expectRead,
          refreshes,
          assertPrivate,
          spans,
          evidence,
        } = yield* renewalFixture;
        const renewing = yield* connect("Synthetic renewing account");
        const first = (yield* refreshes) + 1;
        yield* expectRead(renewing.profile, first);
        expect(yield* refreshes).toBe(first);

        // One call renews a grant once, even when the account fills two slots and the renewed
        // token already falls inside the renewal window: the second slot uses that token.
        {
          const pair = yield* deploy(`${name} pair`, ["service", "backup"]);
          const shared = yield* connect("Synthetic shared account", pair.id);
          const selected = yield* selectProfileAccounts(
            actors.owner,
            `${prefix}/apps/${pair.id}`,
            shared.profile,
            { service: shared.account, backup: shared.account },
          );
          expect(selected.status, JSON.stringify(selected.body)).toBe(200);
          yield* settled(pair.id, shared.profile);
          const renewed = (yield* refreshes) + 1;
          const response = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/apps/${pair.id}/tools/call`,
            { profile: shared.profile, tool: "read", kind: "query", input: {} },
          );
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          expect(yield* body(Read, response)).toEqual({
            service: presented(renewed),
            backup: presented(renewed),
          });
          expect(yield* refreshes).toBe(renewed);
        }

        // Only invalid_grant ends a grant. Every other failure keeps it: an outage, a response
        // Executor cannot use, a refusal of the OAuth client that every account shares, and any
        // other refusal, including codes outside RFC 6749. While the token is still valid, a
        // failed renewal ahead of expiry uses it; the renewal-ahead-of-expiry scenario covers
        // that. Here each token has expired before the failing call, so the call reports the
        // classified failure. Renew once into a short-lived token first.
        yield* issuer.configure({ expiresIn: shortLifetime });
        yield* expectRead(renewing.profile, (yield* refreshes) + 1);
        const transient: ReadonlyArray<{
          readonly failure: RefreshFailure;
          readonly reason:
            | "service_unavailable"
            | "rate_limited"
            | "incompatible_response"
            | "client_rejected"
            | "renewal_rejected";
          readonly status?: number;
          readonly providerError?: string;
        }> = [
          { failure: "unavailable", reason: "service_unavailable", status: 503 },
          { failure: "rate_limited", reason: "rate_limited", status: 429 },
          {
            failure: "server_error",
            reason: "service_unavailable",
            status: 400,
            providerError: "server_error",
          },
          {
            failure: "temporarily_unavailable",
            reason: "service_unavailable",
            status: 400,
            providerError: "temporarily_unavailable",
          },
          { failure: "connection_reset", reason: "service_unavailable" },
          { failure: "malformed", reason: "incompatible_response", status: 200 },
          {
            failure: "invalid_client",
            reason: "client_rejected",
            status: 400,
            providerError: "invalid_client",
          },
          {
            failure: "invalid_client_challenge",
            reason: "client_rejected",
            status: 401,
            providerError: "invalid_client",
          },
          { failure: "client_challenge", reason: "client_rejected", status: 401 },
          {
            failure: "unauthorized_client",
            reason: "client_rejected",
            status: 400,
            providerError: "unauthorized_client",
          },
          {
            failure: "invalid_request",
            reason: "renewal_rejected",
            status: 400,
            providerError: "invalid_request",
          },
          {
            failure: "invalid_scope",
            reason: "renewal_rejected",
            status: 400,
            providerError: "invalid_scope",
          },
          { failure: "slack_internal_error", reason: "renewal_rejected", status: 200 },
        ];
        for (const scenario of transient) {
          yield* Effect.sleep(pastShortLifetime);
          yield* issuer.configure({ tokenError: refreshFailures[scenario.failure] });
          const before = yield* refreshes;
          const failed = yield* read(renewing.profile);
          expect(failed.status, `${scenario.failure}: ${JSON.stringify(failed.body)}`).toBe(502);
          expect(yield* body(Failure, failed), scenario.failure).toMatchObject({
            _tag: "OAuthRenewalFailed",
            account: renewing.account,
            reason: scenario.reason,
            cause: {
              stage: "refresh",
              ...(scenario.status === undefined ? {} : { status: scenario.status }),
              ...(scenario.providerError === undefined
                ? {}
                : { providerError: scenario.providerError }),
            },
          });
          // A dropped connection has no response status to record.
          if (scenario.status === undefined)
            expect((yield* body(Failure, failed)).cause?.status, scenario.failure).toBeUndefined();
          // Only a rate limit carries the time its Retry-After names, here 30 seconds ahead.
          const retryAfter = (yield* body(Failure, failed)).retryAfter;
          if (scenario.reason !== "rate_limited")
            expect(retryAfter, scenario.failure).toBeUndefined();
          else if (retryAfter === undefined)
            return yield* Effect.die("A rate-limited renewal should carry its Retry-After time");
          else
            expect(Date.parse(retryAfter), scenario.failure).toBeGreaterThan(
              yield* Clock.currentTimeMillis,
            );
          assertPrivate(failed.body);
          // One attempt per call; the claim is released rather than retried or abandoned.
          expect(yield* refreshes, scenario.failure).toBe(before + 1);
          if (scenario.failure === "unavailable") {
            const trace = yield* spans;
            expect(
              trace.data.find(
                ({ span }) =>
                  span.operationName === "oauth.resolve" &&
                  span.tags["oauth.renewal.outcome"] !== undefined,
              )?.span.tags,
            ).toMatchObject({
              "oauth.provider.id": provider,
              "oauth.renewal.outcome": "service_unavailable",
            });
            expect(
              trace.data.find(({ span }) => span.operationName === "oauth.refresh")?.span.tags,
            ).toMatchObject({ "oauth.provider.id": provider, "oauth.stage": "refresh" });
            assertPrivate(trace);
            yield* evidence.json("refresh-unavailable-trace.json", trace);
          }
          // The saved refresh token still works once the service recovers. The renewed token
          // is short-lived too, so the next case starts from an expired token again.
          yield* issuer.configure({ tokenError: null });
          yield* expectRead(renewing.profile, before + 2);
        }

        // A renewal that states no lifetime, by omitting it or giving zero, keeps its token
        // rather than renewing on every call. The service's refusal of such a token renews it;
        // the renewal-on-refusal scenario below covers that.
        for (const lifetime of [0, null] as const) {
          yield* issuer.configure({ expiresIn: 20 });
          const unstated = yield* connect(`Synthetic ${lifetime ?? "omitted"} lifetime account`);
          yield* issuer.configure({ expiresIn: lifetime });
          const renewed = (yield* refreshes) + 1;
          yield* expectRead(unstated.profile, renewed);
          yield* expectRead(unstated.profile, renewed);
          expect(yield* refreshes, `expires_in ${lifetime}`).toBe(renewed);
        }
        // Without a refresh token, a zero lifetime does not demand an immediate reconnect.
        yield* issuer.configure({ refreshTokens: false, expiresIn: 0 });
        const unrenewable = yield* connect("Synthetic zero-lifetime account");
        yield* expectRead(unrenewable.profile, 0);
        yield* issuer.configure({ refreshTokens: true, expiresIn: 20 });

        // A refused grant needs a new sign-in, and the host stops presenting it.
        const refused = yield* connect("Synthetic refused account");
        yield* issuer.configure({ tokenError: refreshFailures.invalid_grant });
        const beforeRefusal = yield* refreshes;
        const rejected = yield* read(refused.profile);
        expect(rejected.status, JSON.stringify(rejected.body)).toBe(409);
        expect(yield* body(Failure, rejected)).toMatchObject({
          _tag: "OAuthReconnectRequired",
          account: refused.account,
          cause: { stage: "refresh", status: 400, providerError: "invalid_grant" },
        });
        assertPrivate(rejected.body);
        const refusal = yield* spans;
        expect(
          refusal.data.find(
            ({ span }) =>
              span.operationName === "oauth.resolve" &&
              span.tags["oauth.reconnect.reason"] !== undefined,
          )?.span.tags,
        ).toMatchObject({
          "oauth.provider.id": provider,
          "oauth.renewal.outcome": "reconnect",
          "oauth.reconnect.reason": "renewal_refused",
          "oauth.error.stage": "refresh",
          "oauth.error.provider_code": "invalid_grant",
          "http.response.status_code": "400",
        });
        // An account that needs reconnecting is an expected state, recorded as the resolve's
        // outcome rather than as a failed span.
        expect(
          refusal.data.find(
            ({ span }) =>
              span.operationName === "oauth.resolve" &&
              span.tags["oauth.reconnect.reason"] !== undefined,
          )?.span.status,
        ).not.toBe("error");
        assertPrivate(refusal);
        yield* evidence.json("refresh-refused-trace.json", refusal);
        yield* issuer.configure({ tokenError: null });
        const again = yield* read(refused.profile);
        expect(again.status, JSON.stringify(again.body)).toBe(409);
        expect(yield* refreshes).toBe(beforeRefusal + 1);
      }),
    ),
  );
  it.effect(scenarios.oauthRenewalAheadOfExpiry.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const {
          issuer,
          provider,
          connect,
          read,
          expectRead,
          refreshes,
          assertPrivate,
          spans,
          evidence,
        } = yield* renewalFixture;
        // Tokens last 20 seconds, inside the host's 30-second renewal window, so every call
        // renews ahead of expiry.
        const account = yield* connect("Synthetic outage account");
        const current = (yield* refreshes) + 1;
        yield* expectRead(account.profile, current);

        // The service is down. The call's renewal fails without ending the grant, and the call
        // uses the token it still holds, as calls waiting on that renewal do.
        yield* issuer.configure({ tokenError: refreshFailures.unavailable });
        const beforeOutage = yield* refreshes;
        yield* expectRead(account.profile, current);
        expect(yield* refreshes, "One renewal attempt per call").toBe(beforeOutage + 1);
        // The failure is traced as the resolve's outcome, not as a failed resolve.
        const trace = yield* spans;
        const resolved = trace.data.find(
          ({ span }) =>
            span.operationName === "oauth.resolve" &&
            span.tags["oauth.renewal.outcome"] !== undefined,
        )?.span;
        expect(resolved?.tags).toMatchObject({
          "oauth.provider.id": provider,
          "oauth.renewal.outcome": "service_unavailable",
          "oauth.resolve.outcome": "current_token",
          "oauth.error.stage": "refresh",
          "http.response.status_code": "503",
        });
        expect(resolved?.status).not.toBe("error");
        assertPrivate(trace);
        yield* evidence.json("renewal-ahead-of-expiry-outage-trace.json", trace);

        // The grant and its refresh token were kept, so the next call after the service
        // recovers renews.
        yield* issuer.configure({ tokenError: null });
        yield* expectRead(account.profile, beforeOutage + 2);
        expect(yield* refreshes).toBe(beforeOutage + 2);

        // Once the token has expired there is nothing to fall back to: the call fails.
        yield* issuer.configure({ expiresIn: shortLifetime });
        yield* expectRead(account.profile, beforeOutage + 3);
        yield* Effect.sleep(pastShortLifetime);
        yield* issuer.configure({ tokenError: refreshFailures.unavailable });
        const beforeExpired = yield* refreshes;
        const failed = yield* read(account.profile);
        expect(failed.status, JSON.stringify(failed.body)).toBe(502);
        expect(yield* body(Failure, failed)).toMatchObject({
          _tag: "OAuthRenewalFailed",
          account: account.account,
          reason: "service_unavailable",
          cause: { stage: "refresh", status: 503 },
        });
        assertPrivate(failed.body);
        expect(yield* refreshes).toBe(beforeExpired + 1);
        yield* issuer.configure({ tokenError: null, expiresIn: 20 });
      }),
    ),
  );
  it.effect(scenarios.oauthRenewalOnRefusal.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const {
          api,
          actors,
          issuer,
          prefix,
          app,
          connect,
          read,
          expectRead,
          refreshes,
          assertPrivate,
        } = yield* renewalFixture;
        // Salesforce issues a refresh token but no `expires_in`, then ends the session later, and
        // its API answers the old token with 401. Executor renews the grant once and repeats a
        // query, which only reads; later calls keep the renewed token.
        yield* issuer.configure({ expiresIn: null });
        const session = yield* connect("Synthetic Salesforce-style account");
        const beforeExpiry = yield* refreshes;
        yield* expectRead(session.profile, 0);
        yield* expectRead(session.profile, 0);
        expect(yield* refreshes, "An unstated lifetime is not renewed ahead").toBe(beforeExpiry);
        yield* issuer.expireAccessTokens;
        const reads = (yield* issuer.metrics).resourceRequests.GET;
        const renewed = beforeExpiry + 1;
        yield* expectRead(session.profile, renewed);
        expect(yield* refreshes).toBe(renewed);
        // The refused read and its one repetition.
        expect((yield* issuer.metrics).resourceRequests.GET).toBe(reads + 2);
        yield* expectRead(session.profile, renewed);
        expect(yield* refreshes).toBe(renewed);

        // A mutation is never repeated: an earlier request in the same call may already have
        // made changes. The grant is still renewed, and the next call uses it.
        yield* issuer.expireAccessTokens;
        const posts = (yield* issuer.metrics).resourceRequests.POST;
        const write = api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/tools/call`, {
          profile: session.profile,
          tool: "write",
          kind: "mutation",
          input: {},
        });
        const refused = yield* write;
        expect(refused.status, JSON.stringify(refused.body)).toBe(502);
        expect(refused.body).toMatchObject({
          _tag: "AppProviderFailed",
          reason: "unauthorized",
          status: 401,
          credentialsRenewed: true,
          account: { id: session.account },
        });
        assertPrivate(refused.body);
        expect((yield* issuer.metrics).resourceRequests.POST).toBe(posts + 1);
        expect(yield* refreshes).toBe(renewed + 1);
        const written = yield* write;
        expect(written.status, JSON.stringify(written.body)).toBe(200);
        expect(yield* body(Read, written)).toEqual({ service: presented(renewed + 1) });
        expect(yield* refreshes).toBe(renewed + 1);

        // A renewal the service refuses with invalid_grant needs a new sign-in.
        yield* issuer.expireAccessTokens;
        yield* issuer.configure({ tokenError: refreshFailures.invalid_grant });
        const ended = yield* read(session.profile);
        expect(ended.status, JSON.stringify(ended.body)).toBe(409);
        expect(yield* body(Failure, ended)).toMatchObject({
          _tag: "OAuthReconnectRequired",
          account: session.account,
          cause: { stage: "refresh", status: 400, providerError: "invalid_grant" },
        });
        yield* issuer.configure({ tokenError: null, expiresIn: 20 });
        const stillEnded = yield* read(session.profile);
        expect(stillEnded.status, JSON.stringify(stillEnded.body)).toBe(409);
        expect(yield* refreshes).toBe(renewed + 2);
      }),
    ),
  );
  it.effect(scenarios.oauthListingRenewalOnRefusal.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, issuer, prefix, name, connect, refreshes, assertPrivate } =
          yield* renewalFixture;
        // An account-dependent catalog: the app reads the service while it is evaluated, before
        // any tool runs, and names the token it presented in its tool's description. MCP
        // discovery reads this same listing.
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `${name} catalog`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, oauth2, query, object, router, ProviderError } from "apps";
const service = defineProvider({ name: ${JSON.stringify(`${name} catalog`)}, auth: { oauth: oauth2({ discover: ${JSON.stringify(`${issuer.origin}/mcp`)} }) } });
export default defineApp({ accounts: { service } }, async ({ accounts, signal }) => {
  const response = await fetch(${JSON.stringify(`${issuer.origin}/resource`)}, { signal, headers: { authorization: "Bearer " + accounts.service.fields.access_token } });
  if (response.status === 401) throw new ProviderError({ reason: "unauthorized", status: 401, accountId: accounts.service.id });
  const presented = await response.json();
  return { tools: router({ read: query({ input: object({}), description: JSON.stringify(presented) }, async () => presented) }) };
});`,
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(AppProvider, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const Listing = Schema.Struct({
          items: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String })),
        });
        const list = (profile: string) =>
          api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/tools?profile=${profile}`);
        const reads = issuer.metrics.pipe(Effect.map((metrics) => metrics.resourceRequests.GET));

        // Salesforce-style: a refresh token and no `expires_in`, so nothing renews it ahead.
        yield* issuer.configure({ expiresIn: null });
        const session = yield* connect("Synthetic catalog account", app.id);
        yield* issuer.expireAccessTokens;

        // A renewal that fails for a transient reason reports that failure, and the listing is not
        // kept: the next listing renews and succeeds.
        yield* issuer.configure({ tokenError: refreshFailures.unavailable });
        const beforeOutage = yield* refreshes;
        const outage = yield* list(session.profile);
        expect(outage.status, JSON.stringify(outage.body)).toBe(502);
        expect(outage.body).toMatchObject({
          _tag: "OAuthRenewalFailed",
          account: session.account,
          reason: "service_unavailable",
        });
        assertPrivate(outage.body);
        expect(yield* refreshes).toBe(beforeOutage + 1);
        yield* issuer.configure({ tokenError: null });

        // The service refuses the token while the catalog is evaluated: Executor renews the grant
        // once and evaluates again, which only reads.
        const beforeRenewal = yield* reads;
        const renewed = (yield* refreshes) + 1;
        const listed = yield* list(session.profile);
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        expect((yield* body(Listing, listed)).items).toEqual([
          { name: "read", description: JSON.stringify(presented(renewed)) },
        ]);
        expect(yield* refreshes).toBe(renewed);
        // The refused evaluation and its one repetition.
        expect(yield* reads).toBe(beforeRenewal + 2);
        // The renewed listing is kept: the next listing neither evaluates nor renews again.
        const kept = yield* list(session.profile);
        expect(kept.status, JSON.stringify(kept.body)).toBe(200);
        expect((yield* body(Listing, kept)).items).toEqual([
          { name: "read", description: JSON.stringify(presented(renewed)) },
        ]);
        expect(yield* refreshes).toBe(renewed);
        expect(yield* reads).toBe(beforeRenewal + 2);

        // A renewal refused with invalid_grant during listing needs a new sign-in. Another account
        // has its own listing, so the kept one above does not answer for it.
        const ending = yield* connect("Synthetic ending catalog account", app.id);
        yield* issuer.expireAccessTokens;
        yield* issuer.configure({ tokenError: refreshFailures.invalid_grant });
        const beforeEnd = yield* refreshes;
        // Self-host evaluates the listing as background work, and its reader checks the accounts
        // again before taking the outcome, so it reports the reconnect it finds there.
        const ended = yield* list(ending.profile);
        expect(ended.status, JSON.stringify(ended.body)).toBe(409);
        expect(ended.body).toMatchObject({
          _tag: "OAuthReconnectRequired",
          account: ending.account,
        });
        assertPrivate(ended.body);
        // The listing's own renewal was the one the service refused.
        expect(yield* refreshes).toBe(beforeEnd + 1);
        yield* issuer.configure({ tokenError: null, expiresIn: 20 });
        const stillEnded = yield* list(ending.profile);
        expect(stillEnded.status, JSON.stringify(stillEnded.body)).toBe(409);
        expect(stillEnded.body).toMatchObject({
          _tag: "OAuthReconnectRequired",
          account: ending.account,
        });
        expect(yield* refreshes).toBe(beforeEnd + 1);
      }),
    ),
  );
});
