/** Colo cache of the official app feed, so listing and installing do not each wait on R2. */
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

class FeedCacheFailed extends Schema.TaggedError<FeedCacheFailed>()("FeedCacheFailed", {}) {}
const cached = <A>(read: () => Promise<A>) =>
  Effect.tryPromise({ try: read, catch: () => new FeedCacheFailed() });

/** The feed itself declares `max-age=300`; a delisted app can stay installable for that long. */
const retentionSeconds = 5 * 60;

/**
 * Serve successful GETs under the feed's directory from the colo cache, filling it on a miss. Other
 * requests, failures and non-200 responses pass through uncached. A cache failure only costs the
 * origin read.
 */
export const cachedFeedClient = (
  origin: string,
  feedUrl: string,
  client: HttpClient.HttpClient,
): HttpClient.HttpClient => {
  const feedDirectory = new URL(".", feedUrl).href;
  return HttpClient.transform(client, (response, request) => {
    if (request.method !== "GET" || !request.url.startsWith(feedDirectory)) return response;
    return Effect.gen(function* () {
      // Separate from browser assets. No route serves this synthetic URL.
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
      yield* cached(() => cache.put(key, new Response(body, { headers }))).pipe(
        Effect.catchTag("FeedCacheFailed", () =>
          Effect.logWarning("Catalog feed cache write failed"),
        ),
      );
      return HttpClientResponse.fromWeb(request, new Response(body, { status: 200, headers }));
    }).pipe(Effect.withSpan("catalog.feed.read"));
  });
};
