/** Cache immutable, manifest-checked build bytes, never an HTTP authorization result. */
import { BlobKey, type BuildId, type RuntimeBuildUnavailable } from "@executor-js/sdk/core";
import type { AppUiAsset } from "apps/ui/contracts";
import { Effect, FiberSet, Option, Schema } from "effect";

class AssetCacheFailed extends Schema.TaggedError<AssetCacheFailed>()("AssetCacheFailed", {}) {}
const cached = <A>(read: () => Promise<A>) =>
  Effect.tryPromise({ try: read, catch: () => new AssetCacheFailed() });

/** The caller authorizes every request before this reader runs, including cache hits. */
export const cachedBuildAssets = (
  origin: string,
  load: (
    build: BuildId,
    path: string,
  ) => Effect.Effect<AppUiAsset | undefined, RuntimeBuildUnavailable>,
) =>
  Effect.gen(function* () {
    // Alchemy closes the event scope through waitUntil after sending the response.
    // Own cache writes there, without retaining an init-time Worker context.
    const writes = yield* FiberSet.make();
    yield* Effect.addFinalizer(() =>
      FiberSet.awaitEmpty(writes).pipe(Effect.timeoutOption("2 seconds"), Effect.asVoid),
    );
    return (build: BuildId, path: string) =>
      Effect.gen(function* () {
        if (Option.isNone(Schema.decodeUnknownOption(BlobKey)(`${build}/ui/${path}`)))
          return undefined;
        // A named Cache API store has no public HTTP route. The configured stage origin
        // isolates deployments; neither request headers nor query strings select a key.
        const key = new URL(
          `/_executor/build-cache/${encodeURIComponent(build)}/${encodeURIComponent(path)}`,
          origin,
        ).href;
        const cache = yield* cached(() => caches.open("executor-private-builds-v1")).pipe(
          Effect.catchTag("AssetCacheFailed", () => Effect.succeed(undefined)),
        );
        const hit =
          cache === undefined
            ? undefined
            : yield* cached(async () => {
                const response = await cache.match(key);
                if (response === undefined) return undefined;
                const contentType = response.headers.get("content-type");
                if (contentType === null) return undefined;
                return { body: new Uint8Array(await response.arrayBuffer()), contentType };
              }).pipe(Effect.catchTag("AssetCacheFailed", () => Effect.succeed(undefined)));
        yield* Effect.annotateCurrentSpan(
          "executor.asset.cache",
          hit === undefined ? "miss" : "hit",
        );
        if (hit !== undefined) return hit;
        const asset = yield* load(build, path);
        if (asset !== undefined && cache !== undefined) {
          // Only a successful manifest-checked read enters the cache. No sessions,
          // injected HTML, errors, missing files or browser response headers do.
          yield* FiberSet.run(
            writes,
            cached(() =>
              cache.put(
                key,
                new Response(new Uint8Array(asset.body), {
                  headers: {
                    "content-type": asset.contentType,
                    "cache-control": "public, max-age=31536000",
                  },
                }),
              ),
            ).pipe(
              Effect.catchTag("AssetCacheFailed", () =>
                Effect.logWarning("Build asset cache write failed"),
              ),
            ),
          );
        }
        return asset;
      }).pipe(Effect.withSpan("runtime.cloud.asset.cached"));
  });
