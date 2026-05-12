import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";
import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect";
import { FileSystem } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { NodeFileSystem } from "@effect/platform-node";

// ---------------------------------------------------------------------------
// User-Agent
// ---------------------------------------------------------------------------

export type InstallationChannel = "stable" | "beta" | "dev";
export type SurfaceClient = "cli" | "local" | "desktop";

export const DEFAULT_INTEGRATIONS_URL = "https://integrations.sh/api.json";

// Worker filters on `agent.includes("executor")`. Channel/version/client are
// passed through verbatim so the recipient can slice DAU by surface.
export const buildUserAgent = (input: {
  readonly channel: InstallationChannel;
  readonly version: string;
  readonly client: SurfaceClient;
}): string => `executor/${input.channel}/${input.version}/${input.client}`;

// ---------------------------------------------------------------------------
// Disable hooks
// ---------------------------------------------------------------------------

const truthy = (value: string | undefined): boolean => {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
};

export const isFetchDisabled = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => truthy(env.DO_NOT_TRACK) || truthy(env.EXECUTOR_DISABLE_INTEGRATIONS_FETCH);

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type IntegrationsRegistryData = unknown;

export interface IntegrationsRegistryService {
  readonly get: () => Effect.Effect<IntegrationsRegistryData>;
  readonly refresh: (force?: boolean) => Effect.Effect<void>;
}

export class IntegrationsRegistry extends Context.Service<
  IntegrationsRegistry,
  IntegrationsRegistryService
