/** Private cache of immutable executable builds. Invocation context never enters this store. */
import { type BuildId, type RuntimeBuildUnavailable } from "@executor-js/sdk/core";
import { RetainedWorkerBuild } from "@executor-js/sdk/workerd";
import { Effect, FiberSet, Schema } from "effect";

class BuildCacheFailed extends Schema.TaggedError<BuildCacheFailed>()("BuildCacheFailed", {}) {}
const cached = <A>(read: () => Promise<A>) =>
  Effect.tryPromise({ try: read, catch: () => new BuildCacheFailed() });
const encodedBuild = Schema.fromJsonString(RetainedWorkerBuild);

/** Own writes in the event scope; return a loader that falls back to authoritative storage.
 * Each hit is decoded afresh, including WASM modules, before it reaches the runtime.
 */
export const cachedRuntimeBuilds = <R>(
  origin: string,
  load: (
    build: BuildId,
  ) => Effect.Effect<typeof RetainedWorkerBuild.Type, RuntimeBuildUnavailable, R>,
) =>
  Effect.gen(function* () {
    const writes = yield* FiberSet.make();
    yield* Effect.addFinalizer(() =>
      FiberSet.awaitEmpty(writes).pipe(Effect.timeoutOption("2 seconds"), Effect.asVoid),
    );
    return (build: BuildId) =>
      Effect.gen(function* () {
        // Separate from browser assets. No route serves this synthetic URL.
        const key = new URL(`/_executor/runtime-build-cache/${encodeURIComponent(build)}`, origin)
          .href;
        const cache = yield* cached(() => caches.open("executor-private-runtime-builds-v1")).pipe(
          Effect.catchTag("BuildCacheFailed", () => Effect.succeed(undefined)),
        );
        const hit =
          cache === undefined
            ? undefined
            : yield* cached(() => cache.match(key)).pipe(
                Effect.flatMap((response) =>
                  response === undefined
                    ? Effect.succeed(undefined)
                    : cached(() => response.text()).pipe(
                        Effect.flatMap(Schema.decodeUnknownEffect(encodedBuild)),
                      ),
                ),
                Effect.catchTags({
                  BuildCacheFailed: () => Effect.succeed(undefined),
                  SchemaError: () => Effect.succeed(undefined),
                }),
              );
        yield* Effect.annotateCurrentSpan(
          "executor.build.cache",
          hit === undefined ? "miss" : "hit",
        );
        if (hit !== undefined) return hit;
        const bundle = yield* load(build);
        if (cache !== undefined) {
          // Encode only the retained code/metadata schema. Credentials, query results,
          // bindings, account identity and authorization are supplied per invocation.
          yield* FiberSet.run(
            writes,
            Schema.encodeEffect(encodedBuild)(bundle).pipe(
              Effect.flatMap((body) =>
                cached(() =>
                  cache.put(
                    key,
                    new Response(body, {
                      headers: {
                        "content-type": "application/json",
                        "cache-control": "public, max-age=31536000",
                      },
                    }),
                  ),
                ),
              ),
              Effect.catchTags({
                BuildCacheFailed: () => Effect.logWarning("Runtime build cache write failed"),
                SchemaError: () => Effect.logWarning("Runtime build cache encoding failed"),
              }),
            ),
          );
        }
        return bundle;
      }).pipe(Effect.withSpan("runtime.cloud.build.cached"));
  });
