import { Effect, ManagedRuntime } from "effect";

import {
  Analytics,
  defaultLayer as analyticsDefaultLayer,
  type AnalyticsService,
  type AnalyticsSurface,
} from "@executor-js/analytics";

import { resolveExecutorDataDir } from "./auth";
import { CHANNEL, VERSION } from "./installation";

// ---------------------------------------------------------------------------
// Local product analytics: one anonymous per-install service for the whole
// daemon lifetime, shared by every surface (HTTP API, in-process MCP, stdio).
//
// The surface is cli|desktop — never "local": the desktop main process marks
// its sidecar via EXECUTOR_CLIENT=desktop (same signal the sidecar sentinels
// key on), everything else hosting apps/local is the CLI. Module-singleton
// runtime mirroring ./integrations.ts, so concurrent surfaces share one
// buffer + one flush loop, and disposeAnalytics() is the shutdown flush.
// ---------------------------------------------------------------------------

const resolveSurface = (): AnalyticsSurface =>
  process.env.EXECUTOR_CLIENT === "desktop" ? "desktop" : "cli";

let analyticsRuntime: ManagedRuntime.ManagedRuntime<Analytics, never> | null = null;

const getAnalyticsRuntime = (): ManagedRuntime.ManagedRuntime<Analytics, never> => {
  if (analyticsRuntime) return analyticsRuntime;
  analyticsRuntime = ManagedRuntime.make(
    analyticsDefaultLayer({
      surface: resolveSurface(),
      version: VERSION,
      channel: CHANNEL,
      dataDir: resolveExecutorDataDir(),
    }),
  );
  return analyticsRuntime;
};

/**
 * Lazy facade over the daemon's shared service, usable from boot paths that
 * compose engines outside Effect. `record` forks into the module runtime
 * (fire-and-forget, mirroring ./integrations.ts) so callers never wait on the
 * layer build; ordering within the runtime preserves event order.
 */
export const localAnalytics: AnalyticsService = {
  record: (name, properties) =>
    Effect.sync(() => {
      getAnalyticsRuntime().runFork(
        Effect.flatMap(Analytics.asEffect(), (analytics) => analytics.record(name, properties)),
      );
    }),
  flush: Effect.promise(() =>
    getAnalyticsRuntime().runPromise(
      Effect.flatMap(Analytics.asEffect(), (analytics) => analytics.flush),
    ),
  ),
};

/** Flush and dispose the analytics runtime (daemon shutdown). */
export const disposeAnalytics = async (): Promise<void> => {
  const runtime = analyticsRuntime;
  if (!runtime) return;
  analyticsRuntime = null;
  await Effect.runPromise(Effect.promise(() => runtime.dispose()).pipe(Effect.ignoreCause()));
};
