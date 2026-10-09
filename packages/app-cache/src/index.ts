/** Portable Effect cache mechanics. Adapters own storage and the background task lifetime. */
import { Clock, Duration, Effect, Exit, Option, Schedule, Schema, Scope } from "effect";
import {
  CacheAcquired,
  type CacheCommand,
  CacheEntry,
  CacheError,
  cacheLimits,
  type CacheTransport,
} from "./contracts/cache.ts";
export * from "./contracts/cache.ts";

/** Canonical JSON prevents object property order from changing key identity. */
const canonical = (value: Schema.Json): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

/** Hash key material before storage or transport; keys and credential scope never enter telemetry. */
export const cacheKey = (key: unknown) =>
  Effect.gen(function* () {
    const parsed = yield* Schema.decodeUnknownEffect(Schema.Json)(key).pipe(
      Effect.mapError(() => new CacheError({ reason: "invalid" })),
    );
    const bytes = new TextEncoder().encode(canonical(parsed));
    if (bytes.byteLength > cacheLimits.keyBytes)
      return yield* new CacheError({ reason: "capacity" });
    // oxlint-disable-next-line executor/authored-code-through-adapter -- Web Crypto
    const hash = yield* Effect.tryPromise({
      try: () => crypto.subtle.digest("SHA-256", bytes),
      catch: () => new CacheError({ reason: "invalid" }),
    });
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  });

/** A cache hit is decoded with the caller's schema. Loader failures are never cached. */
export interface CacheGet<A> {
  readonly key: Schema.Json;
  readonly schema: Schema.Decoder<A>;
  readonly freshFor: Duration.Input;
  readonly staleFor?: Duration.Input;
  /**
   * What a read does with a value past `freshFor` and within `staleFor`. `serve`, the default,
   * returns it while one background load replaces it. `revalidate` awaits that load first, like a
   * miss; the value stays readable to the load, which can confirm it instead of rebuilding it.
   */
  readonly stale?: "serve" | "revalidate";
  readonly load: Effect.Effect<A, unknown>;
}

