/** Portable Effect exporters. The host owns scope and export lifetime. */
import { Effect, Layer, Logger, Metric, Redacted } from "effect";
import { telemetryHttpClient } from "./transport.ts";
import { spanAttributes } from "./span-attributes.ts";
import {
  OtlpLogger,
  OtlpMetrics,
  OtlpSerialization,
  OtlpTracer,
} from "effect/unstable/observability";
import {
  CurrentTelemetryConfig,
  telemetryConfig,
  type TelemetryConfig,
  type TelemetryTarget,
} from "./config.ts";

/** Build one tracer per runtime. Event mode defers export until Worker scope finalization. */
export const telemetryLayer = (
  config: TelemetryConfig,
  lifetime: "process" | "event" = "process",
  logger: Logger.Logger<unknown, void> = Logger.withConsoleError(Logger.formatJson),
) => {
  const resource = {
    serviceName: config.service,
    serviceVersion: config.version,
    attributes: { "deployment.environment.name": config.environment },
  };
  const signal = (target: TelemetryTarget) => ({
    url: target.url,
    resource,
    ...(target.headers === undefined ? {} : { headers: Redacted.value(target.headers) }),
    exportInterval: lifetime === "event" ? ("1 hour" as const) : ("1 second" as const),
    shutdownTimeout: "3 seconds" as const,
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
            OtlpTracer.layer(signal(config.traces)).pipe(
              Layer.provide(OtlpSerialization.layerJson),
            ),
          ),
        ),
    config.logs === undefined
      ? console
      : OtlpLogger.layer({
          ...signal(config.logs),
          mergeWithExisting: true,
        }).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provideMerge(console)),
    config.metrics === undefined
      ? Layer.empty
      : OtlpMetrics.layer({
          ...signal(config.metrics),
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
