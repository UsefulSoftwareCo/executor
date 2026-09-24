/** Bind the portable Effect cache to an app invocation's author API. */
import { Effect, Schema } from "effect";
import { makeCache, CacheError } from "@executor-js/app-cache";
import { invocationFetch } from "@executor-js/telemetry";
import type { AppCache, HostCache } from "../contracts/cache.ts";
import type { ResolvedAccounts } from "../contracts/host.ts";
import type { JsonValue } from "../contracts/schema.ts";
import { decoderOf } from "./schema.ts";
import { toPromise } from "./authoring.ts";

/** Missing host support is explicit on use; ordinary apps do not need cache support. */
export const unavailableCache: HostCache = {
  transport: () => Effect.fail(new CacheError({ reason: "unavailable" })),
  background: () => Effect.die(new Error("Cache background runner is unavailable")),
};

/** Account scopes are derived from trusted current bindings. Loaders get a fresh owned HTTP signal. */
export const authorCache = (
  host: HostCache,
  accounts: ResolvedAccounts,
  signal: AbortSignal,
): AppCache => {
  const scoped = (scope: JsonValue, callerSignal = signal): AppCache => {
    const cache = makeCache(host.transport, host.background, scope);
    return {
      get: (options) =>
        toPromise(
          () =>
            cache.get({
              key: options.key,
              schema: decoderOf(options.schema),
              freshFor: options.freshFor,
              ...(options.staleFor === undefined ? {} : { staleFor: options.staleFor }),
              load: Effect.acquireUseRelease(
                Effect.sync(() => new AbortController()),
                (controller) =>
                  invocationFetch(controller.signal).pipe(
                    Effect.flatMap((fetch) =>
                      Effect.tryPromise({
                        try: () =>
                          options.load({
                            fetch,
                            signal: controller.signal,
                            cache: scoped(scope, controller.signal),
                          }),
                        catch: (error) => error,
                      }),
                    ),
                  ),
                (controller) => Effect.sync(() => controller.abort()),
              ),
            }),
          callerSignal,
        )(),
      read: (key, schema) =>
        toPromise(
          () =>
            cache.read([key]).pipe(
              Effect.flatMap((entries) => {
                const entry = entries[0];
                return entry === undefined || entry === null
                  ? Effect.succeed(undefined)
                  : Schema.decodeUnknownEffect(decoderOf(schema))(entry.value);
              }),
            ),
          callerSignal,
        )(),
      readMany: (keys, schema) =>
        toPromise(
          () =>
            cache
              .read(keys)
              .pipe(
                Effect.flatMap((entries) =>
                  Effect.forEach(entries, (entry) =>
                    entry === null
                      ? Effect.succeed(undefined)
                      : Schema.decodeUnknownEffect(decoderOf(schema))(entry.value),
                  ),
                ),
              ),
          callerSignal,
        )(),
      write: toPromise(cache.write, callerSignal),
      invalidate: toPromise(cache.invalidate, callerSignal),
      forAccount: (account) => {
        const bound = Object.values(accounts)
          .flatMap((value) => (Array.isArray(value) ? value : [value]))
          .find((value) => value.id === account.id);
        if (bound === undefined) throw new CacheError({ reason: "invalid" });
        return scoped(
          { account: bound.id, method: bound.method, fields: bound.fields },
          callerSignal,
        );
      },
    };
  };
  return scoped("shared");
};
