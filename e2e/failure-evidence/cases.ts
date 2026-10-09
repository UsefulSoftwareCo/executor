/**
 * Cases that fail on purpose. failure-evidence.spec.ts runs them in their own Vitest process
 * against real self-host products and checks which traces their evidence kept.
 */
import { expect, layer } from "@effect/vitest";
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Clock, Deferred, Effect, Fiber, FileSystem, Layer, Schema, Scope } from "effect";
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { Api } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Collector } from "../support/contracts.ts";
import { Evidence, FailureTraceBudget } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";
import {
  caseDeadlineMs,
  failureCases,
  probePath,
  slowTraceRead,
  smallTraceBudget,
} from "./titles.ts";

const probes = Effect.gen(function* () {
  const api = yield* Api;
  const actor = yield* api.session();
  return (role: string) => api.request(actor, "GET", probePath(role));
});
const roles = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
/** The status a probe never has, so the assertion after the failing request always fails. */
const impossibleStatus = 299;
const cleanup = (
  probe: (role: string) => Effect.Effect<unknown, unknown>,
  prefix: string,
  count = 3,
) =>
  Effect.forEach(roles(prefix, count), (role) => probe(role).pipe(Effect.ignore), {
    discard: true,
  });
/**
 * Twenty concurrent requests. Each is slower than a probe sent alone, so the five slowest traces a
 * passing case keeps never include the failing request by chance.
 */
const warmup = (probe: (role: string) => Effect.Effect<unknown, unknown>) =>
  Effect.forEach(roles("warmup", 20), probe, { concurrency: 20, discard: true });
const failing = (probe: (role: string) => Effect.Effect<{ readonly status: number }, unknown>) =>
  probe("failing").pipe(
    Effect.tap((response) =>
      Effect.sync(() => expect(response.status, "the intended failure").toBe(impossibleStatus)),
    ),
  );

