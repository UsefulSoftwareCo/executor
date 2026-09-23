import { workerModules } from "@executor-js/app-data/worker-bundle";
/** Test-only Worker exposing compilation and retained-object reads against real workerd/R2. */
import type { R2Bucket, WorkerLoader } from "@cloudflare/workers-types";
import {
  BlobStore,
  BlobStoreError,
  BuildId,
  RuntimeBuildFailed,
  SourceFiles,
} from "@executor-js/sdk/core";
import { Effect, Option, Schema } from "effect";
import { compileCloudApp } from "../../src/implementation/app-build.ts";
import {
  cloudBuildAsset,
  loadCloudBuild,
  retainCloudBuild,
} from "../../src/implementation/build-storage.ts";

interface Env {
  readonly BUILDS: R2Bucket;
  readonly LOADER: WorkerLoader;
}
const Input = Schema.Struct({ build: BuildId, files: SourceFiles });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const failed = () => new BlobStoreError({ operation: "get" });
    const blobs = BlobStore.of({
      get: (key) =>
        Effect.tryPromise({ try: () => env.BUILDS.get(key), catch: failed }).pipe(
          Effect.flatMap((object) =>
            object === null
              ? Effect.succeed(Option.none())
              : Effect.tryPromise({ try: () => object.arrayBuffer(), catch: failed }).pipe(
                  Effect.map((body) => Option.some(new Uint8Array(body))),
                ),
          ),
        ),
      put: (key, body) =>
        request.headers.get("x-fail-retention") === "yes" && key.includes("/ui/")
          ? Effect.fail(new BlobStoreError({ operation: "put" }))
          : Effect.tryPromise({
              try: () => env.BUILDS.put(key, body),
              catch: () => new BlobStoreError({ operation: "put" }),
            }).pipe(Effect.asVoid),
      remove: (key) =>
        Effect.tryPromise({
          try: () => env.BUILDS.delete(key),
          catch: () => new BlobStoreError({ operation: "remove" }),
        }),
    });
    return Effect.runPromise(
      Effect.gen(function* () {
        if (url.pathname === "/build") {
          const input = yield* Effect.promise(() => request.json()).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Input)),
          );
          const compiled = yield* compileCloudApp(input.files);
          const ui = yield* retainCloudBuild(
            input.build,
            { ...compiled.bundle, database: false },
            compiled.ui,
          );
          return Response.json({ build: input.build, ui: ui ?? null });
        }
        const build = yield* Schema.decodeUnknownEffect(BuildId)(url.searchParams.get("build"));
        if (url.pathname === "/asset") {
          const asset = yield* cloudBuildAsset(build, url.searchParams.get("path") ?? "");
          return asset === undefined
            ? new Response(null, { status: 404 })
            : new Response(new Uint8Array(asset.body), {
                headers: { "content-type": asset.contentType },
              });
        }
        const bundle = yield* loadCloudBuild(build);
        if (url.pathname === "/invoke") {
          const worker = env.LOADER.get(null, () => ({
            mainModule: bundle.mainModule,
            modules: workerModules(bundle.modules),
            compatibilityDate: "2026-07-30",
            compatibilityFlags: ["nodejs_compat"],
          }));
          const response = yield* Effect.tryPromise(() =>
            worker.getEntrypoint().fetch("https://app.internal/dispatch", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                command: { operation: "call", tool: "queries.greet", input: {} },
                accounts: {},
              }),
            }),
          );
          return new Response(yield* Effect.promise(() => response.text()), {
            status: response.status,
          });
        }
        return Response.json(bundle);
      }).pipe(
        Effect.provideService(BlobStore, blobs),
        Effect.catch((error) =>
          Effect.succeed(
            Response.json(
              Schema.is(RuntimeBuildFailed)(error)
                ? { stage: error.stage }
                : { error: "unavailable" },
              { status: 422 },
            ),
          ),
        ),
      ),
    );
  },
};
