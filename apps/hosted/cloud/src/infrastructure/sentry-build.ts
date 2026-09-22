/** Collect exactly this Worker's output for Sentry; Alchemy's bundle folder retains older builds. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { WorkerProps } from "alchemy/Cloudflare";
import { Effect, FileSystem, Path } from "effect";

/** A Rolldown output hook copies unchanged artifacts before Cloudflare uploads them. */
export const sentryWorkerBuild = (
  worker: "api" | "app-pages",
): NonNullable<WorkerProps["build"]> => ({
  output: {
    entryFileNames: `${worker}-[name].js`,
    chunkFileNames: `${worker}-[name]-[hash].js`,
    // Normal ESM ordering avoids an initializer wrapper around every module.
    // This graph is covered by the workerd MCP and app-UI tests; keep source maps for diagnostics.
    strictExecutionOrder: false,
    keepNames: false,
    sourcemap: "hidden",
    plugins: [
      {
        name: "executor-sentry-artifacts",
        writeBundle: (_options, bundle) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const directory = yield* path.fromFileUrl(
                new URL(`../../.generated/sentry-worker/${worker}`, import.meta.url),
              );
              yield* fs.remove(directory, { recursive: true, force: true });
              yield* fs.makeDirectory(directory, { recursive: true });
              for (const [name, output] of Object.entries(bundle)) {
                if (!name.endsWith(".js") && !name.endsWith(".map")) continue;
                const target = path.join(directory, name);
                yield* fs.makeDirectory(path.dirname(target), { recursive: true });
                const contents = output.type === "chunk" ? output.code : output.source;
                if (typeof contents === "string") yield* fs.writeFileString(target, contents);
                else yield* fs.writeFile(target, contents);
              }
            }).pipe(Effect.provide(NodeServices.layer)),
          ),
      },
    ],
  },
});
