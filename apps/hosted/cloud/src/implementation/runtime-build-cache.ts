import { type BuildId, RuntimeBuildUnavailable } from "@executor-js/sdk/core";
import {
  type FrameworkIdentity,
  InlinedWorkerBuild,
  linkWorkerBuild,
  type LoadedWorkerBuild,
  RetainedFramework,
  RetainedWorkerBuild,
  type StoredWorkerBuild,
} from "@executor-js/sdk/workerd";
import { Clock, Effect, FiberSet, Option, Schema, Semaphore, Struct } from "effect";
import {
  isolateBuildCacheBytes,
  isolateBuildCacheEntries,
  isolateBuildEntryOverhead,
  isolateBuildModuleOverhead,
} from "../contracts/builds.ts";

class BuildCacheFailed extends Schema.TaggedError<BuildCacheFailed>()("BuildCacheFailed", {}) {}
const cached = <A>(read: () => Promise<A>) =>
  Effect.tryPromise({ try: read, catch: () => new BuildCacheFailed() });
type Cache = Awaited<ReturnType<typeof caches.open>>;

const ExecutableWorkerBuild = Schema.Union([
  RetainedWorkerBuild.mapFields(
    Struct.pick(["format", "mainModule", "modules", "framework", "database", "protocol"]),
  ),
  InlinedWorkerBuild.mapFields(
    Struct.pick(["format", "mainModule", "modules", "database", "protocol"]),
  ),
]);
type ExecutableWorkerBuild = typeof ExecutableWorkerBuild.Type;

type Entry =
  | { readonly record: ExecutableWorkerBuild; readonly bytes: number }
  | { readonly framework: RetainedFramework; readonly bytes: number };
const memory = new Map<string, Entry>();
// oxlint-disable-next-line executor/no-module-level-mutable-state -- isolate-wide cache of immutable, credential-free build code, shared by design
let accounted = 0;

const recordKey = (build: BuildId) => `build:${build}`;
const frameworkKey = (identity: FrameworkIdentity) => `framework:${identity.sha256}`;

const textBytes = (...texts: ReadonlyArray<string>) =>
  texts.reduce((total, text) => total + 2 * text.length, 0);
const modulesBytes = (modules: StoredWorkerBuild["modules"]) =>
  Object.entries(modules).reduce(
    (total, [name, module]) =>
      total +
      isolateBuildModuleOverhead +
      textBytes(name) +
      (typeof module === "string"
        ? textBytes(module)
        : "js" in module
          ? textBytes(module.js)
          : module.wasm.byteLength),
    isolateBuildEntryOverhead,
  );

const executable = (record: StoredWorkerBuild): ExecutableWorkerBuild =>
  record.format === 1
    ? {
        format: 1,
        mainModule: record.mainModule,
        modules: record.modules,
        database: record.database,
        protocol: record.protocol,
      }
    : {
        format: 2,
        mainModule: record.mainModule,
        modules: record.modules,
        framework: record.framework,
        database: record.database,
        protocol: record.protocol,
      };
const recordEntry = {
  value: (entry: Entry) => ("record" in entry ? entry.record : undefined),
  entry: (record: ExecutableWorkerBuild): Entry => ({
    record,
    bytes:
      modulesBytes(record.modules) +
      textBytes(record.mainModule) +
      (record.format === 2 ? textBytes(record.framework.version, record.framework.sha256) : 0),
  }),
};
const frameworkEntry = {
  value: (entry: Entry) => ("framework" in entry ? entry.framework : undefined),
  entry: (framework: RetainedFramework): Entry => ({
    framework,
    bytes: modulesBytes(framework.modules) + textBytes(framework.version, framework.sha256),
  }),
};

const recall = (key: string) => {
  const entry = memory.get(key);
  if (entry === undefined) return undefined;
  memory.delete(key);
  memory.set(key, entry);
  return entry;
};

const remember = (key: string, entry: Entry) => {
  if (entry.bytes > isolateBuildCacheBytes || memory.has(key)) return;
  memory.set(key, entry);
  accounted += entry.bytes;
  for (const [oldest, evicted] of memory) {
    if (accounted <= isolateBuildCacheBytes && memory.size <= isolateBuildCacheEntries) break;
    memory.delete(oldest);
    accounted -= evicted.bytes;
  }
};