/** Create a scoped cache client; a background runner must retain all task resources until completion. */
export const makeCache = (
  host: CacheTransport,
  background: (task: Effect.Effect<void, unknown>) => Effect.Effect<void>,
  scope: Schema.Json = "shared",
  /** The caller's own deadline, when the host supplies one. Waiting never runs past it. */
  deadline?: number,
) => {
  // Every round trip to the host store is visible from the app, whichever host runs it.
  const transport: CacheTransport = (command) =>
    host(command).pipe(
      Effect.withSpan("app.cache.command", {
        attributes: { "cache.operation": command.operation },
      }),
    );
  const keyOf = (key: Schema.Json) => cacheKey([scope, key]);
  const readKeys = (keys: readonly string[]) =>
    transport({ operation: "read", keys }).pipe(
      Effect.flatMap((reply) =>
        Schema.decodeUnknownEffect(Schema.Array(Schema.NullOr(CacheEntry)))(reply).pipe(
          Effect.mapError(() => new CacheError({ reason: "storage" })),
        ),
      ),
    );
  const durations = (freshFor: Duration.Input, staleFor: Duration.Input = 0) =>
    Effect.try({
      try: () => {
        const fresh = Duration.toMillis(Duration.fromInputUnsafe(freshFor));
        const stale = Duration.toMillis(Duration.fromInputUnsafe(staleFor));
        if (
          ![fresh, stale].every((value) => Number.isFinite(value) && value >= 0) ||
          fresh + stale > cacheLimits.retentionMs
        )
          throw new CacheError({ reason: "invalid" });
        return { fresh, stale };
      },
      catch: () => new CacheError({ reason: "invalid" }),
    });
  const get = <A>(options: CacheGet<A>, refresh: boolean) =>
    Effect.gen(function* () {
      const key = yield* keyOf(options.key);
      const { fresh, stale } = yield* durations(options.freshFor, options.staleFor);
      const decode = (value: unknown) => Schema.decodeUnknownEffect(options.schema)(value);
      const load = (lease: string) =>
        Effect.gen(function* () {
          const value = yield* options.load.pipe(Effect.flatMap(decode));
          const json = yield* Schema.decodeUnknownEffect(Schema.Json)(value).pipe(
            Effect.mapError(() => new CacheError({ reason: "invalid" })),
          );
          const now = yield* Clock.currentTimeMillis;
          const published = yield* transport({
            operation: "publish",
            key,
            lease,
            entry: {
              value: json,
              version: crypto.randomUUID(),
              freshUntil: now + fresh,
              staleUntil: now + fresh + stale,
            },
          }).pipe(Effect.withSpan("app.cache.publish"));
          if (published !== true) return yield* new CacheError({ reason: "unavailable" });
          return value;
        }).pipe(
          Effect.withSpan("app.cache.load"),
          Effect.timeout(cacheLimits.loadTimeoutMs),
          // Publishing clears the lease in the same transaction. Only an unpublished load releases it.
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : transport({ operation: "release", key, lease }).pipe(
                  Effect.catch(() => Effect.void),
                ),
          ),
        );
      // Another caller's lease is renewed while its invocation runs, however slowly it loads.
      // Waiting is bounded here instead: past it, this caller loads for itself.
      const waitUntil = Math.min(
        (yield* Clock.currentTimeMillis) + cacheLimits.waitMs,
        deadline ?? Number.POSITIVE_INFINITY,
      );
      let initialVersion: string | null | undefined;
      while (true) {
        // One transaction reads the entry and, when it needs loading, claims the lease.
        const { entry, lease } = yield* transport({
          operation: "acquire",
          key,
          refresh,
          ...(initialVersion === undefined ? {} : { version: initialVersion }),
        }).pipe(
          Effect.flatMap((reply) =>
            Schema.decodeUnknownEffect(CacheAcquired)(reply).pipe(
              Effect.mapError(() => new CacheError({ reason: "storage" })),
            ),
          ),
        );
        const now = yield* Clock.currentTimeMillis;
        if (initialVersion === undefined) initialVersion = entry?.version ?? null;
        const refreshed = refresh && entry !== null && entry.version !== initialVersion;
        // A lease means the store found the entry due for loading; this caller must not drop it.
        if (
          entry !== null &&
          (refreshed || (!refresh && lease === null && now < entry.freshUntil))
        ) {
          yield* Effect.annotateCurrentSpan("cache.result", "fresh");
          return yield* decode(entry.value);
        }
        const kept = !refresh && entry !== null && now < entry.staleUntil;
        if (kept && options.stale !== "revalidate") {
          yield* Effect.annotateCurrentSpan("cache.result", "stale");
          if (lease !== null) yield* background(load(lease).pipe(Effect.asVoid));
          return yield* decode(entry.value);
        }
        if (lease !== null) {
          yield* Effect.annotateCurrentSpan("cache.result", kept ? "revalidated" : "miss");
          return yield* load(lease);
        }
        if (now >= waitUntil) {
          // Without the lease this value is not published; the holder or a later caller does.
          yield* Effect.annotateCurrentSpan("cache.result", "local");
          return yield* options.load.pipe(
            Effect.flatMap(decode),
            Effect.timeout(cacheLimits.loadTimeoutMs),
            Effect.withSpan("app.cache.load", { attributes: { "cache.load.leased": false } }),
          );
        }
        yield* Effect.sleep("100 millis");
      }
    }).pipe(Effect.withSpan("app.cache.get"));
  return {
    /** Read arbitrary retained JSON entries without initiating a refresh. Missing and null are distinct. */
    read: (keys: readonly Schema.Json[]) =>
      Effect.forEach(keys, keyOf).pipe(Effect.flatMap(readKeys)),
    /** Publish bounded immutable parts before publishing the manifest that references them. */
    write: (
      entries: readonly { readonly key: Schema.Json; readonly value: Schema.Json }[],
      retention: Duration.Input,
    ) =>
      Effect.gen(function* () {
        const { fresh } = yield* durations(retention);
        const now = yield* Clock.currentTimeMillis;
        const values = yield* Effect.forEach(entries, ({ key, value }) =>
          Effect.gen(function* () {
            return {
              key: yield* keyOf(key),
              entry: {
                value,
                version: crypto.randomUUID(),
                freshUntil: now + fresh,
                staleUntil: now + fresh,
              },
            };
          }),
        );
        yield* transport({ operation: "write", entries: values });
      }),
    /** Revoke retained data and any loader's right to publish its in-flight result. */
    invalidate: (key: Schema.Json) =>
      keyOf(key).pipe(
        Effect.flatMap((key) => transport({ operation: "invalidate", key })),
        Effect.asVoid,
      ),
    /**
     * Read fresh data, refresh stale data in the background (or first, with `stale: "revalidate"`),
     * or wait for the lease owner.
     */
    get: <A>(options: CacheGet<A>) => get(options, false),
    /** Force one awaited refresh without removing the retained value. Concurrent refreshes share a load. */
    revalidate: <A>(options: CacheGet<A>) => get(options, true),
  };
};

