/**
 * An emulator call that fails names the endpoint, the emulator and emulators.dev's diagnostic
 * report, and nothing else. The instance URL is the only access control for its emulator, and an
 * error body can quote provider tokens, sign-in codes and addresses, so none of them may reach the
 * error, its rendering in result.json (`Cause.pretty`), or any span: attributes, events or status.
 * A local server stands in for emulators.dev and answers with synthetic secrets.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Cause,
  Clock,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Stream,
  Tracer,
} from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  armedFaultHeader,
  emulatorRequest,
  EmulatorRetryPolicy,
  EmulatorRetryRecords,
} from "../support/emulators.ts";
import {
  countEmulatorRetries,
  emulatorRetryDirectory,
  emulatorRetryLine,
} from "../emulator-retries.ts";

const suffix = "0123456789abcdef01234567";
const instance = `report-${suffix}`;
const token = "emu_resend_SYNTHETICtoken0001";
const code = "SYNTH-CODE-482913";
const email = "pat.synthetic@example.test";
// Secrets shaped like diagnostic values: each passes a format check for the field it is in.
const named = "SYNTHETICtoken482913";
const secrets = [suffix, token, code, email, named, named.toUpperCase(), "482913482913"];
const ray = "8f1d2c3b4a5e6f70-PHX";

/** emulate's instance hash: the first 12 hex digits of SHA-256(`service:instance`). */
const instanceId = (name: string) =>
  createHash("sha256").update(`resend:${name}`).digest("hex").slice(0, 12);

const report = {
  error: "emulator_unavailable",
  service: "resend",
  instanceId: instanceId(instance),
  method: "POST",
  route: "/emails",
  errorClass: "Error",
  retryable: true,
  overloaded: false,
  remote: false,
};

/** Answers with the response named by the instance's prefix (`/resend/<case>-<suffix>/...`). */
const responses: Record<string, { status: number; headers: Record<string, string>; body: string }> =
  {
    // A report with the diagnostic fields plus everything an older or broken server might add.
    report: {
      status: 503,
      headers: { "content-type": "application/json", "cf-ray": ray },
      body: JSON.stringify({
        ...report,
        ray,
        message: `lost ${instance}: token ${token} code ${code} for ${email}`,
        stack: `Error: ${token}\n    at ${email}`,
        path: `/resend/${instance}/emails/${email}`,
        instance,
        token,
      }),
    },
    // Every field holds a secret that passes its format check; only the flags survive.
    tainted: {
      status: 500,
      headers: { "content-type": "application/json", "cf-ray": code },
      body: JSON.stringify({
        ...report,
        service: named,
        instanceId: "482913482913",
        method: named.toUpperCase(),
        route: `/emails/${named}`,
        errorClass: named,
        ray: code,
      }),
    },
    // A dynamic segment's name is the server's to choose, so it is not repeated.
    param: {
      status: 503,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...report, instanceId: undefined, route: `/:${named}` }),
    },
    // Cloudflare's opaque error page.
    opaque: {
      status: 500,
      headers: { "content-type": "text/html" },
      body: `<html>Worker threw exception for ${instance} ${token} ${code} ${email}</html>`,
    },
  };

const stub = Effect.acquireRelease(
  Effect.callback<{ readonly origin: string; readonly close: () => void }>((resume) => {
    const server = createServer((request, response) => {
      const name = (request.url ?? "").split("/")[2]?.split("-")[0] ?? "";
      const answer = responses[name] ?? { status: 404, headers: {}, body: "" };
      response.writeHead(answer.status, answer.headers).end(answer.body);
    });
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resume(Effect.succeed({ origin: `http://localhost:${port}`, close: () => server.close() }));
    });
  }),
  ({ close }) => Effect.sync(close),
);

/** Records every span the program starts, as an exporter would receive them. */
const recording = () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  const exported = () =>
    JSON.stringify(
      spans.map((span) => ({
        name: span.name,
        attributes: Object.fromEntries(span.attributes),
        events: span.events.map(([name, , attributes]) => ({ name, attributes })),
        status:
          span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
            ? Cause.pretty(span.status.exit.cause)
            : span.status._tag,
      })),
    );
  return { tracer, spans, exported };
};

const leaked = (text: string) => secrets.filter((secret) => text.includes(secret));

/**
 * Calls the stub as the harness calls emulators.dev, inside a caller's span. A send is a provider
 * write the harness never repeats, so each case sees exactly one answer.
 */
const failingCall = (origin: string, name: string, tracer: Tracer.Tracer) =>
  emulatorRequest(`${origin}/resend/${name}-${suffix}`, "/emails", { to: email }, token).pipe(
    Effect.withSpan("harness step"),
    Effect.withTracer(tracer),
    Effect.flip,
    Effect.provide(FetchHttpClient.layer),
  );

