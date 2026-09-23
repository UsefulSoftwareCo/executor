import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Fiber, Layer, Tracer } from "effect";
import { TestClock } from "effect/testing";
import {
  HttpEffect,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { requestTiming } from "../src/http.ts";
import { browserRequestTiming } from "../src/browser-request-timing.ts";

const traceId = "1234567890abcdef1234567890abcdef";
const ray = "1234567890abcdef-SJC";

test("the response exposes handler time and trace correlation without waiting for cleanup", async () => {
  let cleaned = false;
  let serverSpan: string | undefined;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const delivered = yield* Deferred.make<HttpServerResponse.HttpServerResponse>();
        const request = HttpServerRequest.fromWeb(
          new Request("https://fixture.test/api?token=secret", {
            headers: { "cf-ray": ray, authorization: "Bearer private-key" },
          }),
        );
        const handler = Effect.gen(function* () {
          serverSpan = (yield* Effect.currentSpan).spanId;
          yield* Effect.addFinalizer(() =>
            Deferred.await(release).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  cleaned = true;
                }),
              ),
            ),
          );
          yield* Deferred.succeed(started, undefined);
          yield* Effect.sleep("163 millis");
          return HttpServerResponse.text("ready", {
            status: 202,
            headers: { "server-timing": "upstream;dur=12", "cache-control": "no-store" },
          });
        });
        const fiber = yield* HttpEffect.toHandled(requestTiming(handler), (_request, response) =>
          Deferred.succeed(delivered, response),
        ).pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
          Effect.withSpan("http.server GET"),
          Effect.withParentSpan(Tracer.externalSpan({ traceId, spanId: "1234567890abcdef" })),
          Effect.forkScoped,
        );
        yield* Deferred.await(started);
        yield* TestClock.adjust("163 millis");
        try {
          const response = yield* Deferred.await(delivered);
          assert.equal(response.status, 202);
          assert.equal(response.headers["cache-control"], "no-store");
          assert.equal(
            response.headers["server-timing"],
            `upstream;dur=12, executor;dur=163, executor-trace;desc="${traceId}", executor-span;desc="${serverSpan}", executor-sampled;desc="1", cf-ray;desc="${ray}"`,
          );
          assert.equal(cleaned, false);
          assert.doesNotMatch(JSON.stringify(response.headers), /private-key|secret/);
        } finally {
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(fiber);
        }
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
  assert.equal(cleaned, true);
});

test("unexpected failure responses retain timing and Ray correlation", async () => {
  const web = HttpRouter.toWebHandler(
    HttpRouter.add(
      "GET",
      "/",
      requestTiming(Effect.die(new Error("synthetic handler failure"))),
    ).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );
  try {
    const response = await web.handler(
      new Request("https://fixture.test/", { headers: { "cf-ray": ray } }),
    );
    assert.equal(response.status, 500);
    assert.match(response.headers.get("server-timing") ?? "", /executor;dur=\d+/);
    assert.ok(response.headers.get("server-timing")?.includes(ray));
  } finally {
    await web.dispose();
  }
});

const entry = {
  name: "https://fixture.test/api/apps?secret=hidden",
  startTime: 100,
  duration: 1463,
  domainLookupStart: 100,
  domainLookupEnd: 105,
  connectStart: 105,
  connectEnd: 130,
  secureConnectionStart: 110,
  requestStart: 135,
  responseStart: 1561,
  responseEnd: 1563,
  serverTiming: [
    { name: "executor", description: "", duration: 163 },
    { name: "executor-trace", description: traceId, duration: 0 },
    { name: "executor-span", description: "abcdef1234567890", duration: 0 },
    { name: "executor-sampled", description: "1", duration: 0 },
    { name: "cf-ray", description: ray, duration: 0 },
  ],
};

test("browser timing retains the unexplained wait and correlates it without recording URLs", () => {
  const value = browserRequestTiming(entry, "https://fixture.test");
  assert.deepEqual(value, {
    "executor.trace_id": traceId,
    "executor.span_id": "abcdef1234567890",
    "executor.trace_sampled": 1,
    "cloudflare.ray_id": "1234567890abcdef",
    "browser.request.duration_ms": 1463,
    "browser.request.dns_ms": 5,
    "browser.request.connection_ms": 25,
    "browser.request.tls_ms": 20,
    "browser.request.waiting_for_headers_ms": 1426,
    "browser.request.body_ms": 2,
    "browser.request.time_to_first_byte_ms": 1461,
    "executor.handler.duration_ms": 163,
  });
  assert.doesNotMatch(JSON.stringify(value), /hidden|secret|cold/);
});

test("telemetry exports, foreign origins and malformed timings are excluded", () => {
  for (const name of [
    "https://fixture.test/api/telemetry/traces",
    "https://fixture.test/_executor/api/telemetry/logs",
    "https://fixture.test/dashboard/api/telemetry/traces?batch=1",
    "https://other.test/api/apps",
    "not a URL",
  ])
    assert.equal(browserRequestTiming({ ...entry, name }, "https://fixture.test"), undefined);
  for (const changed of [
    { deliveryType: "cache" },
    { transferSize: 0, decodedBodySize: 100 },
    { serverTiming: [] },
    { duration: Infinity },
    { responseEnd: -1 },
    { serverTiming: [{ name: "executor-trace", description: "not-a-trace", duration: 0 }] },
  ])
    assert.equal(browserRequestTiming({ ...entry, ...changed }, "https://fixture.test"), undefined);
});

test("a request starting at the browser time origin still has a TTFB measurement", () => {
  const value = browserRequestTiming({ ...entry, startTime: 0 }, "https://fixture.test");
  assert.equal(value?.["browser.request.time_to_first_byte_ms"], 1561);
});

test("restricted connection timings stay unknown instead of becoming zero-cost connections", () => {
  const value = browserRequestTiming(
    {
      ...entry,
      domainLookupStart: 0,
      domainLookupEnd: 0,
      connectStart: 0,
      connectEnd: 0,
      secureConnectionStart: 0,
    },
    "https://fixture.test",
  );
  assert.ok(value);
  assert.equal(value["browser.request.dns_ms"], undefined);
  assert.equal(value["browser.request.connection_ms"], undefined);
  assert.equal(value["browser.request.tls_ms"], undefined);
  assert.equal(value["browser.request.duration_ms"], 1463);
});
