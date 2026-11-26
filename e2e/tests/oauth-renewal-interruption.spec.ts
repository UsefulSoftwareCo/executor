import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Exit, Fiber, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { serverControl } from "../support/server-control.ts";
import { settleWebhookSources } from "../support/webhook-sources.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";
import { connectionsPath } from "../support/app-accounts.ts";

const AppProvider = Schema.Struct({ id: Schema.String });
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
});
const callers = 4;
const executeDeadline = 30_000;
const slowResponse = 27_000;
const pastLease = 21_000;
const recoveredLifetime = 120;
const intoRenewalWindow = 100_000;

const restartAfterKill = Effect.gen(function* () {
  for (let attempt = 1; ; attempt++) {
    const started = yield* Effect.exit(serverControl("start"));
    if (Exit.isSuccess(started)) return;
    if (attempt === 20) return yield* started;
    yield* Effect.sleep("1 second");
  }
});

const resolveSpans = (count: number) =>
  Effect.gen(function* () {
    const evidence = yield* Evidence,
      telemetry = yield* Telemetry;
    const traces = (yield* evidence.requests).slice(-count).map(({ traceId }) => traceId);
    const resolves = yield* Effect.forEach(traces, (traceId) =>
      telemetry.query(traceId).pipe(
        Effect.map((result) => {
          const spans = result.data.map(({ span }) => span);
          return spans.flatMap((resolve) =>
            resolve.operationName === "oauth.resolve"
              ? [
                  {
                    resolve,
                    renewals: spans.filter(
                      (span) =>
                        span.operationName === "oauth.renewal" &&
                        span.parentSpanId === resolve.spanId,
                    ),
                  },
                ]
              : [],
          );
        }),
        Effect.filterOrFail(
          (resolves) => resolves.length > 0,
          () => new Error("Call trace has not arrived"),
        ),
        Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 40 }),
      ),
    );
    return resolves.flat();
  });

const recordedAt = (
  renewal: { tags: Record<string, string> },
  resolve: { startTime: string; durationMs: number },
  attribute: string,
  context: string,
) => {
  const at = Number(renewal.tags[attribute]);
  const start = Date.parse(resolve.startTime);
  expect(at, `${context}: ${attribute}`).toBeGreaterThanOrEqual(start);
  expect(at, `${context}: ${attribute}`).toBeLessThanOrEqual(
    start + Math.ceil(resolve.durationMs) + 1,
  );
  return at;
};