interface Answer {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}): Answer => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const rays = ["0a1b2c3d4e5f6071-LAX", "1a1b2c3d4e5f6071-LAX", "2a1b2c3d4e5f6071-LAX"];
/** emulators.dev's opaque answer to an uncaught exception, as CI saw it. */
const workerError = (attempt: number): Answer => ({
  status: 500,
  headers: { "content-type": "text/html", "cf-ray": rays[attempt]! },
  body: `<html>Worker threw exception for ${instance} ${token}</html>`,
});

/**
 * Answers each path with its script, one answer per request, repeating the last, and counts the
 * requests each path received. Paths are `/<service>/<case>-<suffix>/<route>`.
 */
const scripted = (scripts: Record<string, ReadonlyArray<Answer>>) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly origin: string;
      readonly hits: Map<string, number>;
      readonly close: () => void;
    }>((resume) => {
      const hits = new Map<string, number>();
      const server = createServer((request, response) => {
        const key = `${request.method} ${(request.url ?? "").split("?")[0]}`;
        const seen = hits.get(key) ?? 0;
        hits.set(key, seen + 1);
        const script = scripts[key] ?? [];
        const answer = script[Math.min(seen, script.length - 1)] ?? { status: 404 };
        // Read the request body before answering, as a real server does.
        request.resume();
        request.on("end", () =>
          response.writeHead(answer.status, answer.headers ?? {}).end(answer.body ?? ""),
        );
      });
      server.listen(0, () => {
        const { port } = server.address() as AddressInfo;
        resume(
          Effect.succeed({ origin: `http://localhost:${port}`, hits, close: () => server.close() }),
        );
      });
    }),
    ({ close }) => Effect.sync(close),
  );

/** Short spacing so the cases run in seconds; the attempts and their order are the harness's. */
const fastPolicy = { attempts: 3, attemptDeadlineMs: 1_000, spacingMs: [100, 200] } as const;

/** A directory for the run's retry records, removed with the scope. */
const recordsDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "emulator-retries-" });
});

const records = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const folder = `${directory}/${emulatorRetryDirectory}`;
    if (!(yield* fs.exists(folder))) return [];
    return yield* Effect.forEach(yield* fs.readDirectory(folder), (file) =>
      fs
        .readFileString(`${folder}/${file}`)
        .pipe(Effect.map((text) => JSON.parse(text) as unknown)),
    );
  });

/** Calls the scripted stub as the harness does, recording retries in `directory`. */
const harnessCall = (
  directory: string,
  base: string,
  path: string,
  payload?: unknown,
  options?: Parameters<typeof emulatorRequest>[5],
) =>
  emulatorRequest(base, path, payload, token, undefined, options).pipe(
    Effect.provideService(EmulatorRetryRecords, { directory }),
    Effect.provideService(EmulatorRetryPolicy, fastPolicy),
    Effect.provide(FetchHttpClient.layer),
  );

/** A server that never answers, counting the requests each path received. */
const stalling = Effect.acquireRelease(
  Effect.callback<{
    readonly origin: string;
    readonly hits: Map<string, number>;
    readonly close: () => void;
  }>((resume) => {
    const hits = new Map<string, number>();
    const server = createServer((request) => {
      const key = `${request.method} ${(request.url ?? "").split("?")[0]}`;
      hits.set(key, (hits.get(key) ?? 0) + 1);
      request.resume();
    });
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resume(
        Effect.succeed({
          origin: `http://localhost:${port}`,
          hits,
          close: () => {
            server.closeAllConnections();
            server.close();
          },
        }),
      );
    });
  }),
  ({ close }) => Effect.sync(close),
);

/** The test clock `@effect/vitest` provides, which a case moves by hand. */
interface ControlledClock extends Clock.Clock {
  adjust(duration: Duration.Input): Effect.Effect<void>;
  withLive<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
}
const controlledClock = Effect.clockWith((clock) =>
  "adjust" in clock && "withLive" in clock
    ? Effect.succeed(clock as ControlledClock)
    : Effect.die(new Error("This case needs the test clock")),
);

/**
 * Runs a call on the test clock, moving it 250 ms at a time and letting real I/O run between
 * steps, and returns how it ended and the clock time it took.
 */
const onTestClock = <A, E>(call: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const clock = yield* controlledClock;
    const fiber = yield* Effect.forkChild(call);
    let elapsed = 0;
    while (fiber.pollUnsafe() === undefined && elapsed <= 120_000) {
      yield* clock.adjust("250 millis");
      elapsed += 250;
      yield* clock.withLive(Effect.sleep("2 millis"));
    }
    return { exit: yield* Effect.exit(Fiber.join(fiber)), elapsed };
  });

/** One request a call sent, when it started on the call's clock, and how it ended. */
interface TimedAttempt {
  readonly route: string;
  readonly start: number;
  ended?: "answered" | "failed" | "cut off";
}
/**
 * An HTTP client that notes when each request starts on the call's clock and how it ends. A
 * request starts in the same synchronous step in which the policy decided to send it, so its start
 * is the time of that decision.
 */
