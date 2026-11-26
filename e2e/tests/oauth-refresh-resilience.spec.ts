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
import { settleWebhookSources } from "../support/webhook-sources.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest, databaseFiles } from "../support/apps-release.ts";
import { recordingService } from "../support/recording-service.ts";
import {
  expectUnknownOutcome,
  unknownOutcomeAction,
  unknownOutcomeRecovery,
} from "../support/write-outcome.ts";
import { connectionsPath, linkAccount } from "../support/app-accounts.ts";

const AppProvider = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});
const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const Echo = Schema.Struct({
  refreshed: Schema.Boolean,
  authorization: Schema.NullOr(Schema.String),
});
const Read = Schema.Record(Schema.String, Echo);
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
const renewalInsideWrite =
  "Respect any wait specified by the renewal error; a later safe read that uses this account may trigger renewal when access is due for renewal or rejected again. If renewal keeps failing, inspect its error and reconnect only when the service indicates it is needed.";

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
  slack_internal_error: {
    status: 200,
    body: { ok: false, error: "internal_error", ...privateError },
  },
  invalid_grant: { status: 400, body: { error: "invalid_grant", ...privateError } },
  // Supabase Auth's OAuth server refuses a refresh with its own body instead of RFC 6749's
  // `error`. Its `refresh_token_already_used` means the grant has ended; other codes do not.
  supabase_refusal: {
    status: 400,
    body: { code: 400, error_code: "validation_failed", msg: "PRIVATE_PROVIDER_ERROR" },
  },
  supabase_already_used: {
    status: 400,
    body: { code: 400, error_code: "refresh_token_already_used", msg: "PRIVATE_PROVIDER_ERROR" },
  },
  github_bad_refresh_token: { status: 200, body: { error: "bad_refresh_token", ...privateError } },
  slack_invalid_refresh_token: {
    status: 200,
    body: { ok: false, error: "invalid_refresh_token", ...privateError },
  },
  slack_token_revoked: {
    status: 200,
    body: { ok: false, error: "token_revoked", ...privateError },
  },
  aws_token_expired: {
    status: 401,
    body: { error: "TOKEN_EXPIRED", message: "PRIVATE_PROVIDER_ERROR" },
  },
  aws_user_credentials_changed: {
    status: 403,
    body: { error: "USER_CREDENTIALS_CHANGED", message: "PRIVATE_PROVIDER_ERROR" },
  },
  tesla_login_required: { status: 401, body: { error: "login_required", ...privateError } },
} satisfies Record<string, TokenError>;
type RefreshFailure = keyof typeof refreshFailures;
const shortLifetime = 1;
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

