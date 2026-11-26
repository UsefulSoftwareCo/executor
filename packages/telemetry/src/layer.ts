import { Duration, Effect, Layer, Logger, Metric, Redacted } from "effect";
import { telemetryHttpClient } from "./transport.ts";
import { spanAttributes } from "./span-attributes.ts";
import { OtlpLogger, OtlpMetrics, OtlpSerialization, OtlpTracer } from "effect/observability";
import {
  CurrentTelemetryConfig,
  telemetryConfig,
  type TelemetryConfig,
  type TelemetryTarget,
} from "./config.ts";

export type ShutdownTimeouts = Partial<Record<"traces" | "logs" | "metrics", Duration.Input>>;

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
    exportInterval: lifetime === "event" ? Duration.infinity : ("1 second" as const),
    shutdownTimeout: shutdownTimeouts[name] ?? ("3 seconds" as const),
  });
  const console = Logger.layer([logger]);
  return Layer.mergeAll(
    Layer.succeed(CurrentTelemetryConfig, config),
    config.traces === undefined
      ? Layer.empty
      : spanAttributes(config.clock, true).pipe(
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
    Layer.provide(console),
    Layer.provideMerge(Layer.sync(Metric.MetricRegistry, () => new Map())),
  );
};

export const telemetryFromConfig = (service: string) =>
  Layer.unwrap(telemetryConfig(service).pipe(Effect.map((config) => telemetryLayer(config))));