const timedClient = (attempts: Array<TimedAttempt>) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (client) =>
      HttpClient.transform(client, (response, request) =>
        Effect.gen(function* () {
          const attempt: TimedAttempt = {
            route: `${request.method} ${new URL(request.url).pathname}`,
            start: yield* Clock.currentTimeMillis,
          };
          attempts.push(attempt);
          return yield* response.pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                attempt.ended = Exit.isSuccess(exit)
                  ? "answered"
                  : Cause.hasInterrupts(exit.cause)
                    ? "cut off"
                    : "failed";
              }),
            ),
          );
        }),
      ),
    ),
  ).pipe(Layer.provide(FetchHttpClient.layer));

/**
 * The clock a call runs on, noting the call's first reading of the time and every sleep it
 * schedules, with when and for how long. The policy reads the time first as it starts (its 30 s
 * runs from there), and each attempt's time-out is a sleep scheduled as the attempt starts, for
 * the time-out the policy chose. So both are read where the policy decides them, not after any
 * work that takes real time while the test clock moves on.
 */
const notingClock = (clock: Clock.Clock) => {
  const noted = {
    first: undefined as number | undefined,
    sleeps: [] as Array<{ at: number; ms: number }>,
  };
  const millis = () => {
    const now = clock.currentTimeMillisUnsafe();
    noted.first ??= now;
    return now;
  };
  const noting: Clock.Clock = {
    currentTimeMillisUnsafe: millis,
    currentTimeMillis: Effect.sync(millis),
    currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
    currentTimeNanos: clock.currentTimeNanos,
    monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: clock.monotonicTimeNanos,
    sleep: (duration) =>
      Effect.suspend(() => {
        noted.sleeps.push({ at: clock.currentTimeMillisUnsafe(), ms: Duration.toMillis(duration) });
        return clock.sleep(duration);
      }),
  };
  return {
    noted,
    run: <A, E, R>(call: Effect.Effect<A, E, R>) =>
      Effect.provideService(call, Clock.Clock, noting),
  };
};

/**
 * The deadline as facts the policy decided: it runs from the call's own start, every attempt
 * started before it, and as each attempt started a time-out of exactly the smaller of 10 s and
 * what was left was scheduled for it. Every attempt was then cut off by it. And every sleep the
 * call scheduled, time-outs and the spacing between attempts alike, ends by the deadline, so the
 * call itself does: nothing the policy waits for runs past it.
 */
const withinDeadline = (
  attempts: ReadonlyArray<TimedAttempt>,
  noted: {
    readonly first: number | undefined;
    readonly sleeps: ReadonlyArray<{ at: number; ms: number }>;
  },
) => {
  const started = noted.first ?? 0;
  const deadline = started + 30_000;
  const listed = JSON.stringify({
    attempts: attempts.map(({ route, start, ended }) => ({ route, start: start - started, ended })),
    sleeps: noted.sleeps.map(({ at, ms }) => ({ at: at - started, ms })),
  });
  for (const sleep of noted.sleeps)
    expect(
      sleep.at + sleep.ms,
      `a sleep of ${sleep.ms} ms scheduled at ${sleep.at - started} ms ends after the deadline: ${listed}`,
    ).toBeLessThanOrEqual(deadline);
  for (const attempt of attempts) {
    const timeOuts = noted.sleeps.filter(({ at }) => at === attempt.start).map(({ ms }) => ms);
    const left = deadline - attempt.start;
    expect(attempt.start, `an attempt started at or after the deadline: ${listed}`).toBeLessThan(
      deadline,
    );
    expect(timeOuts, `an attempt's time-out was not cut to what was left: ${listed}`).toContain(
      Math.min(10_000, left),
    );
    expect(
      timeOuts.every((ms) => ms <= left),
      `a time-out reached past the deadline: ${listed}`,
    ).toBe(true);
    expect(attempt.ended, `an attempt was not cut off by its time-out: ${listed}`).toBe("cut off");
  }
};

