/**
 * Hold the telemetry exports a managed local Cloud sends to this suite's collector, as an export
 * endpoint that hangs: each export is accepted and left unanswered until the scope that held them
 * closes (`serveShardedOtlpCollector`). Every scenario of that Cloud exports to the same collector,
 * so only a scenario with a local Cloud of its own may hold them. A scenario can also watch a trace
 * and read back how many of its spans the collector received, and how many it received twice.
 */
import { Effect, FileSystem, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Collector } from "./contracts.ts";
import { Target } from "./platform.ts";

const collectorUrl = Effect.gen(function* () {
  const target = yield* Target;
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(`${target.directory}/data/diagnostics/collector.json`).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Collector))),
    Effect.map((collector) => collector.url),
    Effect.orDie,
  );
});

export const holdExports = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const url = yield* collectorUrl;
  const control = (action: "hold" | "release") =>
    Effect.scoped(http.post(`${url}/api/e2e/exports/${action}`)).pipe(
      Effect.flatMap((response) =>
        response.status === 204
          ? Effect.void
          : Effect.die(`The collector did not ${action} exports: ${response.status}`),
      ),
      Effect.orDie,
    );
  yield* Effect.acquireRelease(control("hold"), () => control("release"));
});

/** Count the spans the collector receives for `trace` from now on. */
export const watchTrace = (trace: string) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const url = yield* collectorUrl;
    yield* Effect.scoped(
      http.post(`${url}/api/e2e/exports/watch?trace=${encodeURIComponent(trace)}`),
    ).pipe(
      Effect.flatMap((response) =>
        response.status === 204
          ? Effect.void
          : Effect.die(`The collector did not watch the trace: ${response.status}`),
      ),
      Effect.orDie,
    );
  });

const Received = Schema.Struct({ spans: Schema.Number, duplicated: Schema.Number });

/** The spans of a watched trace the collector received, and how many of them more than once. */
export const receivedSpans = (trace: string) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const url = yield* collectorUrl;
    return yield* Effect.scoped(
      http
        .get(`${url}/api/e2e/exports/received?trace=${encodeURIComponent(trace)}`)
        .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Received))),
    ).pipe(Effect.orDie);
  });