type Flight = { readonly permit: Semaphore.Semaphore; callers: number };
const flights = new Map<string, Flight>();
const readCheck = { min: 10, max: 200 };
const readTimeout = 10_000;

const readOnce = <A, R>(
  key: string,
  part: { readonly value: (entry: Entry) => A | undefined; readonly entry: (value: A) => Entry },
  read: Effect.Effect<
    { readonly value: A; readonly source: "hit" | "miss" },
    RuntimeBuildUnavailable,
    R
  >,
  deadline: number,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const flight = flights.get(key) ?? { permit: Semaphore.makeUnsafe(1), callers: 0 };
      flight.callers += 1;
      flights.set(key, flight);
      return flight;
    }),
    (flight) =>
      Effect.gen(function* () {
        const since = yield* Clock.currentTimeMillis;
        let waited = false;
        for (;;) {
          const owned = yield* flight.permit.withPermitsIfAvailable(1)(
            Effect.gen(function* () {
              const memorized = recall(key);
              const held = memorized === undefined ? undefined : part.value(memorized);
              if (memorized !== undefined && held !== undefined)
                return {
                  value: held,
                  source: waited ? ("shared" as const) : ("memory" as const),
                  bytes: memorized.bytes,
                };
              const left = deadline - (yield* Clock.currentTimeMillis);
              if (left <= 0) return yield* new RuntimeBuildUnavailable();
              const { value, source } = yield* read.pipe(
                Effect.timeoutOrElse({
                  duration: left,
                  orElse: () => Effect.fail(new RuntimeBuildUnavailable()),
                }),
              );
              const entry = part.entry(value);
              remember(key, entry);
              return { value, source, bytes: entry.bytes };
            }),
          );
          if (Option.isSome(owned)) return owned.value;
          const now = yield* Clock.currentTimeMillis;
          if (now >= deadline) return yield* new RuntimeBuildUnavailable();
          waited = true;
          yield* Effect.sleep(
            Math.min(
              deadline - now,
              Math.max(readCheck.min, Math.min(readCheck.max, (now - since) / 4)),
            ),
          );
        }
      }),
    (flight) =>
      Effect.sync(() => {
        flight.callers -= 1;
        if (flight.callers === 0) flights.delete(key);
      }),
  );

const recordUrl = (origin: string, build: BuildId) =>
  new URL(`/_executor/runtime-build-cache/${encodeURIComponent(build)}`, origin).href;
const frameworkUrl = (origin: string, identity: FrameworkIdentity) =>
  new URL(
    `/_executor/runtime-framework-cache/${encodeURIComponent(`${identity.version}-${identity.sha256}`)}`,
    origin,
  ).href;
const openCache = cached(() => caches.open("executor-private-runtime-builds-v1")).pipe(
  Effect.catchTag("BuildCacheFailed", () => Effect.succeed(undefined)),
);

const encodedRecord = Schema.fromJsonString(ExecutableWorkerBuild);
const encodedFramework = Schema.fromJsonString(RetainedFramework);

const writeCache = <A>(
  cache: Cache,
  url: string,
  part: "record" | "framework",
  schema: Schema.Codec<A, string>,
  value: A,
) =>
  Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan("executor.build.cache_write", "failed");
    const body = yield* Schema.encodeEffect(schema)(value);
    yield* cached(() =>
      cache.put(
        url,
        new Response(body, {
          headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=31536000",
          },
        }),
      ),
    );
    yield* Effect.annotateCurrentSpan("executor.build.cache_write", "stored");
  }).pipe(
    Effect.catchTags({
      BuildCacheFailed: () => Effect.logWarning("Runtime build cache write failed"),
      SchemaError: () => Effect.logWarning("Runtime build cache encoding failed"),
    }),
    Effect.withSpan("runtime.cloud.build.cache_write", {
      attributes: { "executor.build.cache_part": part },
    }),
  );

