import { expect, test } from "@effect/vitest";
import { FetchHttpClient } from "effect/unstable/http";
import { Effect, Layer } from "effect";

import { makeTelemetryLive } from "./telemetry";

// The layer is opaque, so these assert the observable consequence rather than
// its shape: what the exporter puts on the wire, and — for the default — that
// nothing goes on the wire at all.
test("sends nothing when no OTLP endpoint is configured", async () => {
  expect(await captureExports({}, { log: true })).toEqual([]);
});

test("exports spans when the base endpoint is set", async () => {
  const requests = await captureExports({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.test" });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.method).toBe("POST");
});

// The signal endpoint is already a full URL; appending /v1/traces to it would
// POST to /v1/traces/v1/traces, which a collector answers with a 404 the
// operator never sees. Asserted on the request the exporter actually makes.
test("does not append a second signal path to an explicit traces endpoint", async () => {
  const urls = await captureExportUrls({
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector.test/v1/traces",
  });
  expect(urls).toEqual(["http://collector.test/v1/traces"]);
});

test("appends the signal path to a base endpoint, trailing slash or not", async () => {
  expect(await captureExportUrls({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.test" })).toEqual(
    ["http://collector.test/v1/traces"],
  );
  expect(
    await captureExportUrls({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.test///" }),
  ).toEqual(["http://collector.test/v1/traces"]);
});

test("sends configured headers so a hosted collector can authenticate", async () => {
  const headers = await captureExportHeaders({
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.test",
    OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer tok, x-dataset=executor",
  });
  expect(headers?.authorization).toBe("Bearer tok");
  expect(headers?.["x-dataset"]).toBe("executor");
});

// A collector that is down, unreachable through the tunnel, or answering 500
// must never take the request that produced the span with it — the operator
// enabled tracing to diagnose a problem, not to acquire a new one.
test("a failing collector does not fail the traced effect", async () => {
  const result = await Effect.runPromise(
    Effect.succeed("served").pipe(
      Effect.withSpan("probe"),
      Effect.provide(
        makeTelemetryLive({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.test" }).pipe(
          Layer.provide(stubFetch(() => new Response("boom", { status: 500 }))),
        ),
      ),
      Effect.scoped,
    ),
  );
  expect(result).toBe("served");
});

test("log export stays off unless separately opted in", async () => {
  const base = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.test" };
  expect(await captureExportUrls(base, { log: true })).toEqual(["http://collector.test/v1/traces"]);
  expect(
    await captureExportUrls({ ...base, EXECUTOR_OTEL_EXPORT_LOGS: "true" }, { log: true }),
  ).toEqual(
    expect.arrayContaining(["http://collector.test/v1/traces", "http://collector.test/v1/logs"]),
  );
});

// With only a traces endpoint there is no base to derive a logs URL from.
// Guessing one would POST logs to a path the operator never named.
test("log export needs its own endpoint when only traces is configured", async () => {
  const urls = await captureExportUrls(
    {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector.test/v1/traces",
      EXECUTOR_OTEL_EXPORT_LOGS: "true",
    },
    { log: true },
  );
  expect(urls).toEqual(["http://collector.test/v1/traces"]);
});

// --- helpers ---------------------------------------------------------------

// `Fetch` is a Context.Reference with `globalThis.fetch` as its default, so
// setting it discharges no requirement — the layer is `Layer<never>` and works
// by overriding the default in whatever context it is provided to.
const stubFetch = (respond: (request: Request) => Response): Layer.Layer<never> =>
  Layer.succeed(FetchHttpClient.Fetch)(((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(
      respond(input instanceof Request ? input : new Request(String(input), init)),
    )) as typeof globalThis.fetch);

/**
 * Runs a traced effect against a recording fetch and returns the URLs the
 * exporter posted to. The layer's shutdown flush is what forces the export, so
 * the effect is scoped and the scope closed before reading.
 */
const captureExportUrls = async (
  env: Record<string, string | undefined>,
  options?: { readonly log?: boolean },
): Promise<Array<string>> => (await captureExports(env, options)).map((request) => request.url);

const captureExportHeaders = async (
  env: Record<string, string | undefined>,
): Promise<Record<string, string> | undefined> => {
  const requests = await captureExports(env);
  const headers = requests[0]?.headers;
  return headers ? Object.fromEntries(headers.entries()) : undefined;
};

const captureExports = async (
  env: Record<string, string | undefined>,
  options?: { readonly log?: boolean },
): Promise<Array<Request>> => {
  const seen: Array<Request> = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      if (options?.log) yield* Effect.logInfo("probe log");
    }).pipe(
      Effect.withSpan("probe"),
      Effect.provide(
        makeTelemetryLive(env).pipe(
          Layer.provide(
            stubFetch((request) => {
              seen.push(request);
              return new Response(null, { status: 200 });
            }),
          ),
        ),
      ),
      Effect.scoped,
    ),
  );
  return seen;
};
