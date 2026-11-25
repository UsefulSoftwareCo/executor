import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { scenarios } from "../test-plan.ts";
import { TestLive, withCase } from "../support/case.ts";
import { cloudLocks } from "../support/cloud-locks.ts";
import type { SpanQuery } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { sentryExceptions } from "../support/sentry-events.ts";
import { targetHosts } from "../support/role-hosts.ts";

type Span = (typeof SpanQuery.Type)["data"][number]["span"];

const traceSpans = (traceId: string, until: (spans: ReadonlyArray<Span>) => boolean) => {
  const by = Date.now() + 20_000;
  return Effect.flatMap(Telemetry, (telemetry) => telemetry.query(traceId)).pipe(
    Effect.map((found) => found.data.map(({ span }) => span)),
    Effect.filterOrFail(until, () => new Error(`The spans of trace ${traceId} have not arrived`)),
    Effect.retry({ schedule: Schedule.spaced("500 millis"), while: () => Date.now() < by }),
  );
};

const Backends = Schema.Array(Schema.Struct({ pid: Schema.Number }));
const Holder = Schema.Tuple([Schema.Struct({ pid: Schema.Number })]);

const heldTable = (lock: string) =>
  Effect.gen(function* () {
    const locks = yield* cloudLocks;
    yield* Effect.addFinalizer(() => Effect.ignore(locks.release));
    const [holder] = yield* locks
      .hold({ sql: "select pg_backend_pid() as pid" })
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Holder)), Effect.orDie);
    yield* locks.hold({ sql: `lock table "rateLimit" in ${lock} mode` });
    const blocked = (statement: string, count: number) =>
      locks
        .run({
          sql: `select pid from pg_stat_activity
            where $1 = any(pg_blocking_pids(pid)) and query ilike $2`,
          params: [holder!.pid, `${statement}%`],
        })
        .pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Backends)),
          Effect.filterOrFail(
            (rows) => rows.length === count,
            () => new Error(`${count} requests did not wait on the locked table`),
          ),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
          Effect.orDie,
        );
    return { locks, blocked };
  });

const retryAfter = (window: number) =>
  Schema.decodeUnknownEffect(
    Schema.NumberFromString.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(window)),
  );

