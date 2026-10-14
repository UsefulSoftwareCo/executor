/**
 * OAuth renewals against a token endpoint that rotates refresh tokens, interrupted the ways a
 * self-hosted Executor under memory pressure interrupts them: the product process is killed and
 * restarted at once while callers keep arriving, killed again during its recovery, or a caller
 * disconnects mid-renewal. A slow but live renewal must keep its claim throughout. Each kill point
 * has a different best outcome: a renewal the service never processed, or whose replaced token it
 * still accepts, is recovered; one whose rotated token was lost with the process is reported as
 * interrupted; one that was saved is simply used.
 */
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
/** Concurrent calls that arrive once the product is back, as a test suite and agents do. */
const callers = 4;
/** An agent's execute call gives up after this long; recovery must finish within it. */
const executeDeadline = 30_000;
/**
 * A token response close to the 30-second token request timeout. Waiters must not take over a
 * live holder this slow, while callers after a restart must still settle within the execute
 * deadline; together these bound the lease from both sides.
 */
const slowResponse = 27_000;
/** Longer than an unconfirmed claim is honoured; advanced only while the product is stopped. */
const pastLease = 21_000;
/** Seconds a recovered token lasts: beyond the host's 30-second renewal window for 90 s. */
const recoveredLifetime = 120;
/** Leaves the recovered token 20 s, inside the renewal window but not yet expired. */
const intoRenewalWindow = 100_000;

/**
 * Start the product again after a kill, as a supervisor's restart policy does. The source host's
 * data directory lock outlives a killed process until it goes stale, about ten seconds later, and
 * a start before then is refused.
 */
const restartAfterKill = Effect.gen(function* () {
  for (let attempt = 1; ; attempt++) {
    const started = yield* Effect.exit(serverControl("start"));
    if (Exit.isSuccess(started)) return;
    if (attempt === 20) return yield* started;
    yield* Effect.sleep("1 second");
  }
});

/**
 * The `oauth.resolve` spans in the traces of the last `count` calls, each with the `oauth.renewal`
 * spans of the renewal attempts it made, once each of those traces has delivered its resolve.
 */
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

/**
 * The time an attribute records, in epoch milliseconds, checked to fall within the resolve that
 * made the attempt: the event's own time, which can be long after the resolve started.
 */
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

