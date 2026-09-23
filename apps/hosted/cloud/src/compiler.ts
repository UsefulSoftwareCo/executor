/** Private compiler entry point. The esbuild WASM module belongs only to this Worker. */
import { RuntimeBuildFailed, SourceFiles } from "@executor-js/sdk/core";
import { withRemoteSpan } from "@executor-js/telemetry";
import { Effect, Schema } from "effect";
import { compileCloudApp } from "./implementation/app-build.ts";
import {
  cloudObservability,
  cloudTelemetry,
  telemetryBindings,
} from "./infrastructure/telemetry.ts";
import { AppCompiler } from "./infrastructure/compiler.ts";

export default AppCompiler.make(
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url };
    return {
      main: import.meta.url,
      ...(yield* cloudObservability),
      workersDev: false,
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
      env: yield* telemetryBindings,
    };
  }),
  Effect.succeed(
    AppCompiler.of({
      compile: (files, headers) =>
        Schema.decodeUnknownEffect(SourceFiles)(files).pipe(
          Effect.mapError(() => new RuntimeBuildFailed({ stage: "source" })),
          Effect.flatMap(compileCloudApp),
          withRemoteSpan(new Request("https://compiler.internal", { headers }), "compiler.compile"),
        ),
    }),
  ).pipe(Effect.provide(cloudTelemetry)),
);