/**
 * Host-side lease ownership for one app invocation. Leases the invocation claims are renewed while
 * it runs, so a slow load keeps its key, and released when the host ends the invocation, including
 * interrupted and cancelled ones and loads whose own release never arrived. A holder that stops
 * running, or whose store channel stops answering, loses its lease within `leaseMs`.
 */
export const holdLeases = (transport: CacheTransport) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const held = new Map<string, string>();
    const command = (input: CacheCommand) =>
      transport(input).pipe(
        Effect.timeout(cacheLimits.commandTimeoutMs),
        Effect.catchTag("TimeoutError", () => Effect.fail(new CacheError({ reason: "timeout" }))),
      );
    // Renew what is held at each tick; leases claimed or released since are seen next time.
    const renew = Effect.suspend(() => {
      const leases = [...held];
      return leases.length === 0
        ? Effect.void
        : Effect.forEach(
            leases,
            ([key, lease]) =>
              command({ operation: "renew", key, lease }).pipe(
                Effect.map((reply) => reply === true),
                Effect.orElseSucceed(() => false),
                Effect.flatMap((renewed) =>
                  Effect.sync(() => {
                    if (!renewed && held.get(key) === lease) held.delete(key);
                  }),
                ),
              ),
            { discard: true },
          ).pipe(
            Effect.withSpan("app.cache.lease.renew", {
              attributes: { "cache.leases": leases.length },
            }),
          );
    });
    yield* renew.pipe(
      Effect.delay(cacheLimits.renewMs),
      Effect.repeat(Schedule.forever),
      Effect.forkIn(scope),
    );
    const observe = (input: CacheCommand, reply: Schema.Json) =>
      Effect.sync(() => {
        switch (input.operation) {
          case "acquire": {
            const acquired = Schema.decodeUnknownOption(CacheAcquired)(reply);
            if (Option.isSome(acquired) && acquired.value.lease !== null)
              held.set(input.key, acquired.value.lease);
            return;
          }
          case "claim":
            if (typeof reply === "string") held.set(input.key, reply);
            return;
          case "publish":
          case "release":
            if (held.get(input.key) === input.lease) held.delete(input.key);
            return;
          case "invalidate":
            held.delete(input.key);
            return;
        }
      });
    return {
      /** Use for every command of the invocation. Each command is bounded by `commandTimeoutMs`. */
      transport: ((input) =>
        command(input).pipe(Effect.tap((reply) => observe(input, reply)))) satisfies CacheTransport,
      /** Stop renewing and release every lease the invocation still holds. */
      close: Effect.gen(function* () {
        yield* Scope.close(scope, Exit.void);
        const leases = [...held];
        held.clear();
        yield* Effect.forEach(
          leases,
          ([key, lease]) =>
            command({ operation: "release", key, lease }).pipe(
              Effect.catchCause(() => Effect.void),
            ),
          { concurrency: "unbounded", discard: true },
        );
      }),
    };
  });
