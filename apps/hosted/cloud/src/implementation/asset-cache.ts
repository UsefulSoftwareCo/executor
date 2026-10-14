/** Cache immutable, manifest-checked build bytes, never an HTTP authorization result. */
import {
  BlobKey,
  RuntimeBuildUnavailable,
  type BlobBody,
  type BlobRange,
  type BlobStoreError,
  type BuildId,
  type RuntimeAsset,
} from "@executor-js/sdk/core";
import { Effect, FiberSet, Option, Schema, Stream } from "effect";

/**
 * A public file is cached as its listing only: the response is empty and this header holds its
 * store key, blob and size. Its bytes always come from the store, in the range a request asks for.
 */
const publicHeader = "x-executor-public-file";
const PublicListing = Schema.fromJsonString(
  Schema.Struct({ key: BlobKey, object: Schema.String, size: Schema.Int }),
);

class AssetCacheFailed extends Schema.TaggedError<AssetCacheFailed>()("AssetCacheFailed", {}) {}
const cached = <A>(read: () => Promise<A>) =>
  Effect.tryPromise({ try: read, catch: () => new AssetCacheFailed() });

/** The caller authorizes every request before this reader runs, including cache hits. */
export const cachedBuildAssets = (
  origin: string,
  load: (
    build: BuildId,
    path: string,
  ) => Effect.Effect<RuntimeAsset | undefined, RuntimeBuildUnavailable>,
  stream: (
    key: BlobKey,
    range: BlobRange | undefined,
  ) => Effect.Effect<Option.Option<BlobBody>, BlobStoreError>,
) =>
  Effect.gen(function* () {
    // Alchemy closes the event scope through waitUntil after sending the response.
    // Own cache writes there, without retaining an init-time Worker context.
    const writes = yield* FiberSet.make();
    yield* Effect.addFinalizer(() =>
      FiberSet.awaitEmpty(writes).pipe(Effect.timeoutOption("2 seconds"), Effect.asVoid),
    );
    const publicFile = (listing: typeof PublicListing.Type, contentType: string): RuntimeAsset => ({
      contentType,
      size: listing.size,
      object: listing.object,
      key: listing.key,
      read: (range) =>
        stream(listing.key, range).pipe(
          Effect.mapError(() => new RuntimeBuildUnavailable()),
          Effect.flatMap((found) =>
            Option.isNone(found)
              ? Effect.fail(new RuntimeBuildUnavailable())
              : Effect.succeed(
                  found.value.body.pipe(Stream.mapError(() => new RuntimeBuildUnavailable())),
                ),
          ),
        ),
    });
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
                const listed = response.headers.get(publicHeader);
                if (listed !== null) {
                  const listing = Schema.decodeUnknownOption(PublicListing)(listed);
                  return Option.isSome(listing)
                    ? publicFile(listing.value, contentType)
                    : undefined;
                }
                return {
                  body: new Uint8Array(await response.arrayBuffer()),
                  contentType,
                } satisfies RuntimeAsset;
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
                "body" in asset
                  ? new Response(new Uint8Array(asset.body), {
                      headers: {
                        "content-type": asset.contentType,
                        "cache-control": "public, max-age=31536000",
                      },
                    })
                  : new Response(null, {
                      headers: {
                        "content-type": asset.contentType,
                        "cache-control": "public, max-age=31536000",
                        [publicHeader]: JSON.stringify({
                          key: asset.key,
                          object: asset.object,
                          size: asset.size,
                        }),
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
