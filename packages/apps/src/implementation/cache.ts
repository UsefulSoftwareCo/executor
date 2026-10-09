/** Bind the portable Effect cache to an app invocation's author API. */
import { Effect, Schema, type Context } from "effect";
import { makeCache, CacheError } from "@executor-js/app-cache";
import { owned } from "@executor-js/telemetry";
import type { AppCache, CacheGetOptions, HostCache } from "../contracts/cache.ts";
import type { ResolvedAccounts } from "../contracts/host.ts";
import type { JsonValue } from "../contracts/schema.ts";
import { decoderOf, type Schema as AppSchema } from "./schema.ts";
import { fromPromise, method, toPromise } from "./authoring.ts";
import { appInvocationFetch } from "./network.ts";

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
  /** The invocation's telemetry, which Promise calls from authored code run in. */
  telemetry: Context.Context<never>,
  /** The invocation's trusted deadline. Waiting on another caller's load never runs past it. */
  deadline?: number,
): AppCache => {
  const scoped = (scope: JsonValue, callerSignal = signal): AppCache => {
    const cache = makeCache(host.transport, host.background, scope, deadline);
    const load = <A>(read: "get" | "revalidate", options: CacheGetOptions<A>) =>
      cache[read]({
        key: options.key,
        schema: decoderOf(options.schema),
        freshFor: options.freshFor,
        ...(options.staleFor === undefined ? {} : { staleFor: options.staleFor }),
        ...(options.stale === undefined ? {} : { stale: options.stale }),
        load: Effect.acquireUseRelease(
          Effect.sync(() => new AbortController()),
          (controller) =>
            appInvocationFetch(controller.signal).pipe(
              Effect.flatMap((fetch) =>
                fromPromise(
                  method(options, "load"),
                  "loader",
                )({
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
    // invocation's scheduler, tracing and cancellation across the Promise API. Each call is
    // Executor's work, apart from the app's loader inside it.
    const service = <Args extends readonly unknown[], A, E>(
      method: string,
      operation: (...args: Args) => Effect.Effect<A, E>,
    ) =>
      toPromise(
        (...args: Args) =>
          operation(...args).pipe(
            owned("executor", "app.cache.call", { attributes: { "cache.method": method } }),
          ),
        callerSignal,
        telemetry,
      );
    return {
      get: service("get", <A>(options: CacheGetOptions<A>) => load("get", options)),
      revalidate: service("revalidate", <A>(options: CacheGetOptions<A>) =>
        load("revalidate", options),
      ),
      read: service("read", <A>(key: JsonValue, schema: AppSchema<A, boolean>) =>
        cache.read([key]).pipe(
          Effect.flatMap((entries) => {
            const entry = entries[0];
            return entry === undefined || entry === null
              ? Effect.succeed(undefined)
              : Schema.decodeUnknownEffect(decoderOf(schema))(entry.value);
          }),
        ),
      ),
      readMany: service(
        "readMany",
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
      ),
      write: service("write", cache.write),
      invalidate: service("invalidate", cache.invalidate),
      forAccount: (account) => {
        const bound = Object.values(accounts)
          .flatMap((value) => (Array.isArray(value) ? value : [value]))
          .find((value) => value.id === account.id);
        if (bound === undefined) throw new CacheError({ reason: "invalid" });
        // Credentials never enter the scope, so a token renewal keeps the account's entries.
        return scoped(
          { account: bound.id, method: bound.method, generation: bound.generation },
          callerSignal,
        );
      },
    };
  };
  return scoped("shared");
};