/**
 * One rotating OAuth account linked to one app, with a tool that uses its token. The owner
 * deploys the app; `user` connects the account and calls the tool. A member uses an app the owner
 * opened to everyone.
 */
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
    // Tokens issued inside the host's 30-second renewal window renew on every use, and every
    // renewal replaces the refresh token.
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
    /** Open the app to every member, or keep it to its creator, the owner. */
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
    // Linking the account sets it up as the app's webhook source in the background, which
    // resolves, and so may renew, the account. Let it finish so each renewal below belongs to
    // the call the scenario makes.
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
    /** Wait until more token requests are held at the issuer than `before`. */
    const heldBeyond = (before: number, context: string) =>
      metrics.pipe(
        Effect.flatMap((current) =>
          current.held > before
            ? Effect.void
            : Effect.fail(new Error(`${context}: no renewal reached the issuer`)),
        ),
        Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 400 }),
      );
    /** Concurrent calls, each timed from when it was sent. */
    const concurrentReads = (context: string) =>
      Effect.forEach(
        Array.from({ length: callers }),
        () =>
          Effect.gen(function* () {
            const sent = yield* Clock.currentTimeMillis;
            // The agent gives up at its deadline; a call still waiting then has failed.
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
    /**
     * The saved grant holds the service's newest refresh token: the next renewal presents it and
     * the service accepts it even though it refuses replaced tokens.
     */
    const newestTokenSaved = (context: string, previous: string | null) =>
      Effect.gen(function* () {
        yield* issuer.configure({ replacedRefreshTokens: "refused" });
        const before = yield* metrics;
        const next = yield* renewed(context)(yield* read);
        expect(next, context).not.toBe(previous);
        expect((yield* metrics).refreshesIssued, context).toBe(before.refreshesIssued + 1);
      });

    // A healthy renewal first: the rotating grant works before any interruption.
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

/** Where the product process dies during a renewal. */
type KillPoint =
  | "before the service processes the renewal"
  | "after the service rotates the token, before Executor saves it"
  | "after Executor saves the renewal";

/**
 * The process dies at the kill point and restarts at once. Callers arrive while the dead
 * process's claim is still recent, as a test suite and agents keep calling after an
 * out-of-memory restart, and must settle within an execute deadline.
 */
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
    // The process is gone, so the held answer reaches no one; an unprocessed request stays so.
    yield* issuer.configure({ hold: null });
    yield* issuer.release;
    yield* restartAfterKill;

    const after = yield* metrics;
    const calls = yield* concurrentReads(point);
    const settled = yield* metrics;
    for (const { response, elapsed } of calls)
      expect(elapsed, `${point}: ${JSON.stringify(response.body)}`).toBeLessThan(executeDeadline);
    const responses = calls.map(({ response }) => response);
    // Exactly one caller renews, in one attempt with its own span. Unless the dead process had
    // saved its renewal, that caller took over the claim the process left, and records how long
    // it went unconfirmed: longer than the lease, since the process never confirmed it again. It
    // records the grant it renewed, as the account and the first credential generation, which the
    // sign-in stored with the grant, and when it claimed it, so a reconnect of that grant can be
    // matched to the takeover. The process that held the claim is gone, so no renewal finds its
    // claim lost.
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
      // The resolve span still records the unconfirmed age, as before attempts had spans.
      expect(attempt.resolve.tags["oauth.renewal.abandoned_claim_age_ms"], point).toBe(
        renewal["oauth.renewal.abandoned_claim_age_ms"],
      );
    }

    if (
      point === "after the service rotates the token, before Executor saves it" &&
      replacedRefreshTokens === "refused"
    ) {
      // The only saved refresh token was consumed by a response that died with the process.
      // Executor tries it once, the service refuses it, and the account must reconnect. The
      // failure says the renewal was interrupted rather than refused outright.
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
      // The takeover itself ended in the refusal that marked the grant for reconnecting, after it
      // claimed the grant. Its attempt span names the grant and when it found the reconnect beside
      // its reason, so a query can match the reconnect to the takeover. Every call's resolve span
      // records the reconnect as before; the calls that waited for the takeover find the grant
      // already marked.
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
      // Later calls are refused without presenting the refused token again.
      const again = yield* read;
      expect(again.status, JSON.stringify(again.body)).toBe(409);
      expect((yield* metrics).refreshes, point).toBe(settled.refreshes);
      return;
    }

    // Every other kill point recovers without a new sign-in, with one renewal for all callers.
    expect(attempt.resolve.tags, point).toMatchObject({ "oauth.renewal.outcome": "renewed" });
    expect(renewal["oauth.reconnect.reason"], point).toBeUndefined();
    const tokens = yield* Effect.forEach(responses, renewed(point));
    expect(new Set(tokens).size, point).toBe(1);
    expect(settled.refreshesIssued - after.refreshesIssued, point).toBe(1);
    yield* newestTokenSaved(point, tokens[0] ?? null);
  });

/**
 * A live renewal whose token response takes longer than a lease that ignored its holder. The
 * callers waiting for it must not take over and present the replaced refresh token again.
 */
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
  // Only the holder's request reached the service while the others waited for it.
  expect(atRelease.refreshes - before.refreshes, context).toBe(1);
  expect(atRelease.held - before.held, context).toBe(1);
  yield* issuer.configure({ hold: null });
  yield* issuer.release;
  const responses = [yield* Fiber.join(holder), ...(yield* Fiber.join(waiting))];
  const tokens = yield* Effect.forEach(responses, renewed(context));
  expect(new Set(tokens).size, context).toBe(1);
  expect((yield* metrics).refreshesIssued - before.refreshesIssued, context).toBe(1);
  // Only the holder claimed the grant, in one attempt, and as a fresh claim rather than a
  // takeover. It kept the claim through the slow response, so it never found the claim lost.
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