const throughCache = <A, E, R>(
  cache: Cache | undefined,
  url: string,
  part: "record" | "framework",
  schema: Schema.Codec<A, string>,
  load: Effect.Effect<A, E, R>,
  background: (write: Effect.Effect<void>) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const hit =
      cache === undefined
        ? undefined
        : yield* cached(() => cache.match(url)).pipe(
            Effect.flatMap((response) =>
              response === undefined
                ? Effect.succeed(undefined)
                : cached(() => response.text()).pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
                  ),
            ),
            Effect.catchTags({
              BuildCacheFailed: () => Effect.succeed(undefined),
              SchemaError: () => Effect.succeed(undefined),
            }),
          );
    if (hit !== undefined) return { value: hit, source: "hit" as const };
    const value = yield* load;
    if (cache !== undefined) yield* background(writeCache(cache, url, part, schema, value));
    return { value, source: "miss" as const };
  });

export const cacheRuntimeBuild = (
  writes: FiberSet.FiberSet,
  origin: string,
  build: BuildId,
  stored: { readonly record: RetainedWorkerBuild; readonly framework: RetainedFramework },
) =>
  Effect.gen(function* () {
    const cache = yield* openCache;
    if (cache === undefined) return;
    yield* FiberSet.run(
      writes,
      writeCache(
        cache,
        recordUrl(origin, build),
        "record",
        encodedRecord,
        executable(stored.record),
      ),
    );
    const url = frameworkUrl(origin, stored.framework);
    const held = yield* cached(() => cache.match(url)).pipe(
      Effect.tap((response) => Effect.sync(() => response?.body?.cancel())),
      Effect.map((response) => response !== undefined),
      Effect.catchTag("BuildCacheFailed", () => Effect.succeed(false)),
    );
    if (!held)
      yield* FiberSet.run(
        writes,
        writeCache(cache, url, "framework", encodedFramework, stored.framework),
      );
  });

export const cachedRuntimeBuilds = <R>(
  origin: string,
  load: {
    readonly record: (
      build: BuildId,
    ) => Effect.Effect<StoredWorkerBuild, RuntimeBuildUnavailable, R>;
    readonly framework: (
      identity: FrameworkIdentity,
    ) => Effect.Effect<RetainedFramework, RuntimeBuildUnavailable, R>;
  },
  background: (write: Effect.Effect<void>) => Effect.Effect<void>,
) => {
  const framework = (identity: FrameworkIdentity, deadline: number) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan(
        "executor.build.framework",
        `${identity.version}-${identity.sha256}`,
      );
      const { value, source } = yield* readOnce(
        frameworkKey(identity),
        frameworkEntry,
        openCache.pipe(
          Effect.flatMap((cache) =>
            throughCache(
              cache,
              frameworkUrl(origin, identity),
              "framework",
              encodedFramework,
              load.framework(identity),
              background,
            ),
          ),
        ),
        deadline,
      );
      yield* Effect.annotateCurrentSpan("executor.build.framework_cache", source);
      return value;
    });
  return (build: BuildId): Effect.Effect<LoadedWorkerBuild, RuntimeBuildUnavailable, R> =>
    Effect.gen(function* () {
      const deadline = (yield* Clock.currentTimeMillis) + readTimeout;
      const { value, source, bytes } = yield* readOnce(
        recordKey(build),
        recordEntry,
        openCache.pipe(
          Effect.flatMap((cache) =>
            throughCache(
              cache,
              recordUrl(origin, build),
              "record",
              encodedRecord,
              load.record(build).pipe(Effect.map(executable)),
              background,
            ),
          ),
        ),
        deadline,
      );
      yield* Effect.annotateCurrentSpan({
        "executor.build.id": build,
        "executor.build.cache": source,
        "executor.build.record_accounted_bytes": bytes,
      });
      return yield* linkWorkerBuild(value, (identity) => framework(identity, deadline));
    }).pipe(
      Effect.tap(() =>
        Effect.annotateCurrentSpan({
          "executor.build.isolate_accounted_bytes": accounted,
          "executor.build.isolate_entries": memory.size,
          "executor.build.isolate_reads": flights.size,
        }),
      ),
      Effect.withSpan("runtime.cloud.build.cached"),
    );
};