layer(TestLive, { excludeTestServices: true })("Cloud auth rate limit", (it) => {
  it.effect(scenarios.cloudAuthRateLimit.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          http = yield* HttpClient.HttpClient;
        const origin = targetHosts(target).browser;
        const post = (path: string, data: unknown) =>
          Effect.scoped(
            Effect.gen(function* () {
              const request = yield* HttpClientRequest.post(`${origin}${path}`).pipe(
                HttpClientRequest.setHeaders({ origin }),
                HttpClientRequest.bodyJson(data),
              );
              const response = yield* http.execute(request);
              yield* response.text;
              return { status: response.status, retryAfter: response.headers["x-retry-after"] };
            }),
          ).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));
        const register = post("/api/auth/oauth2/register", {
          client_name: "Rate limit client",
          redirect_uris: ["http://127.0.0.1:9/callback"],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        });
        const signIn = post("/api/auth/sign-in/social", {
          provider: "github",
          callbackURL: "/login",
          errorCallbackURL: "/login",
        });

        const registrations = yield* Effect.forEach(Array.from({ length: 61 }), () => register, {
          concurrency: 1,
        });
        expect(registrations.map((response) => response.status)).toEqual([
          ...Array.from({ length: 60 }, () => 201),
          429,
        ]);
        yield* retryAfter(60)(registrations[60]!.retryAfter);

        const signIns = yield* Effect.forEach(Array.from({ length: 4 }), () => signIn, {
          concurrency: 1,
        });
        expect(signIns.map((response) => response.status)).toEqual([200, 200, 200, 429]);
        const wait = yield* retryAfter(10)(signIns[3]!.retryAfter);
        yield* Effect.sleep(`${wait} seconds`);
        expect((yield* signIn).status).toBe(200);
      }),
    ),
  );

  const tokenRequest = Effect.gen(function* () {
    const target = yield* Target,
      http = yield* HttpClient.HttpClient;
    const origin = targetHosts(target).browser;
    const traceId = randomBytes(16).toString("hex");
    const { status, retryAfter } = yield* Effect.scoped(
      Effect.gen(function* () {
        const request = HttpClientRequest.post(`${origin}/api/auth/oauth2/token`).pipe(
          HttpClientRequest.setHeaders({
            origin,
            traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01`,
          }),
          HttpClientRequest.bodyUrlParams({
            grant_type: "refresh_token",
            refresh_token: "not-a-refresh-token",
            client_id: "not-a-client",
          }),
        );
        const response = yield* http.execute(request);
        yield* response.text;
        return { status: response.status, retryAfter: response.headers["x-retry-after"] };
      }),
    ).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));
    return { traceId, status, retryAfter };
  });

  const splitTokenRequest = (rest: number) =>
    Effect.gen(function* () {
      const target = yield* Target;
      const traceId = randomBytes(16).toString("hex");
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "not-a-refresh-token",
        client_id: "not-a-client",
      }).toString();
      const half = Math.floor(body.length / 2);
      return yield* Effect.callback<{ status: number; bodySent: boolean }, Error>((resume) => {
        let bodySent = false;
        const request = httpRequest(`${target.metadata.origin}/api/auth/oauth2/token`, {
          method: "POST",
          headers: {
            origin: target.metadata.origin,
            traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01`,
            "content-type": "application/x-www-form-urlencoded",
            "content-length": String(body.length),
          },
        });
        request.on("response", (response) => {
          response.resume();
          resume(Effect.succeed({ status: response.statusCode ?? 0, bodySent }));
        });
        request.on("error", (error) => resume(Effect.fail(error)));
        request.write(body.slice(0, half));
        const timer = setTimeout(() => {
          bodySent = true;
          request.end(body.slice(half));
        }, rest);
        return Effect.sync(() => {
          clearTimeout(timer);
          request.destroy();
        });
      }).pipe(Effect.map((answer) => ({ traceId, ...answer })));
    });

  const forgetTokenCount = (locks: Effect.Success<typeof cloudLocks>) =>
    locks.run({ sql: `delete from "rateLimit" where key like '%|/oauth2/token'` });

  it.effect(scenarios.cloudAuthRateLimitRace.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        yield* forgetTokenCount(yield* cloudLocks);
        const { locks, blocked } = yield* heldTable("share");
        const requests = yield* Effect.forkChild(
          Effect.all([tokenRequest, tokenRequest], { concurrency: 2 }),
        );
        yield* blocked(`insert into "rateLimit"`, 2);
        yield* locks.release;
        const responses = yield* Fiber.join(requests);

        expect(responses.map(({ status }) => status)).toEqual([400, 400]);

        yield* Effect.sleep("2 seconds");
        const traces = new Set(responses.map(({ traceId }) => traceId));
        const reported = yield* sentryExceptions([...traces]);
        expect(reported).toEqual([]);
        yield* Effect.flatMap(Evidence, (evidence) =>
          evidence.json("rate-limit-race.json", {
            statuses: responses.map(({ status }) => status),
            reported,
          }),
        );
      }),
    ),
  );

  it.effect(scenarios.cloudAuthDatabaseFailureCode.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const { locks, blocked } = yield* heldTable("access exclusive");
        const request = yield* Effect.forkChild(tokenRequest);
        const [backend] = yield* blocked(`select`, 1);
        yield* locks.run({ sql: "select pg_terminate_backend($1)", params: [backend!.pid] });
        yield* locks.release;
        const response = yield* Fiber.join(request);
        expect(response.status).toBeGreaterThanOrEqual(500);

        const reported = yield* sentryExceptions([response.traceId]).pipe(
          Effect.map((exceptions) =>
            exceptions.filter(
              ({ trace, type }) => trace === response.traceId && type === "AuthDatabaseFailed",
            ),
          ),
          Effect.filterOrFail((found) => found.length > 0),
          Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 50 }),
          Effect.orDie,
        );
        expect(reported[0]!.value).toMatch(/^Better Auth query failed: \S+$/u);
        yield* forgetTokenCount(locks);
        yield* Effect.flatMap(Evidence, (evidence) =>
          evidence.json("database-failure-code.json", { status: response.status, reported }),
        );
      }),
    ),
  );

  it.effect(scenarios.cloudTokenRateLimitTelemetry.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const locks = yield* cloudLocks;
        yield* forgetTokenCount(locks);
        const allowed = 140;
        const responses = yield* Effect.forEach(
          Array.from({ length: allowed + 1 }),
          () => tokenRequest,
          { concurrency: 1 },
        );
        expect(responses.map(({ status }) => status)).toEqual([
          ...Array.from({ length: allowed }, () => 400),
          429,
        ]);
        const limited = responses[allowed]!;
        yield* retryAfter(60)(limited.retryAfter);
        const server = (traceId: string) =>
          traceSpans(traceId, (spans) =>
            spans.some((span) => span.tags["auth.token.grant_type"] !== undefined),
          ).pipe(Effect.map((spans) => spans.find((span) => span.tags["auth.token.grant_type"])!));
        expect((yield* server(limited.traceId)).tags).toMatchObject({
          "http.response.status_code": "429",
          "auth.token.grant_type": "refresh_token",
          "auth.token.error": "other",
          "auth.token.rate_limited": "true",
          "auth.token.refresh_family_revoked": "false",
        });
        expect((yield* server(responses[allowed - 1]!.traceId)).tags).toMatchObject({
          "http.response.status_code": "400",
          "auth.token.grant_type": "refresh_token",
          "auth.token.rate_limited": "false",
        });
        const split = yield* splitTokenRequest(5_000);
        expect({ status: split.status, bodySent: split.bodySent }).toEqual({
          status: 429,
          bodySent: false,
        });
        expect((yield* server(split.traceId)).tags).toMatchObject({
          "http.response.status_code": "429",
          "auth.token.grant_type": "unknown",
          "auth.token.error": "other",
          "auth.token.rate_limited": "true",
        });
        yield* forgetTokenCount(locks);
        yield* Effect.flatMap(Evidence, (evidence) =>
          evidence.json("token-rate-limit.json", {
            statuses: responses.map(({ status }) => status),
            retryAfter: limited.retryAfter,
          }),
        );
      }),
    ),
  );
});
