/** Install declared npm packages only when the authored import graph reaches them. */
import { installDependencies, type InMemoryFileSystem } from "@cloudflare/worker-bundler";
import { captureTelemetry } from "@executor-js/telemetry";
import { Effect, Schema, Semaphore } from "effect";
import type { WorkerHost } from "./worker-build.ts";
import type { Plugin } from "esbuild";
import { boundBuildMessage, describeBuildCause, RuntimeBuildFailed } from "../contracts/runtime.ts";
import tailwind from "tailwindcss/package.json" with { type: "json" };
import { withoutUrlSecrets } from "@executor-js/utils/url-policy";

const Package = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

/**
 * Framework archives are loaded alone; direct npm imports retain their authored declarations and
 * dependency graphs. `registry` replaces the public npm registry when the host configures one.
 * The installer's errors quote the URLs it fetched, which start with that registry. An operator's
 * registry URL can carry credentials or a token, and the deployer reading a failed build is not
 * always the operator, so a failure loses each URL's userinfo, query and fragment. A token the
 * registry takes as a path segment is kept and reaches the deployer: it cannot be told from a path.
 */
export const workerDependencies = (filesystem: InMemoryFileSystem, host: WorkerHost) =>
  Effect.gen(function* () {
    const { registry } = host;
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
                { transitive, ...(registry === undefined ? {} : { registry }) },
              ),
            catch: (cause) =>
              new RuntimeBuildFailed({
                stage: "dependencies",
                dependency: name,
                message: boundBuildMessage(
                  withoutUrlSecrets(
                    `Installing ${name}@${version} failed: ${describeBuildCause(cause)}`,
                  ),
                ),
              }),
          });
          if (
            result.warnings.length > 0 ||
            filesystem.read(`node_modules/${name}/package.json`) === null
          )
            return yield* new RuntimeBuildFailed({
              stage: "dependencies",
              dependency: name,
              message: boundBuildMessage(
                withoutUrlSecrets(
                  result.warnings.length > 0
                    ? `Installing ${name}@${version} failed: ${result.warnings.join("; ")}`
                    : `Installing ${name}@${version} did not produce node_modules/${name}/package.json.`,
                ),
              ),
            });
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
          if (
            args.kind === "import-rule" &&
            (args.path === "tailwindcss" || args.path.startsWith("tailwindcss/"))
          ) {
            await Effect.runPromiseWith(context)(install("tailwindcss", tailwind.version, false));
            return undefined;
          }
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
          : dependencies.apps === host.apps?.version
            ? host.apps.files.pipe(
                Effect.map((files) => {
                  for (const [path, content] of Object.entries(files))
                    filesystem.write(`node_modules/apps/${path}`, content);
                  return true;
                }),
              )
            : install("apps", dependencies.apps, false).pipe(Effect.as(true)),
    };
  }).pipe(
    Effect.catchTag("SchemaError", (cause) =>
      Effect.fail(
        new RuntimeBuildFailed({
          stage: "dependencies",
          location: { file: "package.json" },
          message: boundBuildMessage(`package.json is invalid: ${cause.message}`),
        }),
      ),
    ),
  );
