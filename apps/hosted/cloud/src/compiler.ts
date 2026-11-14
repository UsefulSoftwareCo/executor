/** Private compiler entry point. The esbuild WASM module belongs only to this Worker. */
import { WorkerEnvironment } from "alchemy/Cloudflare";
import { CodeFiles, RuntimeBuildFailed } from "@executor-js/sdk/core";
import { CloudCompileResult } from "./contracts/builds.ts";
import { withRemoteSpan } from "@executor-js/telemetry";
import { Config, Effect, Option, Predicate, Schema } from "effect";
import { compileCloudApp } from "./implementation/app-build.ts";
import { makeBuildAdmission } from "./implementation/build-admission.ts";
import {
  cloudObservability,
  cloudTelemetry,
  telemetryBindings,
} from "./infrastructure/telemetry.ts";
import { AppCompiler } from "./infrastructure/compiler.ts";
import { workerBuild } from "./infrastructure/worker-build.ts";

const FrameworkAssets = Schema.declare(
  (value): value is { readonly fetch: (request: Request) => Promise<Response> } =>
    Predicate.isObject(value) && "fetch" in value && typeof value.fetch === "function",
);
const FrameworkFiles = Schema.Record(Schema.String, Schema.String);

export default AppCompiler.make(
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url };
    // Only a test stage deploy supplies its checkout's `apps` package, as this Worker's own assets.
    const framework = yield* Config.String("EXECUTOR_APPS_FRAMEWORK").pipe(Config.option);
    return {
      main: import.meta.url,
      ...(yield* cloudObservability),
      workersDev: false,
      build: workerBuild("compiler"),
      compatibility: { date: "2026-09-08", flags: ["nodejs_compat", "no_brotli_content_encoding"] },
      env: yield* telemetryBindings,
      ...(Option.isSome(framework) ? { assets: { directory: framework.value } } : {}),
    };
  }),
  Effect.gen(function* () {
    // Resolved during initialization so Alchemy binds them into the Worker environment. Only local
    // Cloud development and tests set a registry; deployed stages use the public registry. Only a
    // test stage deploy sets an `apps` version, whose package files this Worker serves itself.
    const registry = Option.getOrUndefined(
      yield* Config.String("EXECUTOR_NPM_REGISTRY").pipe(Config.option),
    );
    const version = yield* Config.String("EXECUTOR_APPS_VERSION").pipe(Config.option);
    const env = yield* WorkerEnvironment;
    const read = Effect.gen(function* () {
      const assets = yield* Schema.decodeUnknownEffect(FrameworkAssets)(env.ASSETS);
      const response = yield* Effect.tryPromise(() =>
        assets.fetch(new Request("https://framework.invalid/framework.json")),
      );
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(FrameworkFiles))(
        yield* Effect.tryPromise(() => response.text()),
      );
    }).pipe(
      Effect.mapError(() => new RuntimeBuildFailed({ stage: "dependencies", dependency: "apps" })),
    );
    // Only read files are kept for later compiles. A compile that finds none reads them itself:
    // waiting on another request's read would resume in that request's I/O context, whose timers
    // are dropped when it ends, and the compile would never finish.
    let kept: typeof FrameworkFiles.Type | undefined;
    const files = Effect.suspend(() =>
      kept !== undefined
        ? Effect.succeed(kept)
        : read.pipe(
            Effect.tap((value) =>
              Effect.sync(() => {
                kept = value;
              }),
            ),
          ),
    );
    // Two builds still overlap one's npm downloads with the other's bundling, and a build
    // stalled on the registry leaves the other slot free. A slot is reclaimed after the API's
    // own compiler deadline, when no caller still waits for that build.
    const admitted = makeBuildAdmission(2, "50 seconds");
    const host = {
      ...(registry === undefined ? {} : { registry }),
      ...(Option.isSome(version) ? { apps: { version: version.value, files } } : {}),
    };
    return AppCompiler.of({
      compile: (files, publicPaths, headers) =>
        Schema.decodeUnknownEffect(
          Schema.Struct({ files: CodeFiles, publicPaths: Schema.Array(Schema.String) }),
        )({ files, publicPaths }).pipe(
          Effect.mapError(() => new RuntimeBuildFailed({ stage: "source" })),
          Effect.flatMap((input) =>
            admitted(compileCloudApp(input.files, host, input.publicPaths)),
          ),
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catchTags({
            RuntimeBuildFailed: (error) => Effect.succeed({ ok: false as const, error }),
            RuntimeProtocolUnsupported: (error) => Effect.succeed({ ok: false as const, error }),
            RuntimeAppsDependencyMissing: (error) => Effect.succeed({ ok: false as const, error }),
          }),
          Effect.flatMap(Schema.encodeEffect(CloudCompileResult)),
          Effect.orDie,
          withRemoteSpan(new Request("https://compiler.internal", { headers }), "compiler.compile"),
        ),
    });
  }).pipe(Effect.provide(cloudTelemetry)),
);
