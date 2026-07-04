import { Layer, Logger, References } from "effect";
import type * as LogLevel from "effect/LogLevel";
import { FetchHttpClient } from "effect/unstable/http";
import type { HttpClient } from "effect/unstable/http";
import {
  OtlpLogger,
  OtlpMetrics,
  OtlpSerialization,
  OtlpTracer,
} from "effect/unstable/observability";

// ---------------------------------------------------------------------------
// Shared observability: structured JSON logging + OTLP traces/logs/metrics.
//
// One implementation for every server app. The OTLP exporters are the
// fetch-based `effect/unstable/observability` modules (no `async_hooks`), so
// the SAME layer works on Bun (local, self-host) and Cloudflare workerd
// (host-cloudflare, cloud). Everything is env-driven and fully inert when no
// OTLP endpoint is configured: structured stdout logging stays on, export
// layers collapse to `Layer.empty`.
// ---------------------------------------------------------------------------

/**
 * Parse the standard `OTEL_EXPORTER_OTLP_HEADERS` format
 * (`key=value,key2=value2`) into a header record. Undefined/blank input and
 * malformed pairs are dropped rather than failing boot.
 */
export const parseOtlpHeaders = (value: string | undefined): Record<string, string> => {
  if (!value?.trim()) return {};
  return Object.fromEntries(
    value.split(",").flatMap((pair): ReadonlyArray<readonly [string, string]> => {
      const eq = pair.indexOf("=");
      if (eq < 1) return [];
      return [[pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()]];
    }),
  );
};

const LOG_LEVELS: Record<string, LogLevel.LogLevel> = {
  all: "All",
  trace: "Trace",
  debug: "Debug",
  info: "Info",
  warn: "Warn",
  warning: "Warn",
  error: "Error",
  fatal: "Fatal",
  none: "None",
};

/** Parse a `LOG_LEVEL`-style string; unknown/absent values return undefined. */
export const parseLogLevel = (value: string | undefined): LogLevel.LogLevel | undefined =>
  value ? LOG_LEVELS[value.trim().toLowerCase()] : undefined;

/**
 * A structured JSON-lines console logger. Reuses Effect's
 * `Logger.formatStructured` record (level, timestamp, message, annotations,
 * cause, log spans, fiber id) and adds `trace_id`/`span_id` from the fiber's
 * current tracer span, so console lines correlate with exported traces the
 * same way OTLP log records do.
 *
 * Writes to STDERR (`console.error`), never stdout: the MCP stdio transport
 * uses the process's stdout as its JSON-RPC channel, so a stdout log line
 * from the same process corrupts the protocol stream. Cloudflare Workers and
 * log shippers capture stderr the same as stdout.
 */
export const jsonSpanLogger: Logger.Logger<unknown, void> = Logger.make((options) => {
  const record: Record<string, unknown> = { ...Logger.formatStructured.log(options) };
  const span = options.fiber.currentSpan;
  if (span) {
    record["trace_id"] = span.traceId;
    record["span_id"] = span.spanId;
  }
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: log emission must tolerate non-serializable annotation values
  try {
    console.error(JSON.stringify(record));
  } catch {
    console.error(record);
  }
});

/**
 * Replace the default pretty logger with {@link jsonSpanLogger} and apply the
 * minimum log level (a `LOG_LEVEL`-style string; defaults to the runtime's
 * `Info` when absent or unrecognized).
 */
export const structuredLoggerLayer = (options?: {
  readonly logLevel?: string | undefined;
}): Layer.Layer<never> => {
  const logger = Logger.layer([jsonSpanLogger], { mergeWithExisting: false });
  const level = parseLogLevel(options?.logLevel);
  return level === undefined
    ? logger
    : Layer.merge(logger, Layer.succeed(References.MinimumLogLevel)(level));
};

export type ObservabilityConfig = {
  /** OTLP resource service name, e.g. "executor-local". */
  readonly serviceName: string;
  /**
   * OTLP/HTTP base endpoint (`OTEL_EXPORTER_OTLP_ENDPOINT`), e.g.
   * `http://localhost:4318`. `/v1/{traces,logs,metrics}` are appended. When
   * absent, OTLP export is disabled entirely.
   */
  readonly endpoint?: string | undefined;
  /** `OTEL_EXPORTER_OTLP_HEADERS` string or an already-parsed header record. */
  readonly headers?: string | Record<string, string> | undefined;
  /** `LOG_LEVEL`-style minimum level for ALL logging (stdout and OTLP). */
  readonly logLevel?: string | undefined;
  /**
   * Export spans over OTLP (default true). Cloud passes `false`: its traces
   * keep flowing through the existing Axiom `WebTracerProvider` pipeline,
   * which non-Effect fetch paths and Sentry correlation depend on.
   */
  readonly traces?: boolean | undefined;
};

/**
 * The one layer an app boots: structured JSON stdout logging (always) plus
 * OTLP logs + metrics + optional traces (only when `endpoint` is set).
 *
 * The OTLP logger is ADDED to the current logger set (`mergeWithExisting`), so
 * stdout and OTLP both receive every log record; `Layer.provideMerge` keeps
 * the stdout logger and minimum-level reference visible to the app while
 * letting the OTLP layers build on top of them.
 */
export const observabilityLayer = (config: ObservabilityConfig): Layer.Layer<never> => {
  const logger = structuredLoggerLayer({ logLevel: config.logLevel });
  const endpoint = config.endpoint?.trim();
  if (!endpoint) return logger;

  const base = endpoint.replace(/\/+$/, "");
  const resource = { serviceName: config.serviceName };
  const headers =
    typeof config.headers === "string" ? parseOtlpHeaders(config.headers) : (config.headers ?? {});

  const signals: Array<
    Layer.Layer<never, never, OtlpSerialization.OtlpSerialization | HttpClient.HttpClient>
  > = [
    OtlpLogger.layer({ url: `${base}/v1/logs`, resource, headers, mergeWithExisting: true }),
    OtlpMetrics.layer({ url: `${base}/v1/metrics`, resource, headers }),
  ];
  if (config.traces !== false) {
    signals.push(OtlpTracer.layer({ url: `${base}/v1/traces`, resource, headers }));
  }

  const otlp = Layer.mergeAll(signals[0]!, ...signals.slice(1)).pipe(
    Layer.provide(OtlpSerialization.layerJson),
    Layer.provide(FetchHttpClient.layer),
  );
  return otlp.pipe(Layer.provideMerge(logger));
};
