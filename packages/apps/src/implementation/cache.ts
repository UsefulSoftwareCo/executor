/** Bind the portable Effect cache to an app invocation's author API. */
import { Effect, Schema } from "effect";
import { makeCache, CacheError } from "@executor-js/app-cache";
import { invocationFetch } from "@executor-js/telemetry";
import type { AppCache, CacheGetOptions, HostCache } from "../contracts/cache.ts";
import type { ResolvedAccounts } from "../contracts/host.ts";
import type { JsonValue } from "../contracts/schema.ts";
import { decoderOf, type Schema as AppSchema } from "./schema.ts";
import { fromPromise, toPromise } from "./authoring.ts";

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
    const load = <A>(method: "get" | "revalidate", options: CacheGetOptions<A>) =>
      cache[method]({
        key: options.key,
        schema: decoderOf(options.schema),
        freshFor: options.freshFor,
        ...(options.staleFor === undefined ? {} : { staleFor: options.staleFor }),
        load: Effect.acquireUseRelease(
          Effect.sync(() => new AbortController()),
          (controller) =>
            invocationFetch(controller.signal).pipe(
              Effect.flatMap((fetch) =>
                fromPromise(options.load)({
                  fetch,
                  signal: controller.signal,
                  cache: scoped(scope, controller.signal),
                }),
              ),
            ),
          (controller) => Effect.sync(() => controller.abort()),
        ),
      });
    // Keep the native callback on each method so framework consumers retain the
    // invocation's scheduler, tracing and cancellation across the Promise API.
    return {
      get: toPromise(<A>(options: CacheGetOptions<A>) => load("get", options), callerSignal),
      revalidate: toPromise(
        <A>(options: CacheGetOptions<A>) => load("revalidate", options),
        callerSignal,
      ),
      read: toPromise(
        <A>(key: JsonValue, schema: AppSchema<A, boolean>) =>
          cache.read([key]).pipe(
            Effect.flatMap((entries) => {
              const entry = entries[0];
              return entry === undefined || entry === null
                ? Effect.succeed(undefined)
                : Schema.decodeUnknownEffect(decoderOf(schema))(entry.value);
            }),
          ),
        callerSignal,
      ),
      readMany: toPromise(
        <A>(keys: readonly JsonValue[], schema: AppSchema<A, boolean>) =>
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
      ),
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
