/** Bind the portable Effect cache to an app invocation's author API. */
import { Effect, Schema, type Context } from "effect";
import { makeCache, CacheError } from "@executor-js/app-cache";
import { captureTelemetry, owned, ownedBy } from "@executor-js/telemetry";
import type { AppCache, CacheGetOptions, HostCache } from "../contracts/cache.ts";
import { scopedSlots, type ResolvedAccounts } from "../contracts/host.ts";
import type { JsonValue } from "../contracts/schema.ts";
import { decoderOf, type Schema as AppSchema } from "./schema.ts";
import { fromPromise, method, toPromise } from "./authoring.ts";
import { appInvocationFetch } from "./network.ts";

/**
 * Framework-only: `get` that also reads other keys of the same scope in its round trip to the
 * store. Authored code never sees it; framework helpers use it when a cache provides it.
 */
export const getWithReads = Symbol("executor.cache.getWithReads");
/**
 * A `get` value, the store key it was read under, and the stored values of the other keys when
 * the value was read from the store. The values are not decoded: the caller decodes only those it
 * uses. A key with no value reads `undefined`.
 */
export interface GetWithReads<A> {
  readonly value: A;
  /** The entry's store key, unique to the cache's scope and the key. */
  readonly key: string;
  /** Undefined when the value was loaded or the store did not read them: read them separately. */
  readonly reads: readonly unknown[] | undefined;
}
/** The framework-only `get` an app's cache provides beside the author API. */
export type CacheWithReads = AppCache & {
  /** `keys` gets the entry's store key and names the other keys to read with it. */
  readonly [getWithReads]?: <A>(
    options: CacheGetOptions<A>,
    keys: (key: string) => readonly JsonValue[],
  ) => Promise<GetWithReads<A>>;
};

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
  const scoped = (
    scope: JsonValue,
    callerSignal = signal,
    /**
     * The telemetry its calls run in. A loader's cache runs in its load's, so the loader's own
     * cache calls belong to the load, and to the background when the load runs there.
     */
    services = telemetry,
  ): CacheWithReads => {
    const cache = makeCache(
      host.transport,
      // A refresh handed to the background runs beside the caller, which does not wait on it.
      (task) => host.background(task.pipe(owned("background", "app.cache.refresh"))),
      scope,
      deadline,
      // Waiting on another caller's load is waiting, not Executor's work.
      (wait) => wait.pipe(Effect.withSpan("app.cache.lease.wait", ownedBy("lease"))),
    );
    const getOptions = <A>(options: CacheGetOptions<A>) => ({
      key: options.key,
      schema: decoderOf(options.schema),
      freshFor: options.freshFor,
      ...(options.staleFor === undefined ? {} : { staleFor: options.staleFor }),
      ...(options.stale === undefined ? {} : { stale: options.stale }),
      load: Effect.acquireUseRelease(
        Effect.sync(() => new AbortController()),
        (controller) =>
          Effect.all([appInvocationFetch(controller.signal), captureTelemetry]).pipe(
            Effect.flatMap(([fetch, loading]) =>
              fromPromise(
                method(options, "load"),
                "loader",
              )({
                fetch,
                signal: controller.signal,
                cache: scoped(scope, controller.signal, loading.context),
              }),
            ),
          ),
        (controller) => Effect.sync(() => controller.abort()),
      ),
    });
    const load = <A>(read: "get" | "revalidate", given: CacheGetOptions<A>) =>
      cache[read](getOptions(given));
    const decodeEntries = <B>(
      entries: readonly ({ readonly value: unknown } | null)[],
      schema: AppSchema<B, boolean>,
    ) =>
      Effect.forEach(entries, (entry) =>
        entry === null
          ? Effect.succeed(undefined)
          : Schema.decodeUnknownEffect(decoderOf(schema))(entry.value),
      );
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
        services,
      );
    const authored: CacheWithReads = {
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
          cache.read(keys).pipe(Effect.flatMap((entries) => decodeEntries(entries, schema))),
      ),
      write: service("write", cache.write),
      invalidate: service("invalidate", cache.invalidate),
      forAccount: (account) => {
        const bound = scopedSlots(accounts)
          .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
          .find((value) => value.id === account.id);
        if (bound === undefined) throw new CacheError({ reason: "invalid" });
        // Credentials never enter the scope, so a token renewal keeps the account's entries.
        return scoped(
          { account: bound.id, method: bound.method, generation: bound.generation },
          callerSignal,
          services,
        );
      },
    };
    // Only Executor's own cache object carries the combined read, as a non-enumerable own
    // property: an app that spreads or wraps this cache to replace `get` or `read` hands its
    // catalog an object without it, so the catalog calls the app's methods.
    return Object.defineProperty(authored, getWithReads, {
      value: service(
        "get",
        <A>(given: CacheGetOptions<A>, keys: (key: string) => readonly JsonValue[]) =>
          cache.getWith(getOptions(given), keys).pipe(
            Effect.map(({ value, key, reads }): GetWithReads<A> => ({
              value,
              key,
              reads: reads?.map((entry) => (entry === null ? undefined : entry.value)),
            })),
          ),
      ),
    });
  };
  return scoped("shared");
};