>()("@executor-js/integrations-registry/IntegrationsRegistry") {}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface IntegrationsRegistryConfig {
  readonly userAgent: string;
  /** Override the fetch URL (env: EXECUTOR_INTEGRATIONS_URL). */
  readonly url?: string;
  /** Disable the fetch entirely (CI/tests). Honors DO_NOT_TRACK and EXECUTOR_DISABLE_INTEGRATIONS_FETCH if omitted. */
  readonly disabled?: boolean;
  /** Override the cache directory. Defaults to $EXECUTOR_DATA_DIR/cache or ~/.executor/cache. */
  readonly cacheDir?: string;
  /** Override the recurring refresh interval. Defaults to 12 hours. */
  readonly refreshInterval?: Duration.Input;
  /** Override the disk-cache freshness TTL. Defaults to 12 hours. */
  readonly cacheTtl?: Duration.Input;
  /**
   * When false, skip the recurring refresh schedule (and the fork that
   * drives it). The first `get()` still populates the cache. Use this from
   * short-lived CLI invocations so the runtime can be disposed cleanly
   * once the fetch finishes; long-lived daemons should leave it true.
   * Defaults to true.
   */
  readonly recurring?: boolean;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const resolveCacheDir = (override: string | undefined): string => {
  if (override) return override;
  const dataDir = process.env.EXECUTOR_DATA_DIR ?? pathJoin(homedir(), ".executor");
  return pathJoin(dataDir, "cache");
};

const hashSource = (source: string): string =>
  createHash("sha256").update(source).digest("hex").slice(0, 12);

const cacheFileFor = (cacheDir: string, source: string): string => {
  const name =
    source === DEFAULT_INTEGRATIONS_URL
      ? "integrations.json"
      : `integrations-${hashSource(source)}.json`;
  return pathJoin(cacheDir, name);
};

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const decodeJsonOption = Schema.decodeUnknownOption(UnknownFromJsonString);

const parseJson = (text: string): IntegrationsRegistryData => {
  const decoded = decodeJsonOption(text);
  if (Option.isNone(decoded)) return undefined;
  return decoded.value;
};

export const layer = (
  config: IntegrationsRegistryConfig,
): Layer.Layer<IntegrationsRegistry, never, HttpClient.HttpClient | FileSystem.FileSystem> =>
  Layer.effect(
    IntegrationsRegistry,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const http = yield* HttpClient.HttpClient;

      const source =
        config.url ?? process.env.EXECUTOR_INTEGRATIONS_URL ?? DEFAULT_INTEGRATIONS_URL;
      const cacheDir = resolveCacheDir(config.cacheDir);
      const cacheFile = cacheFileFor(cacheDir, source);
      const lockFile = `${cacheFile}.lock`;
      const ttl = Duration.fromInputUnsafe(config.cacheTtl ?? Duration.hours(12));
      const refreshEvery = Duration.fromInputUnsafe(config.refreshInterval ?? Duration.hours(12));
      const disabled = config.disabled ?? isFetchDisabled();

      const isFresh = Effect.gen(function* () {
        const stat = yield* fs.stat(cacheFile).pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (!stat) return false;
        const mtime = Option.getOrElse(stat.mtime, () => new Date(0)).getTime();
        return Date.now() - mtime < Duration.toMillis(ttl);
      });

      const fetchText = Effect.gen(function* () {
        const request = HttpClientRequest.get(source).pipe(
          HttpClientRequest.setHeader("user-agent", config.userAgent),
          HttpClientRequest.setHeader("accept", "application/json"),
        );
        const response = yield* http.execute(request);
        return yield* response.text;
      }).pipe(Effect.timeout(Duration.seconds(10)), Effect.withSpan("IntegrationsRegistry.fetch"));

      const writeCache = (text: string) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(cacheDir, { recursive: true }).pipe(Effect.ignore);
          yield* fs.writeFileString(cacheFile, text);
        });

      // Cross-process advisory lock so concurrent CLI invocations don't all
      // race to refresh the same file. Best-effort: if we can't acquire,
      // another process is already refreshing — skip and read what they wrote.
      const withWriteLock = <A, E>(use: Effect.Effect<A, E>) =>
        Effect.acquireUseRelease(
          Effect.gen(function* () {
            yield* fs.makeDirectory(cacheDir, { recursive: true }).pipe(Effect.ignore);
            return yield* fs.writeFileString(lockFile, `${process.pid}\n`, { flag: "wx" }).pipe(
              Effect.as(true),
              Effect.catch(() => Effect.succeed(false)),
            );
          }),
          (acquired): Effect.Effect<Option.Option<A>, E> =>
            acquired ? Effect.map(use, Option.some) : Effect.succeed(Option.none<A>()),
          (acquired) =>
            acquired ? fs.remove(lockFile, { force: true }).pipe(Effect.ignore) : Effect.void,
        );

      const fetchAndWrite = Effect.gen(function* () {
        const text = yield* fetchText;
        yield* writeCache(text);
        return text;
      });

      const readFromDisk = Effect.gen(function* () {
        const raw = yield* fs
          .readFileString(cacheFile)
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (raw === undefined) return undefined;
        return parseJson(raw);
      });

      const populate = Effect.gen(function* () {
        if (disabled) return undefined as IntegrationsRegistryData;

        const fromDisk = yield* readFromDisk;
        if (fromDisk) return fromDisk;

        const text = yield* withWriteLock(fetchAndWrite);
        if (Option.isSome(text)) {
          return parseJson(text.value);
        }
        // Another process held the lock. Try to read what they wrote.
        const settled = yield* readFromDisk;
        return settled ?? (undefined as IntegrationsRegistryData);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("IntegrationsRegistry.populate failed").pipe(
            Effect.annotateLogs("cause", cause),
            Effect.as(undefined as IntegrationsRegistryData),
          ),
        ),
        Effect.withSpan("IntegrationsRegistry.populate"),
      );

      const [cachedGet, invalidate] = yield* Effect.cachedInvalidateWithTTL(
        populate,
        Duration.infinity,
      );

      const refresh = (force = false): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (disabled) return;
          if (!force) {
            const fresh = yield* isFresh;
            if (fresh) return;
          }
          const wrote = yield* withWriteLock(
            Effect.gen(function* () {
              if (!force) {
                // Re-check freshness under the lock — another process may
                // have refreshed between our outer check and acquisition.
                const fresh = yield* isFresh;
                if (fresh) return false;
              }
              yield* fetchAndWrite;
              return true;
            }),
          );
          if (Option.isSome(wrote) && wrote.value) {
            yield* invalidate;
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("IntegrationsRegistry.refresh failed").pipe(
              Effect.annotateLogs("cause", cause),
            ),
          ),
          Effect.withSpan("IntegrationsRegistry.refresh"),
        );

      const recurring = config.recurring ?? true;
      if (!disabled && recurring) {
        // Populate the cache at startup even if no caller invokes `get()`
        // before exit. Forked so boot isn't blocked on the network.
        // `Schedule.spaced` runs once and then waits between completions,
        // so this also drives the recurring refresh loop.
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            yield* cachedGet;
            yield* refresh().pipe(Effect.repeat(Schedule.spaced(refreshEvery)));
          }).pipe(Effect.ignore),
        );
      }

      return {
        get: () => cachedGet,
        refresh,
      };
    }),
  );

export const defaultLayer = (
  config: IntegrationsRegistryConfig,
): Layer.Layer<IntegrationsRegistry> =>
  layer(config).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(NodeFileSystem.layer));
