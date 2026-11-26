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