// The retry cases run on the real clock: the spacing between attempts is real time.
layer(NodeServices.layer, { excludeTestServices: true })("Emulator failures", (it) => {
  it.effect("a failure report keeps only emulate's diagnostic fields", () =>
    Effect.gen(function* () {
      const { origin } = yield* stub;
      const { tracer, spans, exported } = recording();
      const error = yield* failingCall(origin, "report", tracer);

      expect(error.message).toBe(
        `External emulator failed: POST /emails on resend/report-… #${instanceId(instance)} (HTTP 503, cf-ray ${ray}): emulator_unavailable at POST /emails, Error retryable`,
      );
      expect({ ...error.report }).toEqual(report);
      expect(spans.map((span) => span.name)).toEqual(["harness step"]);
      expect(leaked(error.message)).toEqual([]);
      expect(leaked(JSON.stringify(error))).toEqual([]);
      expect(leaked(Cause.pretty(Cause.fail(error)))).toEqual([]);
      expect(leaked(exported())).toEqual([]);
    }),
  );

  it.effect("a report field that is not a value the harness knows is dropped", () =>
    Effect.gen(function* () {
      const { origin } = yield* stub;
      const tainted = yield* failingCall(origin, "tainted", recording().tracer);
      expect({ ...tainted.report }).toEqual({
        error: "emulator_unavailable",
        retryable: true,
        overloaded: false,
        remote: false,
      });
      expect(tainted.message).toBe(
        `External emulator failed: POST /emails on resend/tainted-… #${instanceId(`tainted-${suffix}`)} (HTTP 500): emulator_unavailable, retryable`,
      );
      const param = yield* failingCall(origin, "param", recording().tracer);
      expect(param.report).toMatchObject({ route: "/:param", service: "resend" });
      expect(param.report?.instanceId).toBeUndefined();
      for (const error of [tainted, param]) {
        expect(leaked(error.message)).toEqual([]);
        expect(leaked(JSON.stringify(error))).toEqual([]);
      }
    }),
  );

  it.effect("a body or cf-ray that carries a secret is not reported", () =>
    Effect.gen(function* () {
      const { origin } = yield* stub;
      for (const name of ["tainted", "opaque"]) {
        const { tracer, exported } = recording();
        const error = yield* failingCall(origin, name, tracer);
        if (name === "opaque") expect(error.report).toBeUndefined();
        expect(error.status).toBe(500);
        expect(error.ray).toBeUndefined();
        expect(leaked(JSON.stringify(error))).toEqual([]);
        expect(leaked(Cause.pretty(Cause.fail(error)))).toEqual([]);
        expect(leaked(exported())).toEqual([]);
      }
    }),
  );

  it.effect("a request that never gets a response does not carry its URL", () =>
    Effect.gen(function* () {
      const { tracer, exported } = recording();
      // Nothing listens on port 9 (discard) here; the connection is refused.
      const error = yield* failingCall("http://localhost:9", "unreachable", tracer);
      expect(error.reason).toBe("request");
      expect(leaked(JSON.stringify(error))).toEqual([]);
      expect(leaked(Cause.pretty(Cause.fail(error)))).toEqual([]);
      expect(leaked(exported())).toEqual([]);
    }),
  );

  it.effect("the recorder sees the URL an ordinary traced request exports", () =>
    Effect.gen(function* () {
      const { origin } = yield* stub;
      const { tracer, exported } = recording();
      // The control: Effect's client span records `url.full`, which is why emulator calls turn it off.
      yield* HttpClient.get(`${origin}/resend/opaque-${suffix}/emails`).pipe(
        Effect.withTracer(tracer),
        Effect.provide(FetchHttpClient.layer),
      );
      expect(leaked(exported())).toContain(suffix);
    }),
  );

  it.effect("a set-up call answered 500 and then 200 passes, and is recorded and counted", () =>
    Effect.gen(function* () {
      const base = `/google/flaky-${suffix}`;
      const { origin, hits } = yield* scripted({
        [`POST ${base}/_emulate/seed`]: [workerError(0), json(200, { ok: true })],
      });
      const directory = yield* recordsDirectory;
      const answer = yield* harnessCall(directory, `${origin}${base}`, "/_emulate/seed", {
        users: [{ email }],
      });
      expect(answer).toEqual({ ok: true });
      expect(hits.get(`POST ${base}/_emulate/seed`)).toBe(2);
      const saved = yield* records(directory);
      expect(saved).toEqual([
        {
          operation: "POST /_emulate/seed",
          emulator: `google/flaky-… #${createHash("sha256").update(`google:flaky-${suffix}`).digest("hex").slice(0, 12)}`,
          failures: [`HTTP 500, cf-ray ${rays[0]}`],
          outcome: "answered",
          attempts: 2,
          elapsedMs: expect.any(Number),
        },
      ]);
      expect(leaked(JSON.stringify(saved))).toEqual([]);
      const counts = yield* countEmulatorRetries([directory]);
      expect(counts).toMatchObject({ calls: 1, failed: 0, scenarios: 0, setup: 1 });
      expect(emulatorRetryLine(counts)).toMatch(
        /^Hosted emulator calls that needed a retry: 1 \(0 scenarios, 1 while setting up\); 0 still failed after retrying\. Worst: POST \/_emulate\/seed on google\/flaky-… #[0-9a-f]{12}, 2 attempts over \d+\.\d s \(answered; HTTP 500, cf-ray 0a1b2c3d4e5f6071-LAX\)\.$/u,
      );
    }),
  );

  it.effect("a read that keeps answering 500 fails after three attempts, each listed", () =>
    Effect.gen(function* () {
      const base = `/resend/down-${suffix}`;
      const { origin, hits } = yield* scripted({
        [`GET ${base}/emails`]: [workerError(0), workerError(1), workerError(2)],
      });
      const directory = yield* recordsDirectory;
      const error = yield* harnessCall(directory, `${origin}${base}`, "/emails").pipe(Effect.flip);
      expect(hits.get(`GET ${base}/emails`)).toBe(3);
      expect(error.message).toMatch(
        new RegExp(
          `^External emulator failed: GET /emails on resend/down-… #[0-9a-f]{12} after 3 attempts in \\d+\\.\\d s \\(attempt 1: HTTP 500, cf-ray 0a1b2c3d4e5f6071-LAX; attempt 2: HTTP 500, cf-ray 1a1b2c3d4e5f6071-LAX; attempt 3: HTTP 500, cf-ray 2a1b2c3d4e5f6071-LAX\\)$`,
          "u",
        ),
      );
      // Callers that match on the last answer still can.
      expect(error.status).toBe(500);
      for (const text of [error.message, JSON.stringify(error), Cause.pretty(Cause.fail(error))])
        expect(leaked(text)).toEqual([]);
      const saved = yield* records(directory);
      expect(saved).toEqual([expect.objectContaining({ outcome: "failed", attempts: 3 })]);
      expect(yield* countEmulatorRetries([directory])).toMatchObject({ calls: 1, failed: 1 });
    }),
  );

  it.effect("a refused connection and a time-out are retried", () =>
    Effect.gen(function* () {
      const directory = yield* recordsDirectory;
      // Nothing listens on port 3 (see request-failures.spec.ts), so every attempt is refused.
      const refused = yield* harnessCall(
        directory,
        `http://localhost:3/github/gone-${suffix}`,
        "/_emulate/reset",
        {},
      ).pipe(Effect.flip);
      expect(refused.message).toContain("after 3 attempts");
      expect(refused.failure).toMatchObject({ stage: "before response", connection: "connect" });

      const base = `/autumn/slow-${suffix}`;
      const stall = Effect.acquireRelease(
        Effect.callback<{ readonly origin: string; readonly close: () => void }>((resume) => {
          let seen = 0;
          const server = createServer((request, response) => {
            seen += 1;
            // The first request never answers; the second does.
            if (seen > 1) response.writeHead(200).end(JSON.stringify({ list: [] }));
            else request.resume();
          });
          server.listen(0, () => {
            const { port } = server.address() as AddressInfo;
            resume(
              Effect.succeed({
                origin: `http://localhost:${port}`,
                close: () => {
                  server.closeAllConnections();
                  server.close();
                },
              }),
            );
          });
        }),
        ({ close }) => Effect.sync(close),
      );
      const { origin } = yield* stall;
      const listed = yield* harnessCall(directory, `${origin}${base}`, "/v1/plans.list", {});
      expect(listed).toEqual({ list: [] });
      const saved = yield* records(directory);
      expect(saved).toContainEqual(
        expect.objectContaining({ operation: "POST /v1/plans.list", outcome: "answered" }),
      );
    }),
  );

  it.effect("a read whose body is cut off by a reset is read again, and a send is not", () =>
    Effect.gen(function* () {
      /**
       * Answers 200 with headers and part of the body, then resets the connection, the first time
       * each path is requested; answers whole after that. Counts the requests each path received.
       */
      const cutting = Effect.acquireRelease(
        Effect.callback<{
          readonly origin: string;
          readonly hits: Map<string, number>;
          readonly close: () => void;
        }>((resume) => {
          const hits = new Map<string, number>();
          const server = createServer((request, response) => {
            const key = `${request.method} ${(request.url ?? "").split("?")[0]}`;
            const seen = hits.get(key) ?? 0;
            hits.set(key, seen + 1);
            request.resume();
            request.on("end", () => {
              const whole = JSON.stringify({ data: [{ id: "email-1", to: [email] }] });
              if (seen > 0) {
                response.writeHead(200, { "content-type": "application/json" }).end(whole);
                return;
              }
              response.writeHead(200, {
                "content-type": "application/json",
                "content-length": String(whole.length),
              });
              // The headers and half the body reach the client before the reset.
              response.write(whole.slice(0, whole.length / 2), () =>
                setTimeout(() => request.socket.resetAndDestroy(), 20),
              );
            });
          });
          server.listen(0, () => {
            const { port } = server.address() as AddressInfo;
            resume(
              Effect.succeed({
                origin: `http://localhost:${port}`,
                hits,
                close: () => {
                  server.closeAllConnections();
                  server.close();
                },
              }),
            );
          });
        }),
        ({ close }) => Effect.sync(close),
      );
      const { origin, hits } = yield* cutting;
      const directory = yield* recordsDirectory;
      const base = `/resend/cut-${suffix}`;
      const listed = yield* harnessCall(directory, `${origin}${base}`, "/emails");
      expect(listed).toEqual({ data: [{ id: "email-1", to: [email] }] });
      expect(hits.get(`GET ${base}/emails`)).toBe(2);
      const saved = yield* records(directory);
      expect(saved).toEqual([
        expect.objectContaining({ operation: "GET /emails", outcome: "answered", attempts: 2 }),
      ]);
      expect((saved[0] as { failures: Array<string> }).failures).toEqual([
        expect.stringMatching(/^request: reading body of HTTP 200 \(reset\), .* ECONNRESET, /u),
      ]);
      expect(leaked(JSON.stringify(saved))).toEqual([]);

      // A send cut off the same way may have been delivered, so it is not sent again.
      const sent = yield* harnessCall(directory, `${origin}${base}`, "/emails", {
        to: email,
      }).pipe(Effect.flip);
      expect(hits.get(`POST ${base}/emails`)).toBe(1);
      expect(sent.failure).toMatchObject({ stage: "reading body", status: 200 });
      expect(sent.earlier).toBeUndefined();
      expect(yield* records(directory)).toHaveLength(1);
    }),
  );

  it.effect("a 4xx, an unsafe route and a fault the harness armed are sent once", () =>
    Effect.gen(function* () {
      const answers = (service: string, name: string, route: string, answer: Answer) =>
        [`${service}/${name}-${suffix}`, route, answer] as const;
      const cases = [
        // Refusals are the emulator's answer, not an outage.
        answers("github", "conflict", "POST /_emulate/credentials", json(409, { error: "x" })),
        answers("workos", "missing", "GET /user_management/users", json(404, { error: "x" })),
        // A second fault would fail one more call.
        answers("autumn", "fault", "POST /_emulate/faults", workerError(0)),
        // Harness writes through a provider's own API, and the seed of a service not checked.
        answers("workos", "vault", "POST /vault/v1/kv", workerError(0)),
        answers("workos", "invite", "POST /user_management/invitations", workerError(0)),
        answers("autumn", "usage", "POST /v1/balances.update", workerError(0)),
        answers("mcp", "seed", "POST /_emulate/seed", workerError(0)),
        // A read answered by the scenario's own armed fault.
        answers(
          "autumn",
          "armed",
          "POST /v1/customers.get",
          json(503, { code: "synthetic_outage" }, { [armedFaultHeader]: "1" }),
        ),
        answers(
          "workos",
          "armed",
          "GET /user_management/organization_memberships",
          json(503, { error: "temporarily_unavailable" }, { [armedFaultHeader]: "1" }),
        ),
      ];
      const scripts = Object.fromEntries(
        cases.map(([base, route, answer]) => {
          const [method, path] = route.split(" ");
          return [`${method} /${base}${path}`, [answer, json(200, {})]];
        }),
      );
      const { origin, hits } = yield* scripted(scripts);
      const directory = yield* recordsDirectory;
      for (const [base, route] of cases) {
        const [method, path] = route.split(" ") as [string, string];
        const error = yield* harnessCall(
          directory,
          `${origin}/${base}`,
          path,
          method === "GET" ? undefined : {},
        ).pipe(Effect.flip);
        expect(hits.get(`${method} /${base}${path}`), route).toBe(1);
        expect(error.earlier, route).toBeUndefined();
      }
      expect(yield* records(directory)).toEqual([]);
    }),
  );

  it.effect(
    "a WorkOS seed that creates an organization is sent again only if it did not apply",
    () =>
      Effect.gen(function* () {
        const base = `/workos/v1-${suffix}`;
        const route = `POST ${base}/_emulate/seed`;
        const { origin, hits } = yield* scripted({
          [route]: [workerError(0), json(200, { ok: true })],
        });
        const directory = yield* recordsDirectory;
        const seed = {
          users: [{ email }],
          organizations: [{ name: "V1 synthetic", members: [email] }],
        };
        // The 500 came after the seed applied: reading back finds it, so it is not sent again.
        yield* harnessCall(directory, `${origin}${base}`, "/_emulate/seed", seed, {
          applied: Effect.succeed(true),
        });
        expect(hits.get(route)).toBe(1);
        expect(yield* records(directory)).toEqual([
          expect.objectContaining({ outcome: "found applied", attempts: 1 }),
        ]);
        // Without a way to read back, it is sent once.
        hits.clear();
        const once = yield* harnessCall(directory, `${origin}${base}`, "/_emulate/seed", seed).pipe(
          Effect.flip,
        );
        expect(hits.get(route)).toBe(1);
        expect(once.status).toBe(500);
        // The first copy did not apply: it is sent again.
        hits.clear();
        yield* harnessCall(directory, `${origin}${base}`, "/_emulate/seed", seed, {
          applied: Effect.succeed(false),
        });
        expect(hits.get(route)).toBe(2);
        // A seed of users alone matches them by email, so it is simply sent again.
        const users = `POST /workos/users-${suffix}/_emulate/seed`;
        const second = yield* scripted({ [users]: [workerError(0), json(200, { ok: true })] });
        yield* harnessCall(directory, `${second.origin}/workos/users-${suffix}`, "/_emulate/seed", {
          users: [{ email }],
        });
        expect(second.hits.get(users)).toBe(2);
      }),
  );

  it.effect("a call to an emulator with a fault the harness armed is sent once until a reset", () =>
    Effect.gen(function* () {
      const base = `/autumn/armed-${suffix}`;
      const read = `POST ${base}/v1/customers.get`;
      const { origin, hits } = yield* scripted({
        [`POST ${base}/_emulate/faults`]: [json(200, { fault: { id: "fault_1" } })],
        [`POST ${base}/_emulate/reset`]: [json(200, { ok: true })],
        // An outage-shaped answer: retried unless a fault may be waiting for the product.
        [read]: [workerError(0)],
      });
      const directory = yield* recordsDirectory;
      const call = (path: string, payload: unknown) =>
        harnessCall(directory, `${origin}${base}`, path, payload);
      yield* call("/_emulate/faults", {
        match: { method: "POST", pathPattern: "/v1/customers.get" },
        response: { status: 200, body: {} },
        delayMs: 12_000,
      });
      const once = yield* call("/v1/customers.get", { customer_id: "c" }).pipe(Effect.flip);
      expect(hits.get(read)).toBe(1);
      expect(once.earlier).toBeUndefined();
      yield* call("/_emulate/reset", {});
      yield* call("/v1/customers.get", { customer_id: "c" }).pipe(Effect.flip);
      expect(hits.get(read)).toBe(1 + 3);
    }),
  );

  it.effect(
    "clearing one armed fault by its id is sent again when the emulator does not answer; provider routes, resets, seeds and clearing every fault stay sent once",
    () =>
      Effect.gen(function* () {
        const base = `/autumn/clear-${suffix}`;
        const clear = `DELETE ${base}/_emulate/faults/fault_1`;
        const read = `POST ${base}/v1/customers.get`;
        const { origin, hits } = yield* scripted({
          [`POST ${base}/_emulate/faults`]: [json(200, { fault: { id: "fault_1" } })],
          // The control plane is never faulted; this is the emulator itself failing to answer.
          [clear]: [workerError(0), json(200, { ok: true, removed: true })],
          [read]: [workerError(0)],
          [`DELETE ${base}/_emulate/faults`]: [workerError(0)],
          [`DELETE ${base}/_emulate/faults/`]: [workerError(0)],
          [`POST ${base}/_emulate/reset`]: [workerError(0)],
          [`POST ${base}/_emulate/seed`]: [workerError(0)],
        });
        const directory = yield* recordsDirectory;
        const call = (path: string, payload?: unknown, verb?: "DELETE") =>
          emulatorRequest(`${origin}${base}`, path, payload, token, verb).pipe(
            Effect.provideService(EmulatorRetryRecords, { directory }),
            Effect.provideService(EmulatorRetryPolicy, fastPolicy),
            Effect.provide(FetchHttpClient.layer),
          );
        yield* call("/_emulate/faults", {
          match: { method: "POST", pathPattern: "/v1/customers.get" },
          response: { status: 200, body: {} },
          delayMs: 12_000,
        });
        expect(yield* call("/_emulate/faults/fault_1", undefined, "DELETE")).toEqual({
          ok: true,
          removed: true,
        });
        expect(hits.get(clear)).toBe(2);
        expect(yield* records(directory)).toMatchObject([
          { operation: "DELETE /_emulate/faults/fault_1", outcome: "answered", attempts: 2 },
        ]);
        // A provider route of the same emulator may still meet a delayed fault: sent once.
        const once = yield* call("/v1/customers.get", { customer_id: "c" }).pipe(Effect.flip);
        expect(hits.get(read)).toBe(1);
        expect(once.earlier).toBeUndefined();
        // A late copy of these could undo a fault armed after them: each is sent once while a
        // fault is armed, even when the emulator does not answer.
        for (const [path, verb, payload, sent = path] of [
          ["/_emulate/faults", "DELETE", undefined],
          // Not an id emulate issues: the URL normalizes to the route that clears every fault.
          ["/_emulate/faults/.", "DELETE", undefined, "/_emulate/faults/"],
          ["/_emulate/reset", undefined, {}],
          ["/_emulate/seed", undefined, { plans: [] }],
        ] as const) {
          const failed = yield* call(path, payload, verb).pipe(Effect.flip);
          expect(hits.get(`${verb ?? "POST"} ${base}${sent}`), path).toBe(1);
          expect(failed.earlier, path).toBeUndefined();
        }
      }),
  );
});