const rotatingAccount = (
  replacedRefreshTokens: "refused" | "accepted",
  user: "owner" | "member" = "owner",
) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      evidence = yield* Evidence,
      http = yield* HttpClient.HttpClient;
    const caller = actors[user];
    const issuer = yield* oauthSetupIssuer;
    const prefix = `/api/organizations/${actors.organization.id}`;
    yield* issuer.configure({
      refreshTokens: true,
      rotateRefreshTokens: true,
      replacedRefreshTokens,
      expiresIn: 20,
    });
    const name = `Rotating ${randomUUID().slice(0, 8)}`;
    const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name,
      files: [
        {
          path: "index.ts",
          content: `import { defineApp, defineProvider, oauth2, query, object, router, ProviderError } from "apps";
const service = defineProvider({ name: ${JSON.stringify(name)}, auth: { oauth: oauth2({ discover: ${JSON.stringify(`${issuer.origin}/mcp`)} }) } });
export default defineApp({ user: { accounts: { service } } }, async ({ user: { accounts } }) => ({
  tools: router({
    read: query({ input: object({}) }, async ({ fetch }) => {
      const response = await fetch(${JSON.stringify(`${issuer.origin}/resource`)}, { headers: { authorization: "Bearer " + accounts.service.fields.access_token } });
      if (response.status === 401) throw new ProviderError({ reason: "unauthorized", status: 401, accountId: accounts.service.id });
      return { service: await response.json() };
    }),
  }),
}));`,
        },
        appsManifest,
      ],
    });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const app = yield* body(AppProvider, deployed);
    const appPath = `${prefix}/apps/${app.id}`;
    const audience = (kind: "everyone" | "private") =>
      Effect.gen(function* () {
        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${appPath}/access`),
        );
        const changed = yield* api.request(actors.owner, "PATCH", `${appPath}/access`, {
          revision: access.revision,
          audience: { kind },
        });
        expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      });
    if (user === "member") yield* audience("everyone");

    const connection = yield* body(
      Resource,
      yield* api.request(caller, "POST", connectionsPath(appPath, "user", "service"), {}),
    );
    const started = yield* api.request(
      caller,
      "POST",
      `${prefix}/connections/${connection.id}/oauth/start`,
      { method: "oauth", label: "Synthetic rotating account" },
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
      caller,
      "POST",
      `${prefix}/connections/${connection.id}/oauth/complete`,
      { callbackUrl },
    );
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    const account = yield* body(Resource, completed);
    yield* settleWebhookSources(caller, appPath, (sources) =>
      sources.some((source) => source.account === account.id && source.status !== "pending"),
    );

    const read = api.request(caller, "POST", `${appPath}/tools/call`, {
      tool: "read",
      input: {},
    });
    const metrics = issuer.metrics;
    const renewed =
      (context: string) => (response: { readonly status: number; readonly body: unknown }) =>
        Effect.gen(function* () {
          expect(response.status, `${context}: ${JSON.stringify(response.body)}`).toBe(200);
          const result = yield* body(Read, response);
          expect(result.service.refreshed, context).toBe(true);
          return result.service.authorization;
        });
    const heldBeyond = (before: number, context: string) =>
      metrics.pipe(
        Effect.flatMap((current) =>
          current.held > before
            ? Effect.void
            : Effect.fail(new Error(`${context}: no renewal reached the issuer`)),
        ),
        Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 400 }),
      );
    const concurrentReads = (context: string) =>
      Effect.forEach(
        Array.from({ length: callers }),
        () =>
          Effect.gen(function* () {
            const sent = yield* Clock.currentTimeMillis;
            const response = yield* read.pipe(Effect.timeoutOption(executeDeadline));
            if (response._tag === "None")
              return yield* Effect.fail(
                new Error(`${context}: a call did not settle within the execute deadline`),
              );
            return { response: response.value, elapsed: (yield* Clock.currentTimeMillis) - sent };
          }),
        { concurrency: callers },
      ).pipe(
        Effect.tap((calls) =>
          evidence.json(
            `${context.replaceAll(/[^a-z0-9]+/gi, "-")}.json`,
            calls.map(({ response, elapsed }) => ({
              status: response.status,
              elapsed,
              body: response.body,
            })),
          ),
        ),
        Effect.tap((calls) =>
          Effect.sync(() => {
            for (const { response } of calls)
              for (const marker of ["synthetic-refresh-", "synthetic-client-secret"])
                expect(JSON.stringify(response.body), context).not.toContain(marker);
          }),
        ),
      );
    const newestTokenSaved = (context: string, previous: string | null) =>
      Effect.gen(function* () {
        yield* issuer.configure({ replacedRefreshTokens: "refused" });
        const before = yield* metrics;
        const next = yield* renewed(context)(yield* read);
        expect(next, context).not.toBe(previous);
        expect((yield* metrics).refreshesIssued, context).toBe(before.refreshesIssued + 1);
      });

    yield* renewed("healthy renewal")(yield* read);
    return {
      issuer,
      metrics,
      audience,
      read,
      renewed,
      heldBeyond,
      concurrentReads,
      newestTokenSaved,
      account,
    };
  });

type KillPoint =
  | "before the service processes the renewal"
  | "after the service rotates the token, before Executor saves it"
  | "after Executor saves the renewal";

const killedAndRestarted = (point: KillPoint, replacedRefreshTokens: "refused" | "accepted") =>
  Effect.gen(function* () {
    const {
      issuer,
      metrics,
      read,
      renewed,
      heldBeyond,
      concurrentReads,
      newestTokenSaved,
      account,
    } = yield* rotatingAccount(replacedRefreshTokens);

    yield* issuer.configure({
      hold:
        point === "before the service processes the renewal"
          ? "refresh-unprocessed"
          : point === "after the service rotates the token, before Executor saves it"
            ? "refresh-issued"
            : "resource",
    });
    const before = yield* metrics;
    const interrupted = yield* Effect.forkChild(read.pipe(Effect.exit));
    yield* heldBeyond(before.held, point);
    const atKill = yield* metrics;
    expect(atKill.refreshesIssued - before.refreshesIssued, point).toBe(
      point === "before the service processes the renewal" ? 0 : 1,
    );
    yield* serverControl("kill");
    expect(Exit.isFailure(yield* Fiber.join(interrupted)), point).toBe(true);
    yield* issuer.configure({ hold: null });
    yield* issuer.release;
    yield* restartAfterKill;

    const after = yield* metrics;
    const calls = yield* concurrentReads(point);
    const settled = yield* metrics;
    for (const { response, elapsed } of calls)
      expect(elapsed, `${point}: ${JSON.stringify(response.body)}`).toBeLessThan(executeDeadline);
    const responses = calls.map(({ response }) => response);
    const resolves = yield* resolveSpans(callers);
    const attempts = resolves.flatMap(({ resolve, renewals }) =>
      renewals.map((renewal) => ({ resolve, renewal })),
    );
    expect(attempts.length, point).toBe(1);
    const [attempt] = attempts;
    if (attempt === undefined) return yield* Effect.die(`${point}: no renewal attempt`);
    const renewal = attempt.renewal.tags;
    expect(renewal, point).toMatchObject({
      "executor.account.id": account.id,
      "executor.account.credential_generation": "0",
      "executor.account.credential_generation_source": "grant",
    });
    const claimedAt = recordedAt(
      attempt.renewal,
      attempt.resolve,
      "oauth.renewal.claimed_at_ms",
      point,
    );
    expect(renewal["oauth.renewal.lost_claim_result"], point).toBeUndefined();
    if (point === "after Executor saves the renewal")
      expect(renewal, point).toMatchObject({ "oauth.renewal.takeover": "false" });
    else {
      expect(renewal, point).toMatchObject({ "oauth.renewal.takeover": "true" });
      const unconfirmed = Number(renewal["oauth.renewal.abandoned_claim_age_ms"]);
      expect(unconfirmed, point).toBeGreaterThan(20_000);
      expect(Number(renewal["oauth.renewal.takeover_expired_ms"]), point).toBe(
        unconfirmed - 20_000,
      );
      expect(attempt.resolve.tags["oauth.renewal.abandoned_claim_age_ms"], point).toBe(
        renewal["oauth.renewal.abandoned_claim_age_ms"],
      );
    }

    if (
      point === "after the service rotates the token, before Executor saves it" &&
      replacedRefreshTokens === "refused"
    ) {
      expect(settled.refreshes - after.refreshes, point).toBe(1);
      expect(settled.refreshesIssued, point).toBe(after.refreshesIssued);
      const failures = yield* Effect.forEach(responses, (response) =>
        Effect.gen(function* () {
          expect(response.status, `${point}: ${JSON.stringify(response.body)}`).toBe(409);
          return yield* body(Failure, response);
        }),
      );
      for (const failure of failures)
        expect(failure, point).toMatchObject({
          _tag: "OAuthReconnectRequired",
          account: account.id,
        });
      expect(
        failures.filter((failure) => failure.reason === "renewal_interrupted"),
        point,
      ).toEqual([
        {
          _tag: "OAuthReconnectRequired",
          account: account.id,
          reason: "renewal_interrupted",
          cause: { stage: "refresh", status: 400, providerError: "invalid_grant" },
        },
      ]);
      expect(attempt.resolve.tags, point).toMatchObject({
        "oauth.renewal.outcome": "reconnect",
        "oauth.reconnect.reason": "renewal_interrupted",
      });
      expect(renewal, point).toMatchObject({
        "oauth.reconnect.reason": "renewal_interrupted",
        "oauth.error.provider_code": "invalid_grant",
      });
      expect(
        recordedAt(attempt.renewal, attempt.resolve, "oauth.reconnect.at_ms", point),
        point,
      ).toBeGreaterThanOrEqual(claimedAt);
      for (const { resolve } of resolves)
        expect(resolve.tags, point).toMatchObject({ "oauth.resolve.outcome": "reconnect" });
      const again = yield* read;
      expect(again.status, JSON.stringify(again.body)).toBe(409);
      expect((yield* metrics).refreshes, point).toBe(settled.refreshes);
      return;
    }

    expect(attempt.resolve.tags, point).toMatchObject({ "oauth.renewal.outcome": "renewed" });
    expect(renewal["oauth.reconnect.reason"], point).toBeUndefined();
    const tokens = yield* Effect.forEach(responses, renewed(point));
    expect(new Set(tokens).size, point).toBe(1);
    expect(settled.refreshesIssued - after.refreshesIssued, point).toBe(1);
    yield* newestTokenSaved(point, tokens[0] ?? null);
  });

const slowLiveRenewal = Effect.gen(function* () {
  const context = "slow live renewal";
  const { issuer, metrics, read, renewed, heldBeyond, newestTokenSaved, account } =
    yield* rotatingAccount("refused");
  yield* issuer.configure({ hold: "refresh-issued" });
  const before = yield* metrics;
  const holder = yield* Effect.forkChild(read);
  yield* heldBeyond(before.held, context);
  const waiting = yield* Effect.forkChild(
    Effect.forEach(Array.from({ length: callers }), () => read, { concurrency: callers }),
  );
  yield* Effect.sleep(slowResponse);
  const atRelease = yield* metrics;
  expect(atRelease.refreshes - before.refreshes, context).toBe(1);
  expect(atRelease.held - before.held, context).toBe(1);
  yield* issuer.configure({ hold: null });
  yield* issuer.release;
  const responses = [yield* Fiber.join(holder), ...(yield* Fiber.join(waiting))];
  const tokens = yield* Effect.forEach(responses, renewed(context));
  expect(new Set(tokens).size, context).toBe(1);
  expect((yield* metrics).refreshesIssued - before.refreshesIssued, context).toBe(1);
  const resolves = yield* resolveSpans(callers + 1);
  const attempts = resolves.flatMap(({ resolve, renewals }) =>
    renewals.map((renewal) => ({ resolve, renewal })),
  );
  expect(
    attempts.map(({ renewal }) => renewal.tags),
    context,
  ).toEqual([
    expect.objectContaining({
      "executor.account.id": account.id,
      "executor.account.credential_generation": "0",
      "executor.account.credential_generation_source": "grant",
      "oauth.renewal.takeover": "false",
    }),
  ]);
  for (const { resolve, renewal } of attempts) {
    expect(resolve.tags, context).toMatchObject({ "oauth.renewal.outcome": "renewed" });
    expect(renewal.tags["oauth.renewal.lost_claim_result"], context).toBeUndefined();
    recordedAt(renewal, resolve, "oauth.renewal.claimed_at_ms", context);
  }
  yield* newestTokenSaved(context, tokens[0] ?? null);
});

const appAccessEndsDuringRenewal = Effect.gen(function* () {
  const context = "app access ends during a renewal";
  const { issuer, metrics, audience, read, heldBeyond } = yield* rotatingAccount(
    "refused",
    "member",
  );
  yield* issuer.configure({ hold: "refresh-issued" });
  const before = yield* metrics;
  const call = yield* Effect.forkChild(read);
  yield* heldBeyond(before.held, context);
  yield* audience("private");
  yield* issuer.configure({ hold: null });
  yield* issuer.release;
  const response = yield* Fiber.join(call);
  expect(response.status, `${context}: ${JSON.stringify(response.body)}`).not.toBe(200);
  const after = yield* metrics;
  expect(after.refreshesIssued - before.refreshesIssued, context).toBe(1);
  expect(after.resourceRequests, context).toEqual(before.resourceRequests);

  const refusal = "app access ends during a renewal after a refused token";
  yield* audience("everyone");
  yield* issuer.configure({ expiresIn: null });
  expect((yield* read).status, refusal).toBe(200);
  expect((yield* read).status, refusal).toBe(200);
  yield* issuer.expireAccessTokens;
  yield* issuer.configure({ hold: "refresh-issued" });
  const refused = yield* metrics;
  const retried = yield* Effect.forkChild(read);
  yield* heldBeyond(refused.held, refusal);
  yield* audience("private");
  yield* issuer.configure({ hold: null });
  yield* issuer.release;
  const repeated = yield* Fiber.join(retried);
  expect(repeated.status, `${refusal}: ${JSON.stringify(repeated.body)}`).not.toBe(200);
  const settled = yield* metrics;
  expect(settled.refreshesIssued - refused.refreshesIssued, refusal).toBe(1);
  expect(settled.resourceRequests.GET - refused.resourceRequests.GET, refusal).toBe(1);
});

const callerDisconnects = Effect.gen(function* () {
  const context = "caller disconnects mid-renewal";
  const { issuer, metrics, read, renewed, heldBeyond, concurrentReads, newestTokenSaved } =
    yield* rotatingAccount("refused");
  yield* issuer.configure({ hold: "refresh-issued" });
  const before = yield* metrics;
  const caller = yield* Effect.forkChild(read);
  yield* heldBeyond(before.held, context);
  yield* Fiber.interrupt(caller);
  yield* Effect.sleep("1 second");
  const waiting = yield* Effect.forkChild(concurrentReads(context));
  yield* Effect.sleep("1 second");
  yield* issuer.configure({ hold: null });
  yield* issuer.release;
  const calls = yield* Fiber.join(waiting);
  for (const { response, elapsed } of calls)
    expect(elapsed, `${context}: ${JSON.stringify(response.body)}`).toBeLessThan(executeDeadline);
  const tokens = yield* Effect.forEach(
    calls.map(({ response }) => response),
    renewed(context),
  );
  expect(new Set(tokens).size, context).toBe(1);
  const settled = yield* metrics;
  expect(settled.refreshes - before.refreshes, context).toBe(1);
  expect(settled.refreshesIssued - before.refreshesIssued, context).toBe(1);
  yield* newestTokenSaved(context, tokens[0] ?? null);
});

const crashedRecoveries = (recoveries: number, context: string) =>
  Effect.gen(function* () {
    const renewal = yield* rotatingAccount("refused");
    const { issuer, metrics, read, renewed, heldBeyond, concurrentReads } = renewal;
    const start = yield* metrics;
    yield* issuer.configure({ hold: "refresh-unprocessed" });
    for (let cycle = 1; cycle <= recoveries + 1; cycle++) {
      const before = yield* metrics;
      const pending = yield* Effect.forkChild(
        Effect.forEach(
          Array.from({ length: cycle === 1 ? 1 : callers }),
          () => read.pipe(Effect.exit),
          {
            concurrency: callers,
          },
        ),
      );
      yield* heldBeyond(before.held, `${context} ${cycle}`);
      yield* Effect.sleep("500 millis");
      expect((yield* metrics).held - before.held, `${context} ${cycle}`).toBe(1);
      yield* serverControl("kill");
      for (const exit of yield* Fiber.join(pending))
        expect(Exit.isFailure(exit), `${context} ${cycle}`).toBe(true);
      yield* issuer.release;
      yield* serverControl("clock/advance", 200, { milliseconds: pastLease });
      yield* serverControl("start");
    }
    const outage = yield* metrics;
    const failing = yield* Effect.forkChild(read);
    yield* heldBeyond(outage.held, `${context} outage`);
    yield* issuer.configure({ hold: null });
    yield* issuer.release;
    const failed = yield* Fiber.join(failing);
    expect(failed.status, JSON.stringify(failed.body)).toBe(502);
    expect(yield* body(Failure, failed), context).toMatchObject({
      _tag: "OAuthRenewalFailed",
      reason: "service_unavailable",
      cause: { stage: "refresh", status: 503 },
    });
    yield* issuer.configure({ refreshedExpiresIn: recoveredLifetime });
    const after = yield* metrics;
    const calls = yield* concurrentReads(context);
    const tokens = yield* Effect.forEach(
      calls.map(({ response }) => response),
      renewed(context),
    );
    expect(new Set(tokens).size, context).toBe(1);
    expect((yield* metrics).refreshesIssued - after.refreshesIssued, context).toBe(1);
    expect(after.refreshesIssued, context).toBe(start.refreshesIssued);
    return { ...renewal, recovered: tokens[0] ?? null };
  });

const diesAgainDuringRecovery = crashedRecoveries(1, "dies again during recovery");

const recoveredGrantKeepsNewestToken = Effect.gen(function* () {
  const context = "recovered grant keeps newest token";
  const { issuer, newestTokenSaved, recovered } = yield* crashedRecoveries(0, context);
  yield* serverControl("stop");
  yield* serverControl("clock/advance", 200, { milliseconds: intoRenewalWindow });
  yield* serverControl("start");
  yield* issuer.configure({ refreshedExpiresIn: null });
  yield* newestTokenSaved(context, recovered);
});

layer(HostedLive, { excludeTestServices: true })("OAuth renewal interruption", (it) => {
  it.effect(scenarios.oauthRenewalKilledBeforeProvider.title, (context) =>
    withHostedCase(
      context,
      killedAndRestarted("before the service processes the renewal", "refused"),
    ),
  );
  it.effect(scenarios.oauthRenewalKilledAfterRotation.title, (context) =>
    withHostedCase(
      context,
      killedAndRestarted(
        "after the service rotates the token, before Executor saves it",
        "refused",
      ),
    ),
  );
  it.effect(scenarios.oauthRenewalKilledInReuseWindow.title, (context) =>
    withHostedCase(
      context,
      killedAndRestarted(
        "after the service rotates the token, before Executor saves it",
        "accepted",
      ),
    ),
  );
  it.effect(scenarios.oauthRenewalKilledAfterSave.title, (context) =>
    withHostedCase(context, killedAndRestarted("after Executor saves the renewal", "refused")),
  );
  it.effect(scenarios.oauthRenewalSlowLiveHolder.title, (context) =>
    withHostedCase(context, slowLiveRenewal),
  );
  it.effect(scenarios.oauthRenewalAppAccessEnds.title, (context) =>
    withHostedCase(context, appAccessEndsDuringRenewal),
  );
  it.effect(scenarios.oauthRenewalCallerDisconnects.title, (context) =>
    withHostedCase(context, callerDisconnects),
  );
  it.effect(scenarios.oauthRenewalDiesDuringRecovery.title, (context) =>
    withHostedCase(context, diesAgainDuringRecovery),
  );
  it.effect(scenarios.oauthRenewalRecoveredNewestToken.title, (context) =>
    withHostedCase(context, recoveredGrantKeepsNewestToken),
  );
});