const renewalFixture = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    evidence = yield* Evidence,
    telemetry = yield* Telemetry,
    http = yield* HttpClient.HttpClient;
  const issuer = yield* oauthSetupIssuer;
  const prefix = `/api/organizations/${actors.organization.id}`;
  yield* issuer.configure({ refreshTokens: true, expiresIn: 20 });
  const name = `Renewal ${randomUUID().slice(0, 8)}`;
  const deploy = (appName: string, slots: ReadonlyArray<string>, manifest = appsManifest) =>
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
export default defineApp({ user: { accounts: { ${slots.map((slot) => `${slot}: service`).join(", ")} } } }, async ({ user: { accounts } }) => ({
  tools: router({
    read: query({ input: object({}) }, async ({ fetch }) => ({ ${reads} })),
    write: mutation({ input: object({}) }, async ({ fetch }) => ({ ${slots[0]}: await call(fetch, accounts.${slots[0]}, "POST") })),
  }),
}));`,
          },
          manifest,
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

  const connect = (label: string, appId = app.id) =>
    Effect.gen(function* () {
      const connection = yield* body(
        Resource,
        yield* api.request(
          actors.owner,
          "POST",
          connectionsPath(`${prefix}/apps/${appId}`, "user", "service"),
          {},
        ),
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
      yield* settleWebhookSources(actors.owner, `${prefix}/apps/${appId}`, (sources) =>
        sources.some((source) => source.account === account.id && source.status !== "pending"),
      );
      return account.id;
    });
  const read = (appId = app.id) =>
    api.request(actors.owner, "POST", `${prefix}/apps/${appId}/tools/call`, {
      tool: "read",
      kind: "query",
      input: {},
    });
  const list = (appId = app.id) =>
    Effect.gen(function* () {
      const listed = yield* api.request(actors.owner, "GET", `${prefix}/apps/${appId}/tools`);
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    });
  const expectRead = (generation: number) =>
    Effect.gen(function* () {
      const response = yield* read();
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
    connect,
    read,
    list,
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
        yield* expectRead(first);
        expect(yield* refreshes).toBe(first);

        {
          const pair = yield* deploy(`${name} pair`, ["service", "backup"]);
          const shared = yield* connect("Synthetic paired account", pair.id);
          yield* linkAccount(actors.owner, `${prefix}/apps/${pair.id}`, "backup", shared);
          yield* settleWebhookSources(actors.owner, `${prefix}/apps/${pair.id}`, (sources) =>
            sources.some((source) => source.account === shared && source.status !== "pending"),
          );
          const renewed = (yield* refreshes) + 1;
          const response = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/apps/${pair.id}/tools/call`,
            {
              tool: "read",
              kind: "query",
              input: {},
            },
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
        yield* expectRead((yield* refreshes) + 1);
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
          { failure: "supabase_refusal", reason: "renewal_rejected", status: 400 },
        ];
        for (const scenario of transient) {
          yield* Effect.sleep(pastShortLifetime);
          yield* issuer.configure({ tokenError: refreshFailures[scenario.failure] });
          const before = yield* refreshes;
          const failed = yield* read();
          expect(failed.status, `${scenario.failure}: ${JSON.stringify(failed.body)}`).toBe(502);
          expect(yield* body(Failure, failed), scenario.failure).toMatchObject({
            _tag: "OAuthRenewalFailed",
            account: renewing,
            reason: scenario.reason,
            cause: {
              stage: "refresh",
              ...(scenario.status === undefined ? {} : { status: scenario.status }),
              ...(scenario.providerError === undefined
                ? {}
                : { providerError: scenario.providerError }),
            },
          });
          if (scenario.status === undefined)
            expect((yield* body(Failure, failed)).cause?.status, scenario.failure).toBeUndefined();
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
              "oauth.resolve.purpose": "run",
              "oauth.resolve.credential_type": "oauth2",
              "executor.account.id": expect.any(String),
              "executor.organization.id": actors.organization.id,
              "executor.user.id": expect.any(String),
            });
            expect(
              trace.data.find(({ span }) => span.operationName === "oauth.refresh")?.span.tags,
            ).toMatchObject({ "oauth.provider.id": provider, "oauth.stage": "refresh" });
            assertPrivate(trace);
            yield* evidence.json("refresh-unavailable-trace.json", trace);
          }
          yield* issuer.configure({ tokenError: null });
          yield* expectRead(before + 2);
        }

        for (const lifetime of [0, null] as const) {
          yield* issuer.configure({ expiresIn: 20 });
          yield* connect(`Synthetic ${lifetime ?? "omitted"} lifetime account`);
          yield* issuer.configure({ expiresIn: lifetime });
          const renewed = (yield* refreshes) + 1;
          yield* expectRead(renewed);
          yield* expectRead(renewed);
          expect(yield* refreshes, `expires_in ${lifetime}`).toBe(renewed);
        }
        yield* issuer.configure({ refreshTokens: false, expiresIn: 0 });
        yield* connect("Synthetic zero-lifetime account");
        yield* expectRead(0);
        yield* issuer.configure({ refreshTokens: true, expiresIn: 20 });

        const refused = yield* connect("Synthetic refused account");
        yield* issuer.configure({ tokenError: refreshFailures.invalid_grant });
        const beforeRefusal = yield* refreshes;
        const rejected = yield* read();
        expect(rejected.status, JSON.stringify(rejected.body)).toBe(409);
        expect(yield* body(Failure, rejected)).toMatchObject({
          _tag: "OAuthReconnectRequired",
          account: refused,
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
        const again = yield* read();
        expect(again.status, JSON.stringify(again.body)).toBe(409);
        expect(yield* refreshes).toBe(beforeRefusal + 1);
      }),
    ),
  );
  it.effect(scenarios.oauthRenewalEndedGrantCodes.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { issuer, provider, connect, read, refreshes, assertPrivate, spans, evidence } =
          yield* renewalFixture;
        const ended: ReadonlyArray<{
          readonly failure: RefreshFailure;
          readonly status: number;
          readonly code: string;
        }> = [
          { failure: "supabase_already_used", status: 400, code: "refresh_token_already_used" },
          { failure: "github_bad_refresh_token", status: 200, code: "bad_refresh_token" },
          { failure: "slack_invalid_refresh_token", status: 200, code: "invalid_refresh_token" },
          { failure: "slack_token_revoked", status: 200, code: "token_revoked" },
          { failure: "aws_token_expired", status: 401, code: "token_expired" },
          {
            failure: "aws_user_credentials_changed",
            status: 403,
            code: "user_credentials_changed",
          },
          { failure: "tesla_login_required", status: 401, code: "login_required" },
        ];
        for (const scenario of ended) {
          const account = yield* connect(`Synthetic ${scenario.failure} account`);
          yield* issuer.configure({ tokenError: refreshFailures[scenario.failure] });
          const before = yield* refreshes;
          const refusedRead = yield* read();
          expect(
            refusedRead.status,
            `${scenario.failure}: ${JSON.stringify(refusedRead.body)}`,
          ).toBe(409);
          expect(yield* body(Failure, refusedRead), scenario.failure).toMatchObject({
            _tag: "OAuthReconnectRequired",
            account,
            cause: { stage: "refresh", status: scenario.status },
          });
          assertPrivate(refusedRead.body);
          const trace = yield* spans;
          expect(
            trace.data.find(
              ({ span }) =>
                span.operationName === "oauth.resolve" &&
                span.tags["oauth.renewal.outcome"] !== undefined,
            )?.span.tags,
            scenario.failure,
          ).toMatchObject({
            "oauth.provider.id": provider,
            "oauth.renewal.outcome": "reconnect",
            "oauth.reconnect.reason": "renewal_refused",
          });
          expect(
            trace.data.find(({ span }) => span.operationName === "oauth.refresh")?.span.tags,
            scenario.failure,
          ).toMatchObject({ "oauth.error.known_provider_code": scenario.code });
          assertPrivate(trace);
          yield* evidence.json(`refresh-${scenario.failure}-trace.json`, trace);
          yield* issuer.configure({ tokenError: null });
          const stillEnded = yield* read();
          expect(stillEnded.status, `${scenario.failure}: ${JSON.stringify(stillEnded.body)}`).toBe(
            409,
          );
          expect(yield* refreshes, scenario.failure).toBe(before + 1);
        }
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
        const account = yield* connect("Synthetic outage account");
        const current = (yield* refreshes) + 1;
        yield* expectRead(current);

        yield* issuer.configure({ tokenError: refreshFailures.unavailable });
        const beforeOutage = yield* refreshes;
        yield* expectRead(current);
        expect(yield* refreshes, "One renewal attempt per call").toBe(beforeOutage + 1);
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

        yield* issuer.configure({ tokenError: null });
        yield* expectRead(beforeOutage + 2);
        expect(yield* refreshes).toBe(beforeOutage + 2);

        yield* issuer.configure({ expiresIn: shortLifetime });
        yield* expectRead(beforeOutage + 3);
        yield* Effect.sleep(pastShortLifetime);
        yield* issuer.configure({ tokenError: refreshFailures.unavailable });
        const beforeExpired = yield* refreshes;
        const failed = yield* read();
        expect(failed.status, JSON.stringify(failed.body)).toBe(502);
        expect(yield* body(Failure, failed)).toMatchObject({
          _tag: "OAuthRenewalFailed",
          account,
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
          list,
          expectRead,
          refreshes,
          assertPrivate,
        } = yield* renewalFixture;
        yield* issuer.configure({ expiresIn: null });
        const session = yield* connect("Synthetic Salesforce-style account");
        yield* list();
        const beforeExpiry = yield* refreshes;
        yield* expectRead(0);
        yield* expectRead(0);
        expect(yield* refreshes, "An unstated lifetime is not renewed ahead").toBe(beforeExpiry);
        yield* issuer.expireAccessTokens;
        const reads = (yield* issuer.metrics).resourceRequests.GET;
        const renewed = beforeExpiry + 1;
        yield* expectRead(renewed);
        expect(yield* refreshes).toBe(renewed);
        expect((yield* issuer.metrics).resourceRequests.GET).toBe(reads + 2);
        yield* expectRead(renewed);
        expect(yield* refreshes).toBe(renewed);

        yield* issuer.expireAccessTokens;
        const posts = (yield* issuer.metrics).resourceRequests.POST;
        const write = api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/tools/call`, {
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
          account: { id: session },
        });
        assertPrivate(refused.body);
        expect((yield* issuer.metrics).resourceRequests.POST).toBe(posts + 1);
        expect(yield* refreshes).toBe(renewed + 1);
        const written = yield* write;
        expect(written.status, JSON.stringify(written.body)).toBe(200);
        expect(yield* body(Read, written)).toEqual({ service: presented(renewed + 1) });
        expect(yield* refreshes).toBe(renewed + 1);

        yield* issuer.expireAccessTokens;
        yield* issuer.configure({ tokenError: refreshFailures.invalid_grant });
        const ended = yield* read();
        expect(ended.status, JSON.stringify(ended.body)).toBe(409);
        expect(yield* body(Failure, ended)).toMatchObject({
          _tag: "OAuthReconnectRequired",
          account: session,
          cause: { stage: "refresh", status: 400, providerError: "invalid_grant" },
        });
        yield* issuer.configure({ tokenError: null, expiresIn: 20 });
        const stillEnded = yield* read();
        expect(stillEnded.status, JSON.stringify(stillEnded.body)).toBe(409);
        expect(yield* refreshes).toBe(renewed + 2);
      }),
    ),
  );
  it.effect(scenarios.oauthUnconfirmedReadRenewal.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { issuer, name, deploy, app, connect, read, list, refreshes, assertPrivate } =
          yield* renewalFixture;
        yield* issuer.configure({ expiresIn: null });
        const refusedOnce = (appId: string, session: string, declared: boolean) =>
          Effect.gen(function* () {
            yield* issuer.expireAccessTokens;
            const before = yield* refreshes;
            const gets = (yield* issuer.metrics).resourceRequests.GET;
            const refused = yield* read(appId);
            expect(refused.status, JSON.stringify(refused.body)).toBe(502);
            expect(refused.body).toMatchObject({
              _tag: "AppProviderFailed",
              reason: "unauthorized",
              status: 401,
              credentialsRenewed: true,
              account: { id: session },
            });
            if (declared) expect(refused.body).not.toHaveProperty("mayHaveWritten");
            else
              expect(refused.body).toMatchObject({
                mayHaveWritten: true,
                recovery: { action: unknownOutcomeAction },
              });
            assertPrivate(refused.body);
            expect(yield* refreshes).toBe(before + 1);
            expect((yield* issuer.metrics).resourceRequests.GET).toBe(gets + 1);
            const next = yield* read(appId);
            expect(next.status, JSON.stringify(next.body)).toBe(200);
            expect(yield* body(Read, next)).toEqual({ service: presented(before + 1) });
            expect(yield* refreshes).toBe(before + 1);
            expect((yield* issuer.metrics).resourceRequests.GET).toBe(gets + 2);
          });

        const session = yield* connect("Synthetic unlisted account");
        yield* refusedOnce(app.id, session, false);

        const legacy = yield* deploy(`${name} beta.95`, ["service"], {
          path: "package.json",
          content: JSON.stringify({ dependencies: { apps: "0.0.1-beta.95" } }),
        });
        const legacySession = yield* connect("Synthetic beta.95 account", legacy.id);
        yield* list(legacy.id);
        yield* refusedOnce(legacy.id, legacySession, true);

        yield* list();
        yield* issuer.expireAccessTokens;
        const before = yield* refreshes;
        const gets = (yield* issuer.metrics).resourceRequests.GET;
        const repeated = yield* read();
        expect(repeated.status, JSON.stringify(repeated.body)).toBe(200);
        expect(yield* body(Read, repeated)).toEqual({ service: presented(before + 1) });
        expect((yield* issuer.metrics).resourceRequests.GET).toBe(gets + 2);
      }),
    ),
  );
  it.effect(scenarios.oauthRenewalFailedAfterWrite.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, issuer, prefix, name, connect, list, refreshes, assertPrivate } =
          yield* renewalFixture;
        const records = yield* recordingService;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `${name} records`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, oauth2, query, mutation, object, string, router, ProviderError } from "apps";
const service = defineProvider({ name: ${JSON.stringify(`${name} records`)}, auth: { oauth: oauth2({ discover: ${JSON.stringify(`${issuer.origin}/mcp`)} }) } });
const records = ${JSON.stringify(records.url)};
async function present(fetch, account, method) {
  const response = await fetch(${JSON.stringify(`${issuer.origin}/resource`)}, { method, headers: { authorization: "Bearer " + account.fields.access_token } });
  if (response.status === 401) throw new ProviderError({ reason: "unauthorized", status: 401, accountId: account.id });
  return await response.json();
}
export default defineApp({ user: { accounts: { service } } }, async ({ user: { accounts } }) => ({
  tools: router({
    save: mutation({ input: object({ name: string() }) }, async ({ fetch }, { name }) => {
      await fetch(records + "/records?pending", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
      await present(fetch, accounts.service, "POST");
      return { saved: name };
    }),
    check: query({ input: object({}) }, async ({ fetch }) => present(fetch, accounts.service, "GET")),
    records: query({ input: object({}) }, async ({ fetch }) => (await fetch(records + "/records")).json()),
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
        const call = (tool: string, kind: string, input: object) =>
          api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/tools/call`, {
            tool,
            kind,
            input,
          });
        const saved = () =>
          call("records", "query", {}).pipe(
            Effect.flatMap((response) =>
              body(Schema.Struct({ records: Schema.Array(Schema.String) }), response),
            ),
            Effect.map(({ records }) => records),
          );

        yield* issuer.configure({ expiresIn: null });
        const session = yield* connect("Synthetic records account", app.id);
        yield* list(app.id);
        yield* issuer.expireAccessTokens;
        yield* issuer.configure({ tokenError: refreshFailures.unavailable });

        const beforeWrite = yield* refreshes;
        const posts = (yield* issuer.metrics).resourceRequests.POST;
        const written = yield* call("save", "mutation", { name: "first" });
        expect(written.status, JSON.stringify(written.body)).toBe(502);
        expect(written.body).toMatchObject({
          _tag: "AppProviderFailed",
          reason: "unauthorized",
          status: 401,
          account: { id: session },
          mayHaveWritten: true,
          renewalFailure: {
            _tag: "OAuthRenewalFailed",
            account: session,
            reason: "service_unavailable",
          },
          recovery: { action: unknownOutcomeAction },
        });
        const failed = yield* body(
          Schema.Struct({
            message: Schema.String,
            recovery: Schema.Struct({ action: Schema.String, instructions: Schema.String }),
          }),
          written,
        );
        expect(failed.message).toBe(
          `${name} records rejected the credentials for account “Synthetic records account” (HTTP 401) while calling a tool. Renewing the account’s access failed: Executor could not renew this account’s access. The sign-in endpoint may be unavailable or unreachable. The saved sign-in is kept; this error does not require reconnecting.`,
        );
        expectUnknownOutcome(failed.recovery);
        expect(failed.recovery).toEqual(unknownOutcomeRecovery(renewalInsideWrite));
        assertPrivate(written.body);
        expect(yield* refreshes).toBe(beforeWrite + 1);
        expect((yield* issuer.metrics).resourceRequests.POST).toBe(posts + 1);
        expect(yield* saved()).toEqual([]);
        yield* records.commit;
        expect(yield* saved()).toEqual(["first"]);

        const checked = yield* call("check", "query", {});
        expect(checked.status, JSON.stringify(checked.body)).toBe(502);
        expect(checked.body).toMatchObject({
          _tag: "OAuthRenewalFailed",
          account: session,
          reason: "service_unavailable",
          recovery: {
            action: "Try again in a moment. If this continues, check the service’s status.",
          },
        });
        expect(checked.body).not.toHaveProperty("mayHaveWritten");
        assertPrivate(checked.body);

        yield* issuer.configure({ tokenError: refreshFailures.rate_limited });
        const limited = yield* call("save", "mutation", { name: "second" });
        expect(limited.status, JSON.stringify(limited.body)).toBe(502);
        expect(limited.body).toMatchObject({
          _tag: "AppProviderFailed",
          mayHaveWritten: true,
          renewalFailure: { _tag: "OAuthRenewalFailed", reason: "rate_limited" },
          recovery: { action: unknownOutcomeAction },
        });
        const { recovery: limitedRecovery } = yield* body(
          Schema.Struct({
            recovery: Schema.Struct({ action: Schema.String, instructions: Schema.String }),
          }),
          limited,
        );
        expectUnknownOutcome(limitedRecovery);
        expect(limitedRecovery).toEqual(unknownOutcomeRecovery(renewalInsideWrite));
        assertPrivate(limited.body);
        yield* issuer.configure({ tokenError: null, expiresIn: 20 });
      }),
    ),
  );
  it.effect(scenarios.oauthUnnamedKindRenewal.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, issuer, prefix, name, connect, refreshes, assertPrivate } =
          yield* renewalFixture;
        const telemetry = yield* Telemetry;
        const records = yield* recordingService;
        for (const [mode, database] of [
          ["worker", false],
          ["facet", true],
        ] as const) {
          const marker = `factory-${mode}`;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `${name} ${mode} factory`,
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, defineProvider, oauth2, query, mutation, object, router, ProviderError } from "apps";
const service = defineProvider({ name: ${JSON.stringify(`${name} ${mode} factory`)}, auth: { oauth: oauth2({ discover: ${JSON.stringify(`${issuer.origin}/mcp`)} }) } });
export default defineApp({ user: { accounts: { service } } }, async ({ user: { accounts }, signal }) => {
  await fetch(${JSON.stringify(`${records.url}/records`)}, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ name: ${JSON.stringify(marker)} }) });
  const response = await fetch(${JSON.stringify(`${issuer.origin}/resource`)}, { signal, headers: { authorization: "Bearer " + accounts.service.fields.access_token } });
  if (response.status === 401) throw new ProviderError({ reason: "unauthorized", status: 401, accountId: accounts.service.id });
  const presented = await response.json();
  return { tools: router({
    save: mutation({ input: object({}) }, async () => ({ saved: true })),
    check: query({ input: object({}) }, async () => presented),
  }) };
});`,
              },
              appsManifest,
              ...databaseFiles(database),
            ],
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const app = yield* body(AppProvider, deployed);
          yield* Effect.addFinalizer(() =>
            api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
          );
          const call = (tool: string, kind?: string) =>
            api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/tools/call`, {
              tool,
              ...(kind === undefined ? {} : { kind }),
              input: {},
            });
          const factoryWrites = records.saved.pipe(
            Effect.map((saved) => saved.filter((record) => record === marker).length),
          );

          yield* issuer.configure({ expiresIn: null });
          const session = yield* connect(`Synthetic ${mode} factory account`, app.id);
          yield* issuer.expireAccessTokens;

          yield* issuer.configure({ tokenError: refreshFailures.unavailable });
          const beforeFailure = { writes: yield* factoryWrites, refreshes: yield* refreshes };
          const failed = yield* call("save");
          expect(failed.status, JSON.stringify(failed.body)).toBe(502);
          expect(failed.body, mode).toMatchObject({
            _tag: "AppProviderFailed",
            reason: "unauthorized",
            status: 401,
            account: { id: session },
            mayHaveWritten: true,
            renewalFailure: {
              _tag: "OAuthRenewalFailed",
              account: session,
              reason: "service_unavailable",
            },
          });
          const { recovery: failedRecovery } = yield* body(
            Schema.Struct({
              recovery: Schema.Struct({ action: Schema.String, instructions: Schema.String }),
            }),
            failed,
          );
          expectUnknownOutcome(failedRecovery);
          expect(failedRecovery).toEqual(unknownOutcomeRecovery(renewalInsideWrite));
          assertPrivate(failed.body);
          expect(yield* factoryWrites, mode).toBe(beforeFailure.writes + 1);
          expect(yield* refreshes).toBe(beforeFailure.refreshes + 1);

          yield* issuer.configure({ tokenError: null });
          const beforeRenewal = { writes: yield* factoryWrites, refreshes: yield* refreshes };
          const renewed = yield* call("save");
          expect(renewed.status, JSON.stringify(renewed.body)).toBe(502);
          expect(renewed.body, mode).toMatchObject({
            _tag: "AppProviderFailed",
            reason: "unauthorized",
            credentialsRenewed: true,
            mayHaveWritten: true,
          });
          const renewedFailure = yield* body(
            Schema.Struct({
              message: Schema.String,
              recovery: Schema.Struct({ action: Schema.String, instructions: Schema.String }),
            }),
            renewed,
          );
          expect(renewedFailure.message).toContain(
            "Access was restored. This call was not repeated; earlier steps may have changed data. Check the result and retry only if the user chooses.",
          );
          expectUnknownOutcome(renewedFailure.recovery);
          assertPrivate(renewed.body);
          expect(yield* factoryWrites, mode).toBe(beforeRenewal.writes + 1);
          expect(yield* refreshes).toBe(beforeRenewal.refreshes + 1);
          const saved = yield* call("save");
          expect(saved.status, JSON.stringify(saved.body)).toBe(200);
          expect(yield* refreshes).toBe(beforeRenewal.refreshes + 1);

          yield* issuer.expireAccessTokens;
          const beforeQuery = { writes: yield* factoryWrites, refreshes: yield* refreshes };
          const checked = yield* call("check", "query");
          expect(checked.status, JSON.stringify(checked.body)).toBe(200);
          expect(checked.body, mode).toEqual(presented(beforeQuery.refreshes + 1));
          expect(yield* refreshes).toBe(beforeQuery.refreshes + 1);
          expect(yield* factoryWrites, mode).toBe(beforeQuery.writes + 2);
          yield* issuer.configure({ tokenError: null, expiresIn: 20 });
          yield* telemetry
            .spans("runtime.app.build.load", { app: app.id }, { "executor.runtime.mode": mode })
            .pipe(
              Effect.flatMap((spans) =>
                spans.length > 0
                  ? Effect.void
                  : Effect.fail(new Error(`Missing ${mode} build load`)),
              ),
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 80 }),
            );
        }
      }),
    ),
  );
  it.effect(scenarios.oauthListingRenewalOnRefusal.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, issuer, prefix, name, connect, refreshes, assertPrivate } =
          yield* renewalFixture;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `${name} catalog`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, oauth2, query, object, router, ProviderError } from "apps";
