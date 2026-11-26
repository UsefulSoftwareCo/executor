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

const canonical = (value: Schema.Json): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

export const cacheKey = (key: unknown) =>
  Effect.gen(function* () {
    const parsed = yield* Schema.decodeUnknownEffect(Schema.Json)(key).pipe(
      Effect.mapError(() => new CacheError({ reason: "invalid" })),
    );
    const bytes = new TextEncoder().encode(canonical(parsed));
    if (bytes.byteLength > cacheLimits.keyBytes)
      return yield* new CacheError({ reason: "capacity", limit: "keyBytes" });
    // oxlint-disable-next-line executor/authored-code-through-adapter -- Web Crypto
    const hash = yield* Effect.tryPromise({
      try: () => crypto.subtle.digest("SHA-256", bytes),
      catch: () => new CacheError({ reason: "invalid" }),
    });
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  });

export interface CacheGet<A> {
  readonly key: Schema.Json;
  readonly schema: Schema.Decoder<A>;
  readonly freshFor: Duration.Input;
  readonly staleFor?: Duration.Input;
  readonly stale?: "serve" | "revalidate";
  readonly load: Effect.Effect<A, unknown>;
}

export const makeCache = (
  host: CacheTransport,
  background: (task: Effect.Effect<void, unknown>) => Effect.Effect<void>,
  scope: Schema.Json = "shared",
  deadline?: number,
  leaseWait: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> = (effect) =>
    effect,
) => {
  const transport: CacheTransport = (command) =>
    host(command).pipe(
      Effect.withSpan("app.cache.command", {
        attributes: { "cache.operation": command.operation },
      }),
    );
  const keyOf = (key: Schema.Json) => cacheKey([scope, key]);
  const readKeys = (keys: readonly string[]) =>
    transport({ operation: "read", keys }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.NullOr(CacheEntry)))),
      Effect.mapError(() => new CacheError({ reason: "storage" })),
    );
  const durations = (freshFor: Duration.Input, staleFor: Duration.Input = 0) =>
    Effect.try({
      try: () => ({
        fresh: Duration.toMillis(Duration.fromInputUnsafe(freshFor)),
        stale: Duration.toMillis(Duration.fromInputUnsafe(staleFor)),
      }),
      catch: () => new CacheError({ reason: "invalid" }),
    }).pipe(
      Effect.flatMap(({ fresh, stale }) =>
        ![fresh, stale].every((value) => Number.isFinite(value) && value >= 0)
          ? Effect.fail(new CacheError({ reason: "invalid" }))
          : Effect.succeed({
              fresh: Math.min(fresh, cacheLimits.retentionMs),
              stale: Math.max(0, Math.min(stale, cacheLimits.retentionMs - fresh)),
            }),
      ),
    );
  const get = <A>(
    options: CacheGet<A>,
    refresh: boolean,
    also: (key: string) => readonly Schema.Json[] = () => [],
  ) =>
    Effect.gen(function* () {
      const key = yield* keyOf(options.key);
      const extra = also(key);
      const reads = extra.length === 0 ? undefined : yield* Effect.forEach(extra, keyOf);
      const withReads = (value: A, entries: readonly (CacheEntry | null)[] | undefined) => ({
        value,
        key,
        reads: entries,
      });
      const loaded = (value: A) => ({ value, key, reads: undefined });
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
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : transport({ operation: "release", key, lease }).pipe(
                  Effect.catch(() => Effect.void),
                ),
          ),
        );
      const waitUntil = Math.min(
        (yield* Clock.currentTimeMillis) + cacheLimits.waitMs,
        deadline ?? Number.POSITIVE_INFINITY,
      );
      let initialVersion: string | null | undefined;
      const attempt = Effect.gen(function* () {
        const acquired = yield* transport({
          operation: "acquire",
          key,
          refresh,
          ...(initialVersion === undefined ? {} : { version: initialVersion }),
          ...(reads === undefined ? {} : { reads }),
        }).pipe(
          Effect.flatMap((reply) =>
            Schema.decodeUnknownEffect(CacheAcquired)(reply).pipe(
              Effect.mapError(() => new CacheError({ reason: "storage" })),
            ),
          ),
        );
        const { entry, lease } = acquired;
        const together = acquired.reads?.length === reads?.length ? acquired.reads : undefined;
        const now = yield* Clock.currentTimeMillis;
        if (initialVersion === undefined) initialVersion = entry?.version ?? null;
        const refreshed = refresh && entry !== null && entry.version !== initialVersion;
        if (entry !== null && (refreshed || (!refresh && lease === null && now < entry.freshUntil)))
          return { next: "fresh", entry, together } as const;
        const kept = !refresh && entry !== null && now < entry.staleUntil;
        if (kept && options.stale !== "revalidate")
          return { next: "stale", entry, lease, together } as const;
        if (lease !== null) return { next: "load", lease, kept } as const;
        if (now >= waitUntil) return { next: "local" } as const;
        return { next: "wait" } as const;
      });
      let decided = yield* attempt;
      if (decided.next === "wait")
        decided = yield* Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep("100 millis");
            const next = yield* attempt;
            if (next.next !== "wait") return next;
          }
        }).pipe(leaseWait);
      switch (decided.next) {
        case "fresh":
          yield* Effect.annotateCurrentSpan("cache.result", "fresh");
          return withReads(yield* decode(decided.entry.value), decided.together);
        case "stale":
          yield* Effect.annotateCurrentSpan("cache.result", "stale");
          if (decided.lease !== null) yield* background(load(decided.lease).pipe(Effect.asVoid));
          return withReads(yield* decode(decided.entry.value), decided.together);
        case "load":
          yield* Effect.annotateCurrentSpan("cache.result", decided.kept ? "revalidated" : "miss");
          return loaded(yield* load(decided.lease));
        case "local":
          yield* Effect.annotateCurrentSpan("cache.result", "local");
          return loaded(
            yield* options.load.pipe(
              Effect.flatMap(decode),
              Effect.timeout(cacheLimits.loadTimeoutMs),
              Effect.withSpan("app.cache.load", { attributes: { "cache.load.leased": false } }),
            ),
          );
      }
    }).pipe(Effect.withSpan("app.cache.get"));
  return {
    read: (keys: readonly Schema.Json[]) =>
      Effect.forEach(keys, keyOf).pipe(Effect.flatMap(readKeys)),
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
    invalidate: (key: Schema.Json) =>
      keyOf(key).pipe(
        Effect.flatMap((key) => transport({ operation: "invalidate", key })),
        Effect.asVoid,
      ),
    get: <A>(options: CacheGet<A>) => get(options, false).pipe(Effect.map(({ value }) => value)),
    getWith: <A>(options: CacheGet<A>, keys: (key: string) => readonly Schema.Json[]) =>
      get(options, false, keys),
    revalidate: <A>(options: CacheGet<A>) =>
      get(options, true).pipe(Effect.map(({ value }) => value)),
  };
};

export const holdLeases = (transport: CacheTransport) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const held = new Map<string, string>();
    const command = (input: CacheCommand) =>
      transport(input).pipe(
        Effect.timeout(cacheLimits.commandTimeoutMs),
        Effect.catchTag("TimeoutError", () => Effect.fail(new CacheError({ reason: "timeout" }))),
      );
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
      transport: ((input) =>
        command(input).pipe(Effect.tap((reply) => observe(input, reply)))) satisfies CacheTransport,
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