layer(TestLive, { excludeTestServices: true })("Failure evidence cases", (it) => {
  // The longest case starts first, so the others run beside it.
  it.effect(failureCases.slowCollector, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        const fs = yield* FileSystem.FileSystem;
        const http = yield* HttpClient.HttpClient;
        const evidence = yield* Evidence;
        const probe = yield* probes;
        // The parent scenario checks this origin refuses connections once the cases have ended.
        yield* evidence.json("product.json", { origin: target.metadata.origin });
        for (const role of roles("old", slowTraceRead.requests)) yield* probe(role);
        // Evidence reads traces through a proxy that holds every trace read.
        const file = `${target.directory}/data/diagnostics/collector.json`;
        const collector = yield* fs
          .readFileString(file)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Collector))));
        const answer = (response: HttpClientResponse.HttpClientResponse) =>
          response.arrayBuffer.pipe(
            Effect.map((bytes) =>
              HttpServerResponse.uint8Array(new Uint8Array(bytes), {
                status: response.status,
                contentType: response.headers["content-type"],
              }),
            ),
          );
        const read = Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.url.startsWith("/api/traces/")) yield* Effect.sleep(slowTraceRead.delayMs);
          return yield* answer(yield* http.get(new URL(request.url, collector.url).href));
        }).pipe(Effect.scoped);
        const write = Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const body = HttpBody.uint8Array(
            new Uint8Array(yield* request.arrayBuffer),
            request.headers["content-type"],
          );
          return yield* answer(
            yield* http.post(new URL(request.url, collector.url).href, { body }),
          );
        }).pipe(Effect.scoped);
        // Evidence reads through the proxy after this case's scopes close, so its scope is never
        // closed. The listener does not hold the process open; it ends with this process.
        const services = yield* Layer.buildWithScope(
          HttpRouter.serve(
            Layer.mergeAll(HttpRouter.add("GET", "/*", read), HttpRouter.add("POST", "/*", write)),
            { disableLogger: true, disableListenLog: true },
          ).pipe(
            Layer.provideMerge(
              NodeHttpServer.layer(() => createServer().unref(), { host: "127.0.0.1", port: 0 }),
            ),
          ),
          yield* Scope.make(),
        );
        const proxy = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
        if (!("port" in proxy.address)) return yield* Effect.die("The proxy must listen on TCP");
        const port = proxy.address.port;
        yield* fs.writeFileString(
          file,
          JSON.stringify({ state: "running", url: `http://127.0.0.1:${port}` }),
        );
        yield* failing(probe);
      }),
    ),
  );

  it.effect(failureCases.unanswered, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const probe = yield* probes;
        yield* probe("answered");
        // A stopped product answers nothing, so every later request stays unanswered.
        yield* serverControl("stop");
        for (const role of roles("unanswered", 10)) yield* probe(role).pipe(Effect.ignore);
        yield* probe("failing");
      }),
    ),
  );

  it.effect(failureCases.innerScope, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const probe = yield* probes;
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.forEach(roles("cleanup", 10), (role) => probe(role).pipe(Effect.ignore), {
                discard: true,
              }),
            );
            const response = yield* probe("failing");
            expect(response.status, "the intended failure").toBe(impossibleStatus);
          }),
        );
      }),
    ),
  );

  it.effect(failureCases.sameMillisecond, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence,
          probe = yield* probes,
          clock = yield* Clock.Clock;
        // Every request, step and failure below happens at the same clock time.
        const now = clock.currentTimeMillisUnsafe();
        const frozen: Clock.Clock = {
          currentTimeMillisUnsafe: () => now,
          currentTimeMillis: Effect.succeed(now),
          currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
          currentTimeNanos: Effect.succeed(BigInt(now) * 1_000_000n),
          monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
          monotonicTimeNanos: clock.monotonicTimeNanos,
          sleep: (duration) => clock.sleep(duration),
        };
        yield* evidence
          .step(
            "Fail after a request",
            Effect.gen(function* () {
              const response = yield* probe("failing");
              expect(response.status, "the intended failure").toBe(impossibleStatus);
            }),
          )
          .pipe(
            Effect.ensuring(
              Effect.forEach(roles("cleanup", 10), (role) => probe(role).pipe(Effect.ignore), {
                discard: true,
              }),
            ),
            Effect.provideService(Clock.Clock, frozen),
          );
      }),
    ),
  );

  it.effect(failureCases.nestedSteps, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence,
          probe = yield* probes;
        yield* evidence.step(
          "Outer step",
          Effect.gen(function* () {
            yield* probe("outer");
            // Clearly before the inner step, not in the millisecond it starts.
            yield* Effect.sleep("50 millis");
            yield* evidence.step(
              "Inner step",
              Effect.forEach(roles("inner", 4), probe, { discard: true }),
            );
            const response = yield* probe("failing");
            expect(response.status, "the intended failure").toBe(impossibleStatus);
          }),
        );
      }),
    ),
  );

  it.effect(
    failureCases.timeout,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const probe = yield* probes;
          yield* probe("before-deadline");
          return yield* Effect.never;
        }),
      ),
    caseDeadlineMs,
  );

  it.effect(
    failureCases.nearDeadline,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const started = yield* Clock.currentTimeMillis;
          const api = yield* Api;
          const actor = yield* api.session();
          yield* api.request(actor, "GET", probePath("answered"));
          yield* Effect.sleep(started + caseDeadlineMs - 1_500 - (yield* Clock.currentTimeMillis));
          // Api refuses a request to another origin before it leaves the test. No server span
          // ever answers it, so evidence waits its full five seconds, past this case's deadline.
          yield* api.request(actor, "GET", `http://elsewhere.invalid${probePath("failing")}`);
        }),
      ),
    caseDeadlineMs,
  );

  it.effect(failureCases.passing, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const probe = yield* probes;
        yield* Effect.forEach(roles("passing", 8), probe, { discard: true });
      }),
    ),
  );

  it.effect(failureCases.answeredAfterRefused, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actor = yield* api.session();
        yield* warmup((role) => api.request(actor, "GET", probePath(role)));
        const failing = yield* Effect.forkChild(api.request(actor, "GET", probePath("failing")), {
          startImmediately: true,
        });
        // Api refuses these before they leave the test, without yielding to the answer.
        for (const role of roles("refused", 16))
          yield* api
            .request(actor, "GET", `http://elsewhere.invalid${probePath(role)}`)
            .pipe(Effect.ignore);
        if (failing.pollUnsafe() !== undefined)
          return yield* Effect.die("The failing request answered before the refused ones");
        const response = yield* Fiber.join(failing);
        expect(response.status, "the intended failure").toBe(impossibleStatus);
      }),
    ),
  );

  it.effect(failureCases.retriedStep, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence,
          probe = yield* probes;
        // Both attempts fail with this one object.
        const failure = new Error("the intended failure");
        let attempt = 0;
        return yield* evidence
          .step(
            "Attempt",
            Effect.gen(function* () {
              attempt += 1;
              yield* Effect.forEach(roles(`attempt-${attempt}`, 12), probe, { discard: true });
              yield* probe(attempt === 1 ? "recovered" : "failing");
              return yield* Effect.fail(failure);
            }),
          )
          .pipe(Effect.retry({ times: 1 }));
      }),
    ),
  );

  it.effect(failureCases.reusedPrimitive, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence,
          probe = yield* probes;
        yield* evidence
          .step("Recovered", probe("recovered").pipe(Effect.andThen(Effect.fail("reused"))))
          .pipe(Effect.ignore);
        yield* Effect.forEach(roles("later", 12), probe, { discard: true });
        // The same primitive value, now outside any step.
        yield* probe("failing");
        return yield* Effect.fail("reused");
      }),
    ),
  );

  it.effect(failureCases.repeatedInterruption, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence,
          probe = yield* probes;
        const interrupted = (role: string) =>
          Effect.gen(function* () {
            yield* warmup(probe);
            const sent = yield* Deferred.make<void>();
            const fiber = yield* Effect.forkChild(
              evidence.step(
                role,
                probe(role).pipe(
                  Effect.andThen(Deferred.succeed(sent, undefined)),
                  Effect.andThen(Effect.never),
                ),
              ),
            );
            yield* Deferred.await(sent);
            yield* Fiber.interrupt(fiber);
            return fiber;
          });
        yield* interrupted("recovered");
        yield* Effect.forEach(roles("later", 12), probe, { discard: true });
        return yield* Fiber.join(yield* interrupted("failing"));
      }),
    ),
  );

  it.effect(failureCases.cleanupInStep, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence,
          probe = yield* probes;
        yield* evidence.step(
          "Fail with cleanup inside the step",
          Effect.gen(function* () {
            const scope = yield* Scope.make();
            yield* Scope.addFinalizerExit(scope, () => cleanup(probe, "scope-close"));
            const exit = yield* Effect.exit(
              Effect.acquireUseRelease(
                Effect.void,
                () =>
                  Effect.gen(function* () {
                    const response = yield* probe("failing");
                    expect(response.status, "the intended failure").toBe(impossibleStatus);
                  }),
                () => cleanup(probe, "release"),
              ).pipe(Effect.onExit(() => cleanup(probe, "on-exit"))),
            );
            // Closed by the step itself, as test code, not by a finalizer.
            yield* Scope.close(scope, exit);
            return yield* exit;
          }).pipe(Effect.ensuring(cleanup(probe, "ensuring"))),
        );
      }),
    ),
  );
  it.effect(failureCases.failedAcquire, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence,
          probe = yield* probes;
        yield* warmup(probe);
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => cleanup(probe, "cleanup", 4));
            // Effect runs the acquisition uninterruptibly, like cleanup.
            yield* evidence.step(
              "Acquire",
              Effect.acquireRelease(failing(probe), () => Effect.void),
            );
          }),
        );
      }),
    ),
  );

  it.effect(failureCases.backgroundAfterFailure, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence,
          probe = yield* probes;
        yield* warmup(probe);
        const sent = yield* Deferred.make<void>();
        const poller = yield* Effect.forkChild(
          Deferred.await(sent).pipe(
            Effect.andThen(evidence.step("Background poll", cleanup(probe, "background", 12))),
          ),
        );
        yield* evidence.step(
          "Main assertion",
          Effect.gen(function* () {
            const response = yield* probe("failing");
            yield* Deferred.succeed(sent, undefined);
            yield* Fiber.join(poller);
            expect(response.status, "the intended failure").toBe(impossibleStatus);
          }),
        );
      }),
    ),
  );

  it.effect(failureCases.failedCaseCleanup, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const probe = yield* probes;
        yield* warmup(probe);
        // The case's own finalizers: the failing one runs first, then four cleanup requests.
        yield* Effect.addFinalizer(() => cleanup(probe, "cleanup", 4));
        yield* Effect.addFinalizer(() => failing(probe).pipe(Effect.orDie));
        yield* probe("answered");
      }),
    ),
  );

  it.effect(failureCases.overBudget, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actor = yield* api.session();
        const probe = (role: string) => api.request(actor, "GET", probePath(role));
        // The oldest request never answers, so it is kept however old it is.
        yield* api
          .request(actor, "GET", `http://elsewhere.invalid${probePath("refused")}`)
          .pipe(Effect.ignore);
        yield* Effect.forEach(roles("old", 30), probe, { discard: true });
        yield* failing(probe);
      }),
    ).pipe(Effect.provideService(FailureTraceBudget, smallTraceBudget)),
  );
});
