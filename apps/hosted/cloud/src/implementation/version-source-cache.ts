import type { BlobKey, BlobStorage } from "@executor-js/sdk/core";
import { Effect, FiberSet, Option, Schema } from "effect";

class SourceCacheFailed extends Schema.TaggedError<SourceCacheFailed>()("SourceCacheFailed", {}) {}
const cached = <A>(read: () => Promise<A>) =>
  Effect.tryPromise({ try: read, catch: () => new SourceCacheFailed() });

const retentionSeconds = 24 * 60 * 60;
const immutable = (key: BlobKey) => /^deployments\/[^/]+\/source\.json$/.test(key);

export const cachedVersionSources = (origin: string, blobs: BlobStorage) =>
  Effect.gen(function* () {
    const writes = yield* FiberSet.make();
    yield* Effect.addFinalizer(() =>
      FiberSet.awaitEmpty(writes).pipe(Effect.timeoutOption("2 seconds"), Effect.asVoid),
    );
    const retained = (key: BlobKey) =>
      Effect.gen(function* () {
        const url = new URL(`/_executor/deployment-source-cache/${encodeURIComponent(key)}`, origin)
          .href;
        const cache = yield* cached(() =>
          caches.open("executor-private-deployment-sources-v1"),
        ).pipe(Effect.catchTag("SourceCacheFailed", () => Effect.succeed(undefined)));
        const hit =
          cache === undefined
            ? undefined
            : yield* cached(() => cache.match(url)).pipe(
                Effect.flatMap((response) =>
                  response === undefined
                    ? Effect.succeed(undefined)
                    : cached(() => response.arrayBuffer()).pipe(
                        Effect.map((body) => new Uint8Array(body)),
                      ),
                ),
                Effect.catchTag("SourceCacheFailed", () => Effect.succeed(undefined)),
              );
        yield* Effect.annotateCurrentSpan(
          "executor.source.cache",
          hit === undefined ? "miss" : "hit",
        );
        if (hit !== undefined) return Option.some(hit);
        const stored = yield* blobs.get(key);
        if (cache !== undefined && Option.isSome(stored))
          yield* FiberSet.run(
            writes,
            cached(() =>
              cache.put(
                url,
                new Response(new Uint8Array(stored.value), {
                  headers: {
                    "content-type": "application/json",
                    "cache-control": `public, max-age=${retentionSeconds}`,
                  },
                }),
              ),
            ).pipe(
              Effect.catchTag("SourceCacheFailed", () =>
                Effect.logWarning("Version source cache write failed"),
              ),
            ),
          );
        return stored;
      }).pipe(Effect.withSpan("storage.deployment_source.get"));
    return {
      ...blobs,
      get: (key) => (immutable(key) ? retained(key) : blobs.get(key)),
    } satisfies BlobStorage;
  });
