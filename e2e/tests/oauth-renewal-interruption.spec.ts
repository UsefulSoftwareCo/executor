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
import { Evidence } from "../support/evidence.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { createProfile } from "../support/profiles.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

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

/** One rotating OAuth account selected by one app profile, with a tool that uses its token. */
const rotatingAccount = (replacedRefreshTokens: "refused" | "accepted") =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      evidence = yield* Evidence,
      http = yield* HttpClient.HttpClient;
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
      actors.owner,
      "POST",
      `${prefix}/connections/${connection.id}/oauth/complete`,
      { callbackUrl },
    );
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    const account = yield* body(Resource, completed);
    // Background profile setup resolves, and so renews, the new account. Let it finish so the
    // renewals below belong to the calls the scenario makes.
    yield* api.request(actors.owner, "GET", `${appPath}/profiles/${profile.id}`).pipe(
      Effect.flatMap((response) => body(SetupStatus, response)),
      Effect.flatMap((current) =>
        current.status !== "pending"
          ? Effect.void
          : Effect.fail(new Error("Profile setup has not finished")),
      ),
      Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
    );

    const read = api.request(actors.owner, "POST", `${appPath}/tools/call`, {
      profile: profile.id,
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
      // Later calls are refused without presenting the refused token again.
      const again = yield* read;
      expect(again.status, JSON.stringify(again.body)).toBe(409);
      expect((yield* metrics).refreshes, point).toBe(settled.refreshes);
      return;
    }

    // Every other kill point recovers without a new sign-in, with one renewal for all callers.
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
  const { issuer, metrics, read, renewed, heldBeyond, newestTokenSaved } =
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
  yield* newestTokenSaved(context, tokens[0] ?? null);
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
