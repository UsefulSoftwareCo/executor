/** Install declared npm packages only when the authored import graph reaches them. */
import { installDependencies, type InMemoryFileSystem } from "@cloudflare/worker-bundler";
import { captureTelemetry } from "@executor-js/telemetry";
import { Effect, Schema, Semaphore } from "effect";
import type { Plugin } from "esbuild";
import { RuntimeBuildFailed } from "../contracts/runtime.ts";

const Package = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

/** Framework archives are loaded alone; direct npm imports retain their authored declarations and dependency graphs. */
export const workerDependencies = (filesystem: InMemoryFileSystem) =>
  Effect.gen(function* () {
    const manifest = filesystem.read("package.json");
    const dependencies =
      manifest === null
        ? {}
        : ((yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Package))(manifest))
            .dependencies ?? {});
    const installLock = yield* Semaphore.make(1);
    const { context } = yield* captureTelemetry;
    const install = (name: string, version: string, transitive = true) =>
      installLock.withPermits(1)(
        Effect.gen(function* () {
          if (filesystem.read(`node_modules/${name}/package.json`) !== null) return;
          const result = yield* Effect.tryPromise({
            try: () =>
              installDependencies(
                {
                  // The installer sees one declaration; bundling still sees the unmodified manifest.
                  read: (path) =>
                    path === "package.json"
                      ? JSON.stringify({ dependencies: { [name]: version } })
                      : filesystem.read(path),
                  write: (path, value) => filesystem.write(path, value),
                  delete: (path) => filesystem.delete(path),
                  list: (prefix) => filesystem.list(prefix),
                  flush: () => filesystem.flush(),
                },
                { transitive },
              ),
            catch: () => new RuntimeBuildFailed({ stage: "dependencies", dependency: name }),
          });
          if (
            result.warnings.length > 0 ||
            filesystem.read(`node_modules/${name}/package.json`) === null
          )
            return yield* new RuntimeBuildFailed({ stage: "dependencies", dependency: name });
          yield* Effect.annotateCurrentSpan({
            "executor.build.installed_packages": result.installed.length,
          });
        }).pipe(Effect.withSpan("runtime.cloud.dependencies")),
      );
    const plugin: Plugin = {
      name: "executor-imported-dependencies",
      setup(build) {
        build.onResolve({ filter: /^[^./]/ }, async (args) => {
          if (args.path === "apps" || args.path.startsWith("apps/")) return undefined;
          const parts = args.path.split("/");
          const name = args.path.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
          if (name === undefined || !Object.hasOwn(dependencies, name)) return undefined;
          const version = dependencies[name];
          if (version === undefined) return undefined;
          await Effect.runPromiseWith(context)(install(name, version));
          // Let the existing resolver apply package exports, conditions, and asset handling.
          return undefined;
        });
      },
    };
    return {
      plugin,
      framework:
        dependencies.apps === undefined
          ? Effect.succeed(false)
          : install("apps", dependencies.apps, false).pipe(Effect.as(true)),
    };
  }).pipe(
    Effect.catchTag("SchemaError", () =>
      Effect.fail(new RuntimeBuildFailed({ stage: "dependencies" })),
    ),
  );
