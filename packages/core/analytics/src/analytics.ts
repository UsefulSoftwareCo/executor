// ---------------------------------------------------------------------------
// Anonymous product analytics for the non-cloud hosts (local daemon, self-host).
//
// Model (mirrors t3code's server telemetry): a per-install anonymous id is
// minted once and persisted under the host's data dir; events buffer in memory
// and flush to PostHog's /batch/ endpoint on a fixed cadence plus a finalizer
// flush at shutdown. Delivery is best-effort — a failed flush re-queues the
// batch and never surfaces to the caller; analytics can never fail or slow a
// user-facing operation.
//
// Opt-out is the established cross-cutting convention: DO_NOT_TRACK (see
// consoledonottrack.com, honored by the desktop diagnostics and the
// integrations-registry fetch) or the feature-specific
// EXECUTOR_DISABLE_ANALYTICS. Disabled -> the layer builds a no-op service, so
// callers never branch.
// ---------------------------------------------------------------------------

import { Context, DateTime, Duration, Effect, Layer, Ref, Schedule } from "effect";
import { FileSystem } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { NodeFileSystem } from "@effect/platform-node";

import type { AnalyticsEventName, AnalyticsEvents } from "./events";

// ---------------------------------------------------------------------------
// Surface vocabulary
// ---------------------------------------------------------------------------

/**
 * Which product hosts the daemon emitting the event. Always explicit at the
 * composition root — there is deliberately no "local" catch-all and no env
 * fallback inside this package; a host that cannot say which product it is
 * has a wiring bug worth surfacing, not papering over.
 */
export type AnalyticsSurface = "cli" | "desktop" | "selfhost";

// ---------------------------------------------------------------------------
// Disable hooks
// ---------------------------------------------------------------------------

const truthy = (value: string | undefined): boolean => {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
};

export const isAnalyticsDisabled = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => truthy(env.DO_NOT_TRACK) || truthy(env.EXECUTOR_DISABLE_ANALYTICS);

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface AnalyticsService {
  /** Buffer an event for best-effort batched delivery. Never fails. */
  readonly record: <Name extends AnalyticsEventName>(
    name: Name,
    properties: AnalyticsEvents[Name],
  ) => Effect.Effect<void>;
  /** Drain the buffer now (shutdown path; the layer also flushes on a cadence). */
  readonly flush: Effect.Effect<void>;
}

export class Analytics extends Context.Service<Analytics, AnalyticsService>()(
  "@executor-js/analytics/Analytics",
) {}

/** No-op service: what the layer builds when analytics is disabled. */
export const analyticsNoop: AnalyticsService = {
  record: () => Effect.void,
  flush: Effect.void,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// The same PostHog project the cloud browser client reports to (the key is
// public by design — it identifies the project, it grants no read access).
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";
const DEFAULT_POSTHOG_KEY = "phc_nNLrNMALpRsfrEkZovUkfMxYbcJvHnsJHeoSPavprgLL";

export interface AnalyticsConfig {
  /** Which product hosts this daemon. Explicit, decided at the composition root. */
  readonly surface: AnalyticsSurface;
  /** Product version (the hosting app's package version). */
  readonly version: string;
  /** Release channel, matching the installation user-agent vocabulary. */
  readonly channel: "stable" | "beta" | "dev";
  /**
   * Directory the anonymous install id persists under (the host's data dir:
   * `~/.executor` for local, the self-host data dir for self-host). The id
   * file is `<dataDir>/analytics-id`.
   */
  readonly dataDir: string;
  /** Disable entirely. Honors DO_NOT_TRACK and EXECUTOR_DISABLE_ANALYTICS if omitted. */
  readonly disabled?: boolean;
  /** Override the PostHog ingest origin (tests). */
  readonly posthogHost?: string;
  /** Override the PostHog project key (tests). */
  readonly posthogKey?: string;
  /** Override the flush cadence. Defaults to 30 seconds. */
  readonly flushInterval?: Duration.Input;
}

const FLUSH_BATCH_SIZE = 50;
const MAX_BUFFERED_EVENTS = 500;

// ---------------------------------------------------------------------------
// Anonymous install id
// ---------------------------------------------------------------------------

const ANALYTICS_ID_FILE = "analytics-id";

// Minted once per install, persisted forever (mirrors self-host's
// generate-and-persist secret.key shape, minus the secrecy — this id is not a
// credential, it is the anonymous distinct_id the events file under).
const loadOrMintAnonymousId = (
  dataDir: string,
): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const idPath = `${dataDir}/${ANALYTICS_ID_FILE}`;
    const existing = yield* fs.readFileString(idPath).pipe(
      Effect.map((raw) => raw.trim()),
      Effect.catch(() => Effect.succeed("")),
    );
    if (existing.length > 0) return existing;
    const minted = crypto.randomUUID();
    yield* fs.makeDirectory(dataDir, { recursive: true }).pipe(Effect.ignore);
    yield* fs.writeFileString(idPath, minted).pipe(Effect.ignore);
    return minted;
  });

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