// The shipped retry policy, on the test clock: its 30 s of attempts run in well under a second.
layer(NodeServices.layer)("Emulator retry policy", (it) => {
  it.effect("the shipped policy ends every call inside its 30 s deadline, read back included", () =>
    Effect.gen(function* () {
      const { origin, hits } = yield* stalling;
      const directory = yield* recordsDirectory;
      const attempts: Array<TimedAttempt> = [];
      const client = timedClient(attempts);
      const clock = yield* Clock.Clock;
      const shipped = (base: string, payload: unknown, applied?: Effect.Effect<boolean, never>) =>
        emulatorRequest(
          `${origin}${base}`,
          "/_emulate/seed",
          payload,
          token,
          undefined,
          applied === undefined ? undefined : { applied },
        ).pipe(Effect.provideService(EmulatorRetryRecords, { directory }), Effect.provide(client));

      // Three attempts of 10, 10 and the 6 s left, 1 s then 3 s apart: 30 s in all.
      const google = `/google/stalled-${suffix}`;
      const plainClock = notingClock(clock);
      const plain = yield* onTestClock(plainClock.run(shipped(google, { users: [{ email }] })));
      expect(hits.get(`POST ${google}/_emulate/seed`)).toBe(3);
      expect(attempts.map(({ route }) => route)).toEqual(
        Array.from({ length: 3 }, () => `POST ${google}/_emulate/seed`),
      );
      withinDeadline(attempts, plainClock.noted);
      const error = Option.getOrThrow(Exit.findErrorOption(plain.exit));
      expect(error.message).toContain("after 3 attempts");
      expect(error.reason).toBe("timeout");

      // The read back has only the 19 s left after the first attempt and its spacing; it stalls
      // too, so whether the seed applied stays unknown and it is not sent again.
      attempts.length = 0;
      const workos = `/workos/stalled-${suffix}`;
      const readBack = emulatorRequest(`${origin}${workos}`, "/user_management/users").pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
        Effect.provide(client),
      );
      const seed = {
        users: [{ email }],
        organizations: [{ name: "V1 stalled", members: [email] }],
      };
      const organizationClock = notingClock(clock);
      const organization = yield* onTestClock(
        organizationClock.run(shipped(workos, seed, readBack)),
      );
      expect(hits.get(`POST ${workos}/_emulate/seed`)).toBe(1);
      expect(hits.get(`GET ${workos}/user_management/users`)).toBeGreaterThanOrEqual(1);
      expect(attempts[0]?.route).toBe(`POST ${workos}/_emulate/seed`);
      expect(
        attempts.slice(1).every(({ route }) => route === `GET ${workos}/user_management/users`),
      ).toBe(true);
      withinDeadline(attempts, organizationClock.noted);
      expect(Exit.isFailure(organization.exit)).toBe(true);
    }),
  );

  it.effect("every harness process that calls out waits 2.5 s per address, not Node's 250 ms", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      // Node's default on the pinned Node, which made a slow two-address connect fail in ~500 ms.
      const read = (code: string) =>
        Effect.gen(function* () {
          const child = yield* processes.spawn(
            ChildProcess.make(process.execPath, ["--input-type=module", "-e", code]),
          );
          const [out] = yield* Effect.all(
            [child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
            { concurrency: "unbounded" },
          );
          return Number(out.trim());
        }).pipe(Effect.scoped);
      const value = `import net from "node:net"; console.log(net.getDefaultAutoSelectFamilyAttemptTimeout());`;
      expect(yield* read(value)).toBe(250);
      expect(yield* read(`import "./e2e/support/connect-timeout.ts"; ${value}`)).toBe(2_500);
      // Each entry point that makes outbound calls imports it before anything else, and so does
      // every setup file of the Vitest config the targets run under, so each worker has it.
      const first = (text: string) => text.match(/^import (?:[^;]*? from )?"([^"]+)";/m)?.[1];
      const callers: Array<string> = [];
      for (const name of (yield* fs.readDirectory("e2e")).toSorted()) {
        if (!name.endsWith(".ts")) continue;
        const text = yield* fs.readFileString(`e2e/${name}`);
        if (
          /NodeRuntime\.runMain/.test(text) &&
          /FetchHttpClient|runSuite\(|runDeployedSuite|startDeployment/.test(text)
        ) {
          callers.push(`e2e/${name}`);
          expect(first(text), name).toBe("./support/connect-timeout.ts");
        }
      }
      expect(callers).toEqual([
        "e2e/cleanup-deployed.ts",
        "e2e/cli.ts",
        "e2e/create-emulators.ts",
        "e2e/deployed.ts",
        "e2e/run.ts",
      ]);
      const config = yield* fs.readFileString("e2e/vitest.config.ts");
      const setupFiles = [...config.matchAll(/setupFiles: \[([^\]]*)\]/g)].flatMap((match) =>
        [...match[1]!.matchAll(/"([^"]+)"/g)].map((file) => file[1]!),
      );
      expect(setupFiles.length).toBeGreaterThan(0);
      for (const file of setupFiles)
        expect(first(yield* fs.readFileString(file)), file).toBe("./support/connect-timeout.ts");
    }),
  );
});