/**
 * The caller loses app access while their call waits for a slow renewal. App access was checked
 * before the renewal; it is checked again once the renewal settles, so the app's code never runs
 * for a caller who can no longer use the app.
 */
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
  // The owner makes the app private to its creator while the member's renewal is held.
  yield* audience("private");
  yield* issuer.configure({ hold: null });
  yield* issuer.release;
  const response = yield* Fiber.join(call);
  expect(response.status, `${context}: ${JSON.stringify(response.body)}`).not.toBe(200);
  const after = yield* metrics;
  expect(after.refreshesIssued - before.refreshesIssued, context).toBe(1);
  // The renewed credentials never reached the app's code, so it read nothing from the service.
  expect(after.resourceRequests, context).toEqual(before.resourceRequests);

  // The same holds when the service refuses a token mid-call: a query is repeated with renewed
  // credentials only while its caller can still use the app. Tokens without a stated lifetime are
  // not renewed ahead, so the call starts with the saved token and renews once it is refused.
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
  // Only the refused read reached the service; the query was not repeated.
  expect(settled.resourceRequests.GET - refused.resourceRequests.GET, refusal).toBe(1);
});

/**
 * The caller that started a renewal disconnects while the service is answering, as a timed-out
 * agent or test does. The process stays up, so it must still save the rotated token it receives.
 */
const callerDisconnects = Effect.gen(function* () {
  const context = "caller disconnects mid-renewal";
  const { issuer, metrics, read, renewed, heldBeyond, concurrentReads, newestTokenSaved } =
    yield* rotatingAccount("refused");
  yield* issuer.configure({ hold: "refresh-issued" });
  const before = yield* metrics;
  const caller = yield* Effect.forkChild(read);
  yield* heldBeyond(before.held, context);
  yield* Fiber.interrupt(caller);
  // Give the product time to observe the disconnect, then send more calls while the service is
  // still answering the disconnected caller's renewal. They wait for its claim and use its result.
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
  // The disconnected caller's renewal was saved and is what the others use.
  const settled = yield* metrics;
  expect(settled.refreshes - before.refreshes, context).toBe(1);
  expect(settled.refreshesIssued - before.refreshesIssued, context).toBe(1);
  yield* newestTokenSaved(context, tokens[0] ?? null);
});

/**
 * Out-of-memory restarts: the process dies during a renewal, then again during each of the next
 * `recoveries` recoveries that take over its claim. A recovery whose request fails without an
 * answer releases the claim, and the grant recovers with the refresh token it held before the
 * first kill.
 *
 * Every kill leaves the same saved state: an unconfirmed claim over the unchanged grant. A
 * recovery claims the grant exactly as a first renewal does, and each restart begins with no
 * claims held, so a process that died during one recovery leaves what a process that died during
 * any later one would.
 */
const crashedRecoveries = (recoveries: number, context: string) =>
  Effect.gen(function* () {
    const renewal = yield* rotatingAccount("refused");
    const { issuer, metrics, read, renewed, heldBeyond, concurrentReads } = renewal;
    const start = yield* metrics;
    yield* issuer.configure({ hold: "refresh-unprocessed" });
    for (let cycle = 1; cycle <= recoveries + 1; cycle++) {
      const before = yield* metrics;
      // The first cycle's renewal is a normal one; later ones take over the dead process's claim.
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
      // Exactly one of the callers renews; the others wait for its claim.
      yield* Effect.sleep("500 millis");
      expect((yield* metrics).held - before.held, `${context} ${cycle}`).toBe(1);
      yield* serverControl("kill");
      for (const exit of yield* Fiber.join(pending))
        expect(Exit.isFailure(exit), `${context} ${cycle}`).toBe(true);
      yield* issuer.release;
      yield* serverControl("clock/advance", 200, { milliseconds: pastLease });
      yield* serverControl("start");
    }
    // The recovery's request fails without an answer while the process is alive: it releases the
    // claim with the grant unchanged and reports the outage.
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
    // No kill or outage consumed the saved refresh token, so the grant recovers. Nothing holds
    // this renewal, so a caller may read the grant only after it was saved. The recovered token
    // outlasts the host's renewal window, so such a caller uses it as the waiting callers do; a
    // token inside the window would rightly be renewed again. Waiting callers that reuse a renewal
    // whose token is still inside the window are covered by the held renewals above.
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

/** The process dies during a renewal and again during the recovery that takes over its claim. */
const diesAgainDuringRecovery = crashedRecoveries(1, "dies again during recovery");

/**
 * After a killed renewal and a failed recovery, the recovered grant holds the service's newest
 * refresh token.
 */
const recoveredGrantKeepsNewestToken = Effect.gen(function* () {
  const context = "recovered grant keeps newest token";
  const { issuer, newestTokenSaved, recovered } = yield* crashedRecoveries(0, context);
  // Bring the recovered token inside the renewal window, so the next call renews it.
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
