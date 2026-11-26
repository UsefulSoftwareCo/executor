import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Effect, FiberSet, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

class FeedCacheFailed extends Schema.TaggedError<FeedCacheFailed>()("FeedCacheFailed", {}) {}
const cached = <A>(read: () => Promise<A>) =>
  Effect.tryPromise({ try: read, catch: () => new FeedCacheFailed() });

const retentionSeconds = 5 * 60;

export const cachedFeedClient = Effect.fn(function* (
  origin: string,
  feedUrl: string,
  client: HttpClient.HttpClient,
) {
  const feedDirectory = new URL(".", feedUrl).href;
  const writes = yield* makeExecutionMemo(
    Effect.gen(function* () {
      const writes = yield* FiberSet.make();
      yield* Effect.addFinalizer(() =>
        FiberSet.awaitEmpty(writes).pipe(Effect.timeoutOption("2 seconds"), Effect.asVoid),
      );
      return writes;
    }),
  );
  return HttpClient.transform(client, (response, request) => {
    if (request.method !== "GET" || !request.url.startsWith(feedDirectory)) return response;
    return Effect.gen(function* () {
      const key = new URL(
        `/_executor/catalog-feed-cache/${encodeURIComponent(request.url)}`,
        origin,
      ).href;
      const cache = yield* cached(() => caches.open("executor-catalog-feed-v1")).pipe(
        Effect.catchTag("FeedCacheFailed", () => Effect.succeed(undefined)),
      );
      const hit =
        cache === undefined
          ? undefined
          : yield* cached(() => cache.match(key)).pipe(
              Effect.catchTag("FeedCacheFailed", () => Effect.succeed(undefined)),
            );
      yield* Effect.annotateCurrentSpan(
        "executor.catalog.cache",
        hit === undefined ? "miss" : "hit",
      );
      if (hit !== undefined) return HttpClientResponse.fromWeb(request, hit);
      const fresh = yield* response;
      if (cache === undefined || fresh.status !== 200) return fresh;
      const body = yield* fresh.text;
      const headers = {
        "content-type": fresh.headers["content-type"] ?? "application/json",
        "cache-control": `public, max-age=${retentionSeconds}`,
      };
      yield* FiberSet.run(
        yield* writes,
        cached(() => cache.put(key, new Response(body, { headers }))).pipe(
          Effect.catchTag("FeedCacheFailed", () =>
            Effect.logWarning("Catalog feed cache write failed"),
          ),
        ),
      );
      return HttpClientResponse.fromWeb(request, new Response(body, { status: 200, headers }));
    }).pipe(Effect.withSpan("catalog.feed.read"));
  });
});
