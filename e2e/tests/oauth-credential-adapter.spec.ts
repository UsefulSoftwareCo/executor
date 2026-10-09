/**
 * OAuth renewal and revocation through a credentials adapter that holds the refresh token and
 * client secret, so the host only ever sees placeholders for them. The adapter is a loopback fake
 * that renews against the same synthetic issuer the host's own renewal scenarios use.
 */
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { credentialAdapter } from "../support/credential-adapter.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { createProfile } from "../support/profiles.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const AppProvider = Schema.Struct({ id: Schema.String });
const SetupStatus = Schema.Struct({ status: Schema.String });
const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const Read = Schema.Struct({
  service: Schema.Struct({
    refreshed: Schema.Boolean,
    authorization: Schema.NullOr(Schema.String),
  }),
});
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
/** Seconds a token lasts when a case needs it expired before the next call. */
const shortLifetime = 1;
const pastShortLifetime = "1200 millis";
/**
 * Values that must not appear in a response or trace: the refresh token and client secret, the
 * replaced first access token and the service's private error text. Renewed access tokens are
 * `synthetic-refreshed-token-<n>`. The AES path keeps these out too, so this does not show that
 * the adapter held them; the restart in the renewal scenario does.
 */
const assertPrivate = (value: unknown) => {
  const json = JSON.stringify(value);
  for (const marker of [
    "synthetic-access-token",
    "synthetic-refresh-",
    "synthetic-client-secret",
    "PRIVATE_PROVIDER_ERROR",
  ])
    expect(json).not.toContain(marker);
};

/**
 * Start the adapter and the issuer, restart the product with the adapter configured, and deploy an
 * app whose tool presents its account's access token to the issuer. The setting is turned on
 * before any account exists. The plan's `serverEnvironment` cannot carry it: the adapter's
 * loopback origin is allocated when the scenario runs.
 */
const adapterFixture = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    evidence = yield* Evidence,
    telemetry = yield* Telemetry,
    http = yield* HttpClient.HttpClient;
  const adapter = yield* credentialAdapter;
  const issuer = yield* oauthSetupIssuer;
  yield* serverControl("stop");
  yield* serverControl("environment", 200, { EXECUTOR_CREDENTIAL_ADAPTER_URL: adapter.origin });
  yield* serverControl("start");

  const prefix = `/api/organizations/${actors.organization.id}`;
  const name = `Adapter ${randomUUID().slice(0, 8)}`;
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name,
    files: [
      {
        path: "index.ts",
        content: `import { defineApp, defineProvider, oauth2, query, object, router } from "apps";
const service = defineProvider({ name: ${JSON.stringify(name)}, auth: { oauth: oauth2({ discover: ${JSON.stringify(`${issuer.origin}/mcp`)} }) } });
export default defineApp({ accounts: { service } }, async ({ accounts }) => ({
  tools: router({
    read: query({ input: object({}) }, async ({ fetch }) => ({ service: await (await fetch(${JSON.stringify(`${issuer.origin}/resource`)}, { headers: { authorization: "Bearer " + accounts.service.fields.access_token } })).json() })),
  }),
}));`,
      },
      appsManifest,
    ],
  });
  expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
  const app = yield* body(AppProvider, deployed);
  const appPath = `${prefix}/apps/${app.id}`;
  yield* Effect.addFinalizer(() => api.request(actors.owner, "DELETE", appPath).pipe(Effect.orDie));

  /** Connect one account through the real start, consent and callback boundaries. */
  const connect = (label: string) =>
    Effect.gen(function* () {
      const profile = yield* createProfile(actors.owner, appPath);
      const connection = yield* body(
        Resource,
        yield* api.request(actors.owner, "POST", `${appPath}/connections`, {
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
      // Background profile setup resolves, and so may renew, the new account. Let it finish so
      // each renewal below belongs to a call the scenario makes.
      yield* api.request(actors.owner, "GET", `${appPath}/profiles/${profile.id}`).pipe(
        Effect.flatMap((response) => body(SetupStatus, response)),
        Effect.flatMap((current) =>
          current.status !== "pending"
            ? Effect.void
            : Effect.fail(new Error("Profile setup has not finished")),
        ),
        Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
      );
      return { profile: profile.id, account: account.id };
    });
  const read = (profile: string) =>
    api.request(actors.owner, "POST", `${appPath}/tools/call`, {
      profile,
      tool: "read",
      input: {},
    });
  /** A read that presents the access token the issuer's nth refresh issued. */
  const expectRenewed = (profile: string, generation: number) =>
    Effect.gen(function* () {
      const response = yield* read(profile);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(yield* body(Read, response)).toEqual({
        service: {
          refreshed: true,
          authorization: `Bearer synthetic-refreshed-token-${generation}`,
        },
      });
      assertPrivate(response.body);
    });
  const refreshes = issuer.metrics.pipe(Effect.map((metrics) => metrics.refreshes));
  /** The latest request's trace, once its resolve span has arrived. */
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
    prefix,
    adapter,
    issuer,
    connect,
    read,
    expectRenewed,
    refreshes,
    spans,
    evidence,
  };
});

