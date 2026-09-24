/** Portable Effect cache mechanics. Adapters own storage and the background task lifetime. */
import { Clock, Duration, Effect, Schema } from "effect";
import { CacheEntry, CacheError, cacheLimits, type CacheTransport } from "./contracts/cache.ts";
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
  readonly load: Effect.Effect<A, unknown>;
}

/** Create a scoped cache client; a background runner must retain all task resources until completion. */
export const makeCache = (
  transport: CacheTransport,
  background: (task: Effect.Effect<void, unknown>) => Effect.Effect<void>,
  scope: Schema.Json = "shared",
) => {
  const keyOf = (key: Schema.Json) => cacheKey([scope, key]);
  const readKeys = (keys: readonly string[]) =>
    transport({ operation: "read", keys }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.NullOr(CacheEntry)))),
      Effect.mapError(() => new CacheError({ reason: "storage" })),
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
    /** Read fresh data, refresh stale data in the background, or wait for the lease owner. */
    get: <A>(options: CacheGet<A>) =>
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
            });
            if (published !== true) return yield* new CacheError({ reason: "unavailable" });
            return value;
          }).pipe(
            Effect.withSpan("app.cache.load"),
            Effect.timeout(cacheLimits.loadTimeoutMs),
            Effect.ensuring(
              transport({ operation: "release", key, lease }).pipe(Effect.catch(() => Effect.void)),
            ),
          );
        const deadline = (yield* Clock.currentTimeMillis) + cacheLimits.leaseMs;
        while (true) {
          const entry = (yield* readKeys([key]))[0] ?? null;
          const now = yield* Clock.currentTimeMillis;
          if (entry !== null && now < entry.freshUntil) {
            yield* Effect.annotateCurrentSpan("cache.result", "fresh");
            return yield* decode(entry.value);
          }
          const lease = yield* transport({
            operation: "claim",
            key,
            version: entry?.version ?? null,
          }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.NullOr(Schema.String))));
          if (entry !== null && now < entry.staleUntil) {
            yield* Effect.annotateCurrentSpan("cache.result", "stale");
            if (lease !== null) yield* background(load(lease).pipe(Effect.asVoid));
            return yield* decode(entry.value);
          }
          if (lease !== null) {
            yield* Effect.annotateCurrentSpan("cache.result", "miss");
            return yield* load(lease);
          }
          if (now >= deadline) return yield* new CacheError({ reason: "timeout" });
          yield* Effect.sleep("100 millis");
        }
      }).pipe(Effect.withSpan("app.cache.get")),
  };
};