const service = defineProvider({ name: ${JSON.stringify(`${name} catalog`)}, auth: { oauth: oauth2({ discover: ${JSON.stringify(`${issuer.origin}/mcp`)} }) } });
export default defineApp({ user: { accounts: { service } } }, async ({ user: { accounts }, signal }) => {
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
        const list = () => api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/tools`);
        const reads = issuer.metrics.pipe(Effect.map((metrics) => metrics.resourceRequests.GET));

        yield* issuer.configure({ expiresIn: null });
        const session = yield* connect("Synthetic catalog account", app.id);
        yield* issuer.expireAccessTokens;

        yield* issuer.configure({ tokenError: refreshFailures.unavailable });
        const beforeOutage = yield* refreshes;
        const outage = yield* list();
        expect(outage.status, JSON.stringify(outage.body)).toBe(502);
        expect(outage.body).toMatchObject({
          _tag: "OAuthRenewalFailed",
          account: session,
          reason: "service_unavailable",
        });
        assertPrivate(outage.body);
        expect(yield* refreshes).toBe(beforeOutage + 1);
        yield* issuer.configure({ tokenError: null });

        const beforeRenewal = yield* reads;
        const renewed = (yield* refreshes) + 1;
        const listed = yield* list();
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        expect((yield* body(Listing, listed)).items).toEqual([
          { name: "read", description: JSON.stringify(presented(renewed)) },
        ]);
        expect(yield* refreshes).toBe(renewed);
        expect(yield* reads).toBe(beforeRenewal + 2);
        const kept = yield* list();
        expect(kept.status, JSON.stringify(kept.body)).toBe(200);
        expect((yield* body(Listing, kept)).items).toEqual([
          { name: "read", description: JSON.stringify(presented(renewed)) },
        ]);
        expect(yield* refreshes).toBe(renewed);
        expect(yield* reads).toBe(beforeRenewal + 2);

        const ending = yield* connect("Synthetic ending catalog account", app.id);
        yield* issuer.expireAccessTokens;
        yield* issuer.configure({ tokenError: refreshFailures.invalid_grant });
        const beforeEnd = yield* refreshes;
        const ended = yield* list();
        expect(ended.status, JSON.stringify(ended.body)).toBe(409);
        expect(ended.body).toMatchObject({
          _tag: "OAuthReconnectRequired",
          account: ending,
        });
        assertPrivate(ended.body);
        expect(yield* refreshes).toBe(beforeEnd + 1);
        yield* issuer.configure({ tokenError: null, expiresIn: 20 });
        const stillEnded = yield* list();
        expect(stillEnded.status, JSON.stringify(stillEnded.body)).toBe(409);
        expect(stillEnded.body).toMatchObject({
          _tag: "OAuthReconnectRequired",
          account: ending,
        });
        expect(yield* refreshes).toBe(beforeEnd + 1);
      }),
    ),
  );
});
