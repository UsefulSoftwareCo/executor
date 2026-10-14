/** Portable Effect exporters. The host owns scope and export lifetime. */
import { type Duration, Effect, Layer, Logger, Metric, Redacted } from "effect";
import { telemetryHttpClient } from "./transport.ts";
import { spanAttributes } from "./span-attributes.ts";
import { OtlpLogger, OtlpMetrics, OtlpSerialization, OtlpTracer } from "effect/observability";
import {
  CurrentTelemetryConfig,
  telemetryConfig,
  type TelemetryConfig,
  type TelemetryTarget,
} from "./config.ts";

/** How long each signal's final flush may take when the scope closes. */
export type ShutdownTimeouts = Partial<Record<"traces" | "logs" | "metrics", Duration.Input>>;

/**
 * Build one tracer per runtime. Event mode defers export until Worker scope finalization.
 * A signal's final flush gets three seconds unless `shutdownTimeouts` names its own bound; only
 * the host that owns a destination knows it answers faster.
 */
export const telemetryLayer = (
  config: TelemetryConfig,
  lifetime: "process" | "event" = "process",
  logger: Logger.Logger<unknown, void> = Logger.withConsoleError(Logger.formatJson),
  shutdownTimeouts: ShutdownTimeouts = {},
) => {
  const resource = {
    serviceName: config.service,
    serviceVersion: config.version,
    attributes: { "deployment.environment.name": config.environment },
  };
  const signal = (target: TelemetryTarget, name: keyof ShutdownTimeouts) => ({
    url: target.url,
    resource,
    ...(target.headers === undefined ? {} : { headers: Redacted.value(target.headers) }),
    exportInterval: lifetime === "event" ? ("1 hour" as const) : ("1 second" as const),
    shutdownTimeout: shutdownTimeouts[name] ?? ("3 seconds" as const),
  });
  const console = Logger.layer([logger]);
  return Layer.mergeAll(
    Layer.succeed(CurrentTelemetryConfig, config),
    config.traces === undefined
      ? Layer.empty
      : // Credentials travel in provider headers and query strings this product does
        // not choose, so every exported span records only allowlisted HTTP attributes.
        // Record every operation. Caller-supplied sampling is correlation metadata,
        // not authority to suppress server diagnostics.
        spanAttributes(config.clock, true).pipe(
          Layer.provideMerge(
            OtlpTracer.layer(signal(config.traces, "traces")).pipe(
              Layer.provide(OtlpSerialization.layerJson),
            ),
          ),
        ),
    config.logs === undefined
      ? console
      : OtlpLogger.layer({
          ...signal(config.logs, "logs"),
          mergeWithExisting: true,
        }).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provideMerge(console)),
    config.metrics === undefined
      ? Layer.empty
      : OtlpMetrics.layer({
          ...signal(config.metrics, "metrics"),
          exportInterval: "30 seconds",
          temporality: "delta",
        }).pipe(
          Layer.provide(
            config.metricsProtocol === "http/json"
              ? OtlpSerialization.layerJson
              : OtlpSerialization.layerProtobuf,
          ),
        ),
  ).pipe(
    Layer.provide(telemetryHttpClient),
    // Export fibers capture services during construction. Their failure evidence
    // must reach the host logger even after the remote log exporter is closed.
    Layer.provide(console),
    // Each event exports only its own measurements; process hosts share a process registry.
    Layer.provideMerge(Layer.sync(Metric.MetricRegistry, () => new Map())),
  );
};

/** Node/local entry points resolve telemetry once and share it for their process lifetime. */
export const telemetryFromConfig = (service: string) =>
  Layer.unwrap(
    telemetryConfig(service).pipe(
      // Configuration errors are safe typed failures; the host decides whether to fail startup.
      // Never silently turn off an explicitly configured exporter.
      Effect.map((config) => telemetryLayer(config)),
    ),
  );