interface BufferedEvent {
  readonly event: AnalyticsEventName;
  readonly properties: Record<string, unknown>;
  readonly timestamp: string;
}

export const layer = (
  config: AnalyticsConfig,
): Layer.Layer<Analytics, never, HttpClient.HttpClient | FileSystem.FileSystem> =>
  Layer.effect(Analytics)(
    Effect.gen(function* () {
      const disabled = config.disabled ?? isAnalyticsDisabled();
      if (disabled) return analyticsNoop;

      const http = yield* HttpClient.HttpClient;
      const distinctId = yield* loadOrMintAnonymousId(config.dataDir);
      const buffer = yield* Ref.make<ReadonlyArray<BufferedEvent>>([]);

      const posthogHost = config.posthogHost ?? DEFAULT_POSTHOG_HOST;
      const posthogKey = config.posthogKey ?? DEFAULT_POSTHOG_KEY;

      const sendBatch = (events: ReadonlyArray<BufferedEvent>) =>
        HttpClientRequest.post(`${posthogHost}/batch/`).pipe(
          HttpClientRequest.bodyJson({
            api_key: posthogKey,
            batch: events.map((entry) => ({
              event: entry.event,
              distinct_id: distinctId,
              timestamp: entry.timestamp,
              properties: {
                ...entry.properties,
                // Anonymous events only: never materialize a person profile.
                $process_person_profile: false,
                surface: config.surface,
                channel: config.channel,
                app_version: config.version,
              },
            })),
          }),
          Effect.flatMap(http.execute),
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.asVoid,
          Effect.timeout(Duration.seconds(10)),
        );

      const flush: Effect.Effect<void> = Effect.gen(function* () {
        while (true) {
          const batch = yield* Ref.modify(buffer, (current) => {
            const next = current.slice(0, FLUSH_BATCH_SIZE);
            return [next, current.slice(next.length)] as const;
          });
          if (batch.length === 0) return;
          yield* sendBatch(batch).pipe(
            // Delivery failed: put the batch back for the next cadence tick and
            // stop draining (the endpoint is unreachable, later batches would
            // fail the same way).
            Effect.tapError(() => Ref.update(buffer, (current) => [...batch, ...current])),
          );
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("Analytics.flush failed").pipe(Effect.annotateLogs("cause", cause)),
        ),
      );

      const record: AnalyticsService["record"] = (name, properties) =>
        Effect.flatMap(DateTime.now, (now) =>
          Ref.update(buffer, (current) => {
            const appended = [
              ...current,
              {
                event: name,
                properties: properties as Record<string, unknown>,
                timestamp: DateTime.formatIso(now),
              },
            ];
            // Bounded buffer: a dead network must not grow memory forever.
            return appended.length > MAX_BUFFERED_EVENTS
              ? appended.slice(appended.length - MAX_BUFFERED_EVENTS)
              : appended;
          }),
        );

      const flushEvery = config.flushInterval ?? Duration.seconds(30);
      yield* Effect.forkScoped(
        flush.pipe(Effect.schedule(Schedule.spaced(flushEvery)), Effect.ignore),
      );
      yield* Effect.addFinalizer(() => flush);

      return { record, flush };
    }),
  );

/** The layer over the default platform services (real HTTP + disk). */
export const defaultLayer = (config: AnalyticsConfig): Layer.Layer<Analytics> =>
  layer(config).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(NodeFileSystem.layer));
