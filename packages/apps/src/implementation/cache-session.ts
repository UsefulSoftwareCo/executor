/** Worker bridge lifetime for SWR tasks. Foreground response and background completion are separate. */
import { Cause, Effect, Option, Schema } from "effect";
import { CacheCommand, CacheReply, CacheError } from "@executor-js/app-cache/contracts";
import type { HostCache } from "../contracts/cache.ts";

/** The refresh budget. A refresh still loading past it fails as `timeout`. */
const refreshLimit = "30 seconds";

/**
 * What stopped a background refresh, in fixed words: the loader's own error text never enters the
 * log. `cache` carries the cache's reason, such as `unavailable` for a load whose lease was gone by
 * the time it published. A refresh cancelled with its session ends without a log.
 */
const refreshFailure = (cause: Cause.Cause<unknown>) => {
  if (Cause.hasDies(cause)) return { "cache.refresh.failure": "defect" };
  const error = Cause.findErrorOption(cause);
  if (Option.isNone(error)) return { "cache.refresh.failure": "interrupted" };
  if (Cause.isTimeoutError(error.value)) return { "cache.refresh.failure": "timeout" };
  if (Schema.is(CacheError)(error.value))
    return {
      "cache.refresh.failure": "cache",
      "cache.error.reason": error.value.reason,
      ...(error.value.limit === undefined ? {} : { "cache.error.limit": error.value.limit }),
    };
  if (Schema.isSchemaError(error.value)) return { "cache.refresh.failure": "invalid-value" };
  return { "cache.refresh.failure": "loader" };
};

/** Own all refresh promises until drained or cancelled. Only generated trusted bridges create sessions. */
export const isolatedCacheSession = (callback: (input: unknown) => Promise<unknown>) => {
  const controller = new AbortController();
  const pending = new Set<Promise<void>>();
  const cache: HostCache = {
    transport: (command) =>
      // oxlint-disable-next-line executor/authored-code-through-adapter -- the host's cache RPC
      Effect.tryPromise({
        try: () => callback(Schema.encodeSync(CacheCommand)(command)),
        catch: () => new CacheError({ reason: "storage" }),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CacheReply)),
        Effect.mapError(() => new CacheError({ reason: "storage" })),
        Effect.flatMap((reply) =>
          reply.ok ? Effect.succeed(reply.value) : Effect.fail(reply.error),
        ),
      ),
    background: (task) =>
      Effect.gen(function* () {
        const services = yield* Effect.context<never>();
        // The bridge owns this boundary. drain/cancel retain the RPC callback and await every task.
        // oxlint-disable-next-line executor/authored-code-through-adapter -- Executor's background refresh
        const promise = Effect.runPromiseWith(services)(
          task.pipe(
            Effect.timeout(refreshLimit),
            Effect.catchCause((cause) =>
              Effect.logWarning("App cache refresh failed").pipe(
                Effect.annotateLogs(refreshFailure(cause)),
              ),
            ),
          ),
          { signal: controller.signal },
        ).then(
          () => {
            pending.delete(promise);
          },
          () => {
            pending.delete(promise);
          },
        );
        pending.add(promise);
      }),
  };
  const drain = async () => {
    // oxlint-disable-next-line executor/authored-code-through-adapter -- Executor's background refreshes
    while (pending.size > 0) await Promise.all(pending);
  };
  return {
    cache,
    drain,
    cancel: async () => {
      controller.abort();
      // oxlint-disable-next-line executor/authored-code-through-adapter -- Executor's background refreshes
      await drain();
    },
  };
};
