/**
 * Cloudflare Workers exporters: built once per isolate, flushed on demand and by each event.
 *
 * Building Effect's exporters for every event costs more CPU than most requests' own spans, so
 * the span and log exporters are built once per isolate and only buffer. Each event exports
 * everything buffered so far when it closes. Between those, the isolate holds at most one timer:
 * the first span, log or measurement buffered after a flush arms it, and it exports everything
 * buffered within `flushDelay`. A span therefore leaves within `flushDelay` of its end, or sooner
 * with another event's close. After a lost timer (below) it waits instead for an event's close, or
 * for the next item buffered once that timer is `staleAfter` old, which arms another. While
 * nothing is buffered no timer runs, so an open stream that sends nothing costs no telemetry work.
 *
 * A Worker pins a timer and a fetch to the event whose code started them, and workerd refuses to
 * resume or interrupt a fiber from another request (patches/effect-otlp-exporter-loop.md). The
 * timer is therefore a fiber of its own, started by the call that buffered the item, and that
 * call's event is kept alive until the fiber ends (`keepAlive`, the runtime's `waitUntil`). Without
 * that, a Worker event that ended first would never run the timer, and one that ended while the
 * timer's flush was posting would cut the post off, losing everything that flush took. A Durable
 * Object runs both on its own, but is kept alive the same way. An event's close therefore waits at
 * most `flushDelay` and the one export it may have started.
 *
 * A timer disarms itself before it flushes, so a healthy one stays armed only `flushDelay`: a slow
 * export and its retries never make it look old. An event cancelled before its timer fires stops
 * the timer without disarming it. A timer armed longer ago than `staleAfter` has therefore been
 * lost, and the next item buffered arms another.
 *
 * Metrics stay per event. Their delta histograms report each event's own
 * minimum and maximum, which an isolate-wide registry cannot reconstruct.
 */
import { Clock, Context, Duration, Effect, Layer, Logger, Metric, Redacted, Scope } from "effect";
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

/** How long the isolate's flush waits after the first item buffered since the last flush. */
const flushDelay = Duration.seconds(1);
/**
 * How long a timer may stay armed before it is taken for lost. A healthy timer is armed for
 * `flushDelay`, and longer only while the isolate's event loop is held past its due time; five
 * times that leaves the room. A timer taken for lost too early costs one more timer, which exports
 * what is buffered or nothing: each flush takes everything pending, so no batch is lost or sent
 * twice.
 */
const staleAfter = Duration.seconds(5);

/**
 * Flushes this isolate has run, on demand or at an event's close. Module state lives as long as
 * the isolate, and every exporter built in it counts here.
 */
const counted = { flushes: 0 };
export const isolateTelemetryFlushes = () => counted.flushes;

/**
 * Effect's exporters serialize each batch immediately before posting it. Here
 * serialization keeps the batch object and the post goes nowhere, so a flush
 * can merge every buffered batch into one encoded request per signal. A metric
 * exporter serializes on its own interval, so a batch with measurements asks
 * for a flush.
 */
const buffering = (pending: Pending, onBuffered: () => void) =>
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
        if (data.resourceMetrics.some(measured)) onBuffered();
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

/** An event that recorded no measurement exports an empty batch; it carries nothing. */
const measured = (batch: ResourceMetrics) =>
  batch.scopeMetrics.some((scope) => scope.metrics.length > 0);

/** The buffering exporters never post, so their URL only names the signal. */
const buffered = (signal: string) => `https://buffer.invalid/v1/${signal}`;

/**
 * Build the isolate's span and log exporters and return the Layer each event
 * provides. Run it once, during Worker initialization.
 */
export const isolateTelemetry = (
  config: TelemetryConfig,
  /** Keep the current event alive until `work` settles: the runtime's `waitUntil`. */
  keepAlive: (work: Promise<unknown>) => void,
  logger: Logger.Logger<unknown, void> = Logger.withConsoleError(Logger.formatJson),
) =>
  Effect.gen(function* () {
    const pending: Pending = { traces: [], logs: [], metrics: [] };
    const clock = yield* Clock.Clock;
    /** Whether anything was buffered since the last flush began. */
    let dirty = false;
    /**
     * The waiting flush timer, by when it was armed; its event is kept alive until it has flushed.
     * Undefined when none waits.
     */
    let armed: { readonly at: number } | undefined;
    // Assigned once `flush` exists; nothing is buffered while the exporters are being built.
    let arm = () => {};
    const onBuffered = () => {
      dirty = true;
      if (
        armed === undefined ||
        clock.currentTimeMillisUnsafe() - armed.at > Duration.toMillis(staleAfter)
      )
        arm();
    };
    const resource = {
      serviceName: config.service,
      serviceVersion: config.version,
      attributes: { "deployment.environment.name": config.environment },
    };
    const console = Logger.layer([logger]);
    const buffers = buffering(pending, onBuffered);
    // The exporters export only when flushed, so they run no timer of their own. With no interval
    // the exporter also runs no loop (patches/effect-otlp-exporter-loop.md): the exporters outlive
    // every event, and workerd refuses to resume a fiber that last ran in another request.
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
            spanAttributes(config.clock, true, onBuffered).pipe(
              Layer.provideMerge(OtlpTracer.layer(exporter("traces"))),
            ),
        config.logs === undefined
          ? console
          : Logger.layer([Logger.make(onBuffered)], { mergeWithExisting: true }).pipe(
              Layer.provideMerge(
                OtlpLogger.layer({ ...exporter("logs"), mergeWithExisting: true }).pipe(
                  Layer.provideMerge(console),
                ),
              ),
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
        counted.flushes += 1;
        dirty = false;
        yield* flusher.flush;
        const traces = pending.traces.splice(0);
        const logs = pending.logs.splice(0);
        const metrics = pending.metrics.splice(0).filter(measured);
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

    // A root fiber: it belongs to no event's scope, so no other request resumes or interrupts it.
    // It is disarmed before it flushes, so an item buffered during the export arms the next one,
    // and it exports nothing when an event's close already took what was buffered. A timer taken
    // for lost that fires after all disarms only itself.
    arm = () => {
      const timer = { at: clock.currentTimeMillisUnsafe() };
      armed = timer;
      keepAlive(
        Effect.runPromise(
          Effect.sleep(flushDelay).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                // A timer taken for lost that fires after all clears only its own arming. With
                // Worker timers in workerd this cannot happen: a lost timer's event has ended,
                // and its timer never fires. It covers a timer that fires late.
                if (armed === timer) armed = undefined;
                return dirty ? flush : Effect.void;
              }),
            ),
          ),
        ),
      );
    };

    // Built before the metric exporter, so this final flush runs after its last snapshot.
    const flushing = Layer.effectDiscard(Effect.addFinalizer(() => flush));
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
