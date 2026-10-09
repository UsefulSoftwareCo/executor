/**
 * Cloudflare Workers exporters: built once per isolate, flushed by each event.
 *
 * A Worker pins timers and fetches to the event that started them, so a batch
 * cannot wait for an isolate-wide timer. Building Effect's exporters for every
 * event costs more CPU than most requests' own spans, however. The span and log
 * exporters are therefore built once per isolate and only buffer. Each event
 * exports everything buffered so far from its own scope: every second while a
 * streamed response keeps it open, and when it closes. A span leaves with the
 * first flush after it ends, which may belong to a concurrent event.
 *
 * Metrics stay per event. Their delta histograms report each event's own
 * minimum and maximum, which an isolate-wide registry cannot reconstruct.
 */
import { Context, Duration, Effect, Layer, Logger, Metric, Redacted, Scope } from "effect";
import { HttpBody, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import {
  OtlpExporter,
  OtlpLogger,
  OtlpMetrics,
  OtlpSerialization,
  OtlpTracer,
} from "effect/observability";
import { CurrentTelemetryConfig, type TelemetryConfig, type TelemetryTarget } from "./config.ts";
import { spanAttributes } from "./span-attributes.ts";
import { retryTelemetryExport, telemetryHttpClient } from "./transport.ts";

type ResourceSpans = OtlpTracer.TraceData["resourceSpans"][number];
type ResourceLogs = OtlpLogger.LogsData["resourceLogs"][number];
type ResourceMetrics = OtlpMetrics.MetricsData["resourceMetrics"][number];

/** Exported batches waiting for the next flush, in export order. */
interface Pending {
  traces: Array<ResourceSpans>;
  logs: Array<ResourceLogs>;
  metrics: Array<ResourceMetrics>;
}

/**
 * Effect's exporters serialize each batch immediately before posting it. Here
 * serialization keeps the batch object and the post goes nowhere, so a flush
 * can merge every buffered batch into one encoded request per signal.
 */
const buffering = (pending: Pending) =>
  Layer.mergeAll(
    Layer.succeed(OtlpSerialization.OtlpSerialization, {
      traces: (data) => {
        pending.traces.push(...data.resourceSpans);
        return HttpBody.empty;
      },
      logs: (data) => {
        pending.logs.push(...data.resourceLogs);
        return HttpBody.empty;
      },
      metrics: (data) => {
        pending.metrics.push(...data.resourceMetrics);
        return HttpBody.empty;
      },
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
      ),
    ),
  );

/** The buffering exporters never post, so their URL only names the signal. */
const buffered = (signal: string) => `https://buffer.invalid/v1/${signal}`;

/**
 * Build the isolate's span and log exporters and return the Layer each event
 * provides. Run it once, during Worker initialization.
 */
export const isolateTelemetry = (
  config: TelemetryConfig,
  logger: Logger.Logger<unknown, void> = Logger.withConsoleError(Logger.formatJson),
) =>
  Effect.gen(function* () {
    const pending: Pending = { traces: [], logs: [], metrics: [] };
    const resource = {
      serviceName: config.service,
      serviceVersion: config.version,
      attributes: { "deployment.environment.name": config.environment },
    };
    const console = Logger.layer([logger]);
    const buffers = buffering(pending);
    // Export happens only when an event flushes, so no isolate timer ever runs.
    const exporter = (signal: string) => ({
      url: buffered(signal),
      resource,
      exportInterval: Duration.infinity,
    });
    const isolate = yield* Layer.buildWithScope(
      Layer.mergeAll(
        Layer.succeed(CurrentTelemetryConfig, config),
        config.traces === undefined
          ? Layer.empty
          : // As in telemetryLayer: every span is recorded and HTTP attributes are allowlisted.
            spanAttributes(config.clock, true).pipe(
              Layer.provideMerge(OtlpTracer.layer(exporter("traces"))),
            ),
        config.logs === undefined
          ? console
          : OtlpLogger.layer({ ...exporter("logs"), mergeWithExisting: true }).pipe(
              Layer.provideMerge(console),
            ),
      ).pipe(
        Layer.provideMerge(OtlpExporter.layerFlusher),
        Layer.provide(buffers),
        Layer.provide(console),
      ),
      // The isolate's exporters last as long as the isolate; nothing closes this scope.
      Scope.makeUnsafe(),
    );
    const flusher = Context.get(isolate, OtlpExporter.Flusher);

    const json = yield* OtlpSerialization.OtlpSerialization.pipe(
      Effect.provide(OtlpSerialization.layerJson),
    );
    const metricsEncoding =
      config.metricsProtocol === "http/json"
        ? json
        : yield* OtlpSerialization.OtlpSerialization.pipe(
            Effect.provide(OtlpSerialization.layerProtobuf),
          );
    const client = (yield* HttpClient.HttpClient.pipe(Effect.provide(telemetryHttpClient))).pipe(
      HttpClient.transformResponse(
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      ),
      retryTelemetryExport,
    );
    // The telemetry client records each failed attempt with its safe reason.
    const post = (label: string, target: TelemetryTarget, body: HttpBody.HttpBody) =>
      client
        .execute(
          HttpClientRequest.post(target.url).pipe(
            HttpClientRequest.setHeaders({
              ...(target.headers === undefined ? {} : Redacted.value(target.headers)),
              "user-agent": `effect-opentelemetry-${label}/0.0.0`,
            }),
            HttpClientRequest.setBody(body),
          ),
        )
        .pipe(Effect.ignore);

    // Uninterruptible: batches leave `pending` before the requests, so a flush must finish.
    const flush = Effect.uninterruptible(
      Effect.gen(function* () {
        yield* flusher.flush;
        const traces = pending.traces.splice(0);
        const logs = pending.logs.splice(0);
        // An event that recorded no measurement exports an empty batch; it carries nothing.
        const metrics = pending.metrics
          .splice(0)
          .filter((batch) => batch.scopeMetrics.some((scope) => scope.metrics.length > 0));
        yield* Effect.all(
          [
            config.traces === undefined || traces.length === 0
              ? Effect.void
              : post("OtlpTracer", config.traces, json.traces({ resourceSpans: traces })),
            config.logs === undefined || logs.length === 0
              ? Effect.void
              : post("OtlpLogger", config.logs, json.logs({ resourceLogs: logs })),
            config.metrics === undefined || metrics.length === 0
              ? Effect.void
              : post(
                  "OtlpMetrics",
                  config.metrics,
                  metricsEncoding.metrics({ resourceMetrics: metrics }),
                ),
          ],
          { concurrency: "unbounded", discard: true },
        );
      }),
    ).pipe(Effect.withTracerEnabled(false));

    // Built before the metric exporter, so this final flush runs after its last snapshot.
    const flushing = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => flush);
        yield* Effect.forkScoped(
          Effect.forever(Effect.sleep("1 second").pipe(Effect.andThen(flush))),
        );
      }),
    );
    return Layer.mergeAll(
      Layer.succeedContext(isolate),
      config.metrics === undefined
        ? Layer.empty
        : OtlpMetrics.layer({
            url: buffered("metrics"),
            resource,
            exportInterval: "30 seconds",
            temporality: "delta",
          }).pipe(Layer.provide(buffers)),
    ).pipe(
      Layer.provideMerge(flushing),
      // Each event exports only its own measurements.
      Layer.provideMerge(Layer.sync(Metric.MetricRegistry, () => new Map())),
    );
  });
