/** Low-cardinality transport measurements; these are wall/CPU totals with explicit units, not app data. */
import { Effect, Metric } from "effect";

const boundaries = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];
const responseReady = Metric.histogram("executor.http.response_ready_ms", {
  boundaries,
  attributes: { unit: "ms" },
  description:
    "Handler entry to response headers in milliseconds; excludes streamed body lifetime.",
});
const requests = Metric.counter("executor.http.requests", { incremental: true });
const exportFailures = Metric.counter("executor.telemetry.export_failures", { incremental: true });
const workerCpu = Metric.histogram("executor.worker.cpu_ms", {
  boundaries,
  attributes: { unit: "ms" },
  description: "Native Worker CPU time in milliseconds.",
});
const workerWall = Metric.histogram("executor.worker.wall_ms", {
  boundaries,
  attributes: { unit: "ms" },
  description:
    "Native Worker invocation wall time, including stream and cleanup lifetime, in milliseconds.",
});

const group = (path: string | undefined) =>
  path === undefined
    ? "unknown"
    : path.startsWith("/_executor/assets/")
      ? "app-asset"
      : path === "/_executor/api/subscribe"
        ? "app-subscribe"
        : path === "/_executor/api/query"
          ? "app-query"
          : path === "/_executor/api/mutate"
            ? "app-mutate"
            : path.includes("/api/telemetry/")
              ? "telemetry"
              : path.startsWith("/api/")
                ? "api"
                : "document";

/** Classify URLs into a fixed set before attaching attributes; raw paths and query strings are never labels. */
export const recordResponseReady = (
  path: string | undefined,
  method: string,
  status: number,
  milliseconds: number,
) => {
  const attributes = { group: group(path), method, status: String(status) };
  return Effect.andThen(
    Metric.update(Metric.withAttributes(requests, attributes), 1),
    Metric.update(Metric.withAttributes(responseReady, attributes), milliseconds),
  );
};

/** Fixed failure metadata goes to both local/native logs and the metric registry, even when the remote exporter is down. */
export const recordExportFailure = (path: string) => {
  const signal = path.endsWith("/traces")
    ? "traces"
    : path.endsWith("/logs")
      ? "logs"
      : path.endsWith("/metrics")
        ? "metrics"
        : "other";
  return Metric.update(Metric.withAttributes(exportFailures, { signal }), 1).pipe(
    Effect.andThen(
      Effect.logWarning("Telemetry export failed").pipe(
        Effect.annotateLogs({ "executor.telemetry.signal": signal }),
      ),
    ),
  );
};

/** Record provider-owned invocation totals separately from response-ready timing. */
export const recordWorkerMeasurements = (
  worker: string,
  outcome: string,
  cpu: number,
  wall: number,
) => {
  const attributes = { worker, outcome };
  return Effect.andThen(
    Metric.update(Metric.withAttributes(workerCpu, attributes), cpu),
    Metric.update(Metric.withAttributes(workerWall, attributes), wall),
  );
};
