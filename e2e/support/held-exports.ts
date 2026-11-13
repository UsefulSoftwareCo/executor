/**
 * Hold the telemetry exports a managed local Cloud sends to this suite's collector, as an export
 * endpoint that hangs: each export is accepted and left unanswered until the scope that held them
 * closes (`serveShardedOtlpCollector`). Every scenario of that Cloud exports to the same collector,
 * so only a scenario with a local Cloud of its own may hold them.
 */
import { Effect, FileSystem, Schema } from "effect";
import { HttpClient } from "effect/http";
import { Collector } from "./contracts.ts";
import { Target } from "./platform.ts";

export const holdExports = Effect.gen(function* () {
  const target = yield* Target;
  const fs = yield* FileSystem.FileSystem;
  const http = yield* HttpClient.HttpClient;
  const collector = yield* fs
    .readFileString(`${target.directory}/data/diagnostics/collector.json`)
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Collector))),
      Effect.orDie,
    );
  const control = (action: "hold" | "release") =>
    Effect.scoped(http.post(`${collector.url}/api/e2e/exports/${action}`)).pipe(
      Effect.flatMap((response) =>
        response.status === 204
          ? Effect.void
          : Effect.die(`The collector did not ${action} exports: ${response.status}`),
      ),
      Effect.orDie,
    );
  yield* Effect.acquireRelease(control("hold"), () => control("release"));
});
