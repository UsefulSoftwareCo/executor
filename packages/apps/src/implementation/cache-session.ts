/** Worker bridge lifetime for SWR tasks. Foreground response and background completion are separate. */
import { Effect, Schema } from "effect";
import { CacheCommand, CacheReply, CacheError } from "@executor-js/app-cache/contracts";
import type { HostCache } from "../contracts/cache.ts";

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
            Effect.timeout("30 seconds"),
            Effect.catchCause(() => Effect.logWarning("App cache refresh failed")),
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
