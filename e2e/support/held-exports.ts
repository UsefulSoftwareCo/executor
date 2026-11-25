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

export const refuseExports = (retryAfterSeconds: number) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const url = yield* collectorUrl;
    const control = (path: string) =>
      Effect.scoped(http.post(`${url}/api/e2e/exports/${path}`)).pipe(
        Effect.flatMap((response) =>
          response.status === 204
            ? Effect.void
            : Effect.die(`The collector did not change refusals: ${response.status}`),
        ),
        Effect.orDie,
      );
    yield* Effect.acquireRelease(control(`refuse?retryAfter=${retryAfterSeconds}`), () =>
      control("accept"),
    );
  });

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