layer(HostedLive, { excludeTestServices: true })("OAuth credential adapter", (it) => {
  it.effect(scenarios.credentialAdapterRenewal.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { adapter, issuer, connect, read, expectRenewed, refreshes, spans, evidence } =
          yield* adapterFixture;
        // Every refresh replaces the refresh token, and the issuer refuses a replaced one, so only
        // the newest copy works. Tokens last 20 seconds, inside the host's 30-second renewal
        // window, so every call renews.
        yield* issuer.configure({
          refreshTokens: true,
          rotateRefreshTokens: true,
          replacedRefreshTokens: "refused",
          expiresIn: 20,
        });
        const account = yield* connect("Synthetic adapter account");
        const before = yield* refreshes;
        const renewalsBefore = (yield* adapter.metrics).renewals;
        yield* expectRenewed(account.profile, before + 1);
        expect(yield* refreshes).toBe(before + 1);
        expect((yield* adapter.metrics).renewals).toBe(renewalsBefore + 1);
        // Every refresh the issuer saw came from the adapter.
        expect((yield* adapter.metrics).renewals).toBe(yield* refreshes);

        const trace = yield* spans;
        expect(trace.data.some(({ span }) => span.operationName === "sdk.credentials.renew")).toBe(
          true,
        );
        expect(
          trace.data.find(
            ({ span }) =>
              span.operationName === "oauth.resolve" &&
              span.tags["oauth.renewal.outcome"] !== undefined,
          )?.span.tags,
        ).toMatchObject({ "oauth.renewal.custody": "store", "oauth.renewal.outcome": "renewed" });
        // The host made no token request of its own.
        expect(
          trace.data
            .map(({ span }) => span.operationName)
            .filter((name) => name === "oauth.request" || name === "oauth.refresh"),
        ).toEqual([]);
        assertPrivate(trace);
        yield* evidence.json("adapter-renewal-trace.json", trace);

        // This is the proof that the adapter holds the refresh token. A new process has only the
        // saved grant: the rotated refresh token reaches it through the bytes the adapter sealed,
        // or the issuer refuses the replaced one.
        yield* serverControl("stop");
        yield* serverControl("start");
        yield* expectRenewed(account.profile, before + 2);
        expect(yield* refreshes).toBe(before + 2);
        expect((yield* adapter.metrics).renewals).toBe(yield* refreshes);

        // Some services send expires_in as a numeric string, which the host's own request
        // accepts. A store that passes it on renews too. The next step renews again only if this
        // renewal kept both the rotated refresh token and the 20-second lifetime.
        yield* adapter.configure({ expiresIn: "text" });
        yield* expectRenewed(account.profile, before + 3);
        yield* adapter.configure({ expiresIn: null });

        // The adapter fails after the service rotated the token, while the host seals the renewed
        // grant again. Once the claim's lease lapses, the next call renews from the adapter's new
        // seal; from the one before it, the issuer would refuse the replaced token.
        yield* adapter.configure({ reseal: "unavailable" });
        const lost = yield* read(account.profile);
        expect(lost.status, JSON.stringify(lost.body)).toBe(500);
        expect(yield* refreshes).toBe(before + 4);
        yield* expectRenewed(account.profile, before + 5);
        expect((yield* adapter.metrics).renewals).toBe(yield* refreshes);
      }),
    ),
  );

  it.effect(scenarios.credentialAdapterRefusals.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { adapter, issuer, connect, read, expectRenewed, refreshes, spans, evidence } =
          yield* adapterFixture;
        yield* issuer.configure({ refreshTokens: true, expiresIn: 20 });
        const account = yield* connect("Synthetic adapter refusals");
        // A failed renewal ahead of expiry uses the current token, so each case starts from a
        // token that has already expired.
        yield* issuer.configure({ expiresIn: shortLifetime });
        yield* expectRenewed(account.profile, (yield* refreshes) + 1);

        const failures = [
          {
            name: "invalid_client",
            failure: () =>
              issuer.configure({
                tokenError: {
                  status: 400,
                  body: { error: "invalid_client", error_description: "PRIVATE_PROVIDER_ERROR" },
                },
              }),
            reason: "client_rejected",
            cause: { stage: "refresh", status: 400, providerError: "invalid_client" },
          },
          {
            name: "rate limit",
            failure: () =>
              issuer.configure({ tokenError: { status: 429, body: {}, retryAfter: "30" } }),
            reason: "rate_limited",
            cause: { stage: "refresh", status: 429 },
          },
          {
            // Not an RFC 6749 code, but still the service's error body.
            name: "internal_error",
            failure: () =>
              issuer.configure({
                tokenError: {
                  status: 400,
                  body: { error: "internal_error", error_description: "PRIVATE_PROVIDER_ERROR" },
                },
              }),
            reason: "renewal_rejected",
            cause: { stage: "refresh", status: 400 },
          },
          {
            name: "service outage",
            failure: () => issuer.configure({ tokenError: { status: 503, body: {} } }),
            reason: "service_unavailable",
            cause: { stage: "refresh", status: 503 },
          },
          {
            name: "adapter outage",
            failure: () => adapter.configure({ renew: "unavailable" }),
            reason: "service_unavailable",
            cause: { stage: "refresh" },
          },
        ] as const;
        for (const scenario of failures) {
          yield* Effect.sleep(pastShortLifetime);
          yield* scenario.failure();
          const failed = yield* read(account.profile);
          expect(failed.status, `${scenario.name}: ${JSON.stringify(failed.body)}`).toBe(502);
          const failure = yield* body(Failure, failed);
          expect(failure, scenario.name).toMatchObject({
            _tag: "OAuthRenewalFailed",
            account: account.account,
            reason: scenario.reason,
          });
          expect(failure.cause, scenario.name).toEqual(scenario.cause);
          if (scenario.reason !== "rate_limited")
            expect(failure.retryAfter, scenario.name).toBeUndefined();
          else
            expect(Date.parse(failure.retryAfter ?? ""), scenario.name).toBeGreaterThan(
              yield* Clock.currentTimeMillis,
            );
          assertPrivate(failed.body);
          // The grant was kept: once the service and the adapter answer again, the next call renews.
          yield* issuer.configure({ tokenError: null });
          yield* adapter.configure({ renew: null });
          yield* expectRenewed(account.profile, (yield* refreshes) + 1);
        }

        // Only invalid_grant ends the grant.
        yield* issuer.configure({
          tokenError: {
            status: 400,
            body: { error: "invalid_grant", error_description: "PRIVATE_PROVIDER_ERROR" },
          },
        });
        const refused = yield* read(account.profile);
        expect(refused.status, JSON.stringify(refused.body)).toBe(409);
        expect(yield* body(Failure, refused)).toMatchObject({
          _tag: "OAuthReconnectRequired",
          account: account.account,
          cause: { stage: "refresh", status: 400, providerError: "invalid_grant" },
        });
        assertPrivate(refused.body);
        const trace = yield* spans;
        expect(
          trace.data.find(
            ({ span }) =>
              span.operationName === "oauth.resolve" &&
              span.tags["oauth.reconnect.reason"] !== undefined,
          )?.span.tags,
        ).toMatchObject({
          "oauth.renewal.custody": "store",
          "oauth.renewal.outcome": "reconnect",
          "oauth.reconnect.reason": "renewal_refused",
        });
        assertPrivate(trace);
        yield* evidence.json("adapter-refusal-trace.json", trace);

        // A grant the service issued no refresh token for cannot be renewed by anyone: once its
        // token expires it reconnects without a request to the adapter.
        yield* issuer.configure({
          tokenError: null,
          refreshTokens: false,
          expiresIn: shortLifetime,
        });
        const unrenewable = yield* connect("Synthetic adapter without refresh token");
        const renewals = (yield* adapter.metrics).renewals;
        yield* Effect.sleep(pastShortLifetime);
        const expired = yield* read(unrenewable.profile);
        expect(expired.status, JSON.stringify(expired.body)).toBe(409);
        expect(yield* body(Failure, expired)).toMatchObject({
          _tag: "OAuthReconnectRequired",
          account: unrenewable.account,
        });
        expect((yield* adapter.metrics).renewals).toBe(renewals);
        expect(
          (yield* spans).data.find(
            ({ span }) =>
              span.operationName === "oauth.resolve" &&
              span.tags["oauth.reconnect.reason"] !== undefined,
          )?.span.tags,
        ).toMatchObject({ "oauth.reconnect.reason": "not_renewable" });
      }),
    ),
  );

  it.effect(scenarios.credentialAdapterRevocation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix, adapter, issuer, connect } = yield* adapterFixture;
        yield* issuer.configure({ refreshTokens: true, revocation: "recorded" });
        const account = yield* connect("Synthetic adapter revocation");
        const deleted = yield* api.request(
          actors.owner,
          "DELETE",
          `${prefix}/accounts/${account.account}`,
        );
        expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
        // Revocation runs after the response, so wait for the issuer to observe it.
        const revocations = yield* issuer.metrics.pipe(
          Effect.map((metrics) => metrics.revocations),
          Effect.flatMap((calls) =>
            calls.length >= 1
              ? Effect.succeed(calls)
              : Effect.fail(new Error("Revocation has not arrived")),
          ),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
        );
        // The issuer recognises the refresh token it issued, sent with the client's real secret.
        expect(revocations).toEqual([
          { token: "refresh", hint: "refresh_token", clientAuthenticated: true },
        ]);
        expect((yield* adapter.metrics).revocations).toBe(1);
      }),
    ),
  );
});
