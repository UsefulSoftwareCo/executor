// ---------------------------------------------------------------------------
// Self-host OTLP export.
//
// The shared packages this server runs are already instrumented — `withSpan`
// wraps tool execution, OAuth, connection health, and storage — but without a
// tracer those spans go nowhere. That is why a slow request on someone else's
// hardware can only be reported as "it takes five seconds": nothing the
// operator can read says which phase the time went to. Pointing this at a local
// collector turns that into a waterfall.
//
// Export is opt-in and off by default. Self-host runs on the operator's own
// machine, so sending their traces anywhere without being asked is not ours to
// decide; the default is no exporter, no HTTP client, no buffer.
//
// This uses Effect's own OTLP modules rather than the OpenTelemetry SDK. Cloud
// needs `@effect/opentelemetry` because workerd forces a hand-built
// WebTracerProvider, but self-host has no such constraint, and the built-in
// path needs only an HttpClient — no `@opentelemetry/*` dependencies, nothing
// extra in the container image.
// ---------------------------------------------------------------------------

import { FetchHttpClient } from "effect/unstable/http";
import { OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/unstable/observability";
import { Layer } from "effect";

import packageJson from "../package.json" with { type: "json" };

const SERVICE_NAME = "executor-selfhost";
const SERVICE_VERSION: string = packageJson.version;

/** Resolved OTLP export settings, or `undefined` when export is off. */
interface TelemetryTarget {
  readonly tracesUrl: string;
  /** `undefined` when log export is off, or when no URL can be built for it. */
  readonly logsUrl: string | undefined;
  readonly headers: Record<string, string> | undefined;
}

// Signal URLs follow the OTLP spec: OTEL_EXPORTER_OTLP_ENDPOINT is a base that
// each signal appends its own path to, while OTEL_EXPORTER_OTLP_<SIGNAL>_ENDPOINT
// is already the full URL for that one signal. Appending unconditionally would
// POST to /v1/traces/v1/traces, which a collector answers with a 404 that never
// reaches the operator — the export just silently produces nothing.
const resolveTarget = (env: Record<string, string | undefined>): TelemetryTarget | undefined => {
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim().replace(/\/+$/, "");
  const tracesUrl =
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() ?? (base ? `${base}/v1/traces` : undefined);
  if (!tracesUrl) return undefined;
  // Logs are opt-in separately from traces: they are the noisier and more
  // sensitive of the two, carrying every request line and whatever the
  // operator's own log calls hold. Traces answer "where did the time go" by
  // themselves, so shipping logs stays a second, deliberate choice. Set the
  // signal endpoint explicitly if only the traces endpoint is configured —
  // there is no base to derive a logs URL from, and guessing one would export
  // to a path the operator never named.
  const logsUrl = isTruthy(env.EXECUTOR_OTEL_EXPORT_LOGS)
    ? (env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim() ?? (base ? `${base}/v1/logs` : undefined))
    : undefined;
  return { tracesUrl, logsUrl, headers: parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS) };
};

const isTruthy = (value: string | undefined): boolean =>
  value === "1" || value === "true" || value === "yes";

// OTEL_EXPORTER_OTLP_HEADERS carries auth for a hosted collector, in the spec's
// "k=v,k2=v2" form. A malformed pair is skipped rather than failing the boot:
// losing traces must never cost the operator their server.
const parseHeaders = (raw: string | undefined): Record<string, string> | undefined => {
  const entries = (raw ?? "")
    .split(",")
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0)
    .flatMap((pair) => {
      const separator = pair.indexOf("=");
      if (separator <= 0) return [];
      return [[pair.slice(0, separator).trim(), pair.slice(separator + 1).trim()] as const];
    });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

/**
 * OTLP export layer for the self-hosted server, or {@link Layer.empty} when no
 * endpoint is configured — so the default deployment neither exports nor pays
 * for an exporter it will not use.
 *
 * Provide this UNDER the app layer (`Layer.provide`), not merged beside it: the
 * tracer has to be in scope while the app's own layers build, or spans created
 * during construction find the no-op tracer instead.
 */
export const makeTelemetryLive = (
  env: Record<string, string | undefined> = process.env,
): Layer.Layer<never> => {
  const target = resolveTarget(env);
  if (!target) return Layer.empty;

  const resource = { serviceName: SERVICE_NAME, serviceVersion: SERVICE_VERSION };

  const TracerLive = OtlpTracer.layer({
    url: target.tracesUrl,
    resource,
    headers: target.headers,
  });

  const logsUrl = target.logsUrl;
  const LoggerLive = logsUrl
    ? OtlpLogger.layer({ url: logsUrl, resource, headers: target.headers })
    : Layer.empty;

  console.info(
    `[executor] exporting traces to ${target.tracesUrl}${logsUrl ? ` and logs to ${logsUrl}` : ""}`,
  );

  return Layer.merge(TracerLive, LoggerLive).pipe(
    Layer.provide(OtlpSerialization.layerJson),
    // The exporter gets a plain fetch client, deliberately not the guarded
    // hosted client: the collector is an address the operator configured, so
    // the SSRF guard's job (stopping agent-chosen URLs from reaching the
    // private network) does not apply, and applying it would block the most
    // common setup of all — a collector on localhost.
    Layer.provide(FetchHttpClient.layer),
  );
};
