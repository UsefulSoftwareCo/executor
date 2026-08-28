import { Effect, Layer, ManagedRuntime } from "effect";

import {
  Analytics,
  defaultLayer as analyticsDefaultLayer,
  withExecutionAnalytics,
  type AnalyticsService,
} from "@executor-js/analytics";
import { EngineDecorator } from "@executor-js/api/server";

import packageJson from "../package.json" with { type: "json" };
import { resolveDataDir } from "./config";

// ---------------------------------------------------------------------------
// Self-host product analytics: one anonymous per-install service for the
// server lifetime. The anonymous id persists next to the instance's other
// first-boot state (secret.key) under the data dir, so an instance counts
// once across restarts. Module-singleton runtime; dispose flushes at shutdown.
// ---------------------------------------------------------------------------

// Deployed self-host builds are published releases; the prerelease heuristic
// mirrors apps/local/src/installation.ts.
const VERSION: string = packageJson.version;
const CHANNEL = VERSION.includes("-") ? ("beta" as const) : ("stable" as const);

let analyticsRuntime: ManagedRuntime.ManagedRuntime<Analytics, never> | null = null;

const getAnalyticsRuntime = (): ManagedRuntime.ManagedRuntime<Analytics, never> => {
  if (analyticsRuntime) return analyticsRuntime;
  analyticsRuntime = ManagedRuntime.make(
    analyticsDefaultLayer({
      surface: "selfhost",
      version: VERSION,
      channel: CHANNEL,
      dataDir: resolveDataDir(),
    }),
  );
  return analyticsRuntime;
};

/**
 * Lazy facade over the instance's shared service. `record` forks into the
 * module runtime (fire-and-forget) so no request path ever waits on the
 * analytics layer; ordering within the runtime preserves event order.
 */
export const selfHostAnalytics: AnalyticsService = {
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

/** Flush and dispose the analytics runtime (server shutdown). */
export const disposeAnalytics = async (): Promise<void> => {
  const runtime = analyticsRuntime;
  if (!runtime) return;
  analyticsRuntime = null;
  await Effect.runPromise(Effect.promise(() => runtime.dispose()).pipe(Effect.ignoreCause()));
};

/**
 * The execution-analytics `EngineDecorator`: every engine the shared stack
 * builds gets wrapped once, with the plane derived from what the stack was
 * built to serve — an MCP session carries its `mcpResource`, the HTTP
 * executions plane has none. The wrap point IS the plane, so misattribution
 * is structurally impossible.
 */
export const SelfHostAnalyticsEngineDecorator: Layer.Layer<EngineDecorator> = Layer.succeed(
  EngineDecorator,
)({
  decorate: (engine, _identity, context) =>
    withExecutionAnalytics(engine, selfHostAnalytics, {
      plane: context.mcpResource === undefined ? "api" : "mcp",
      toolkit: context.mcpResource?.kind === "toolkit",
    }),
});
