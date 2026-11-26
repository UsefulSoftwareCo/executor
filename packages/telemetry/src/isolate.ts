import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  Logger,
  Metric,
  Redacted,
  Scope,
} from "effect";
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

interface Pending {
  traces: Array<ResourceSpans>;
  logs: Array<ResourceLogs>;
  metrics: Array<ResourceMetrics>;
}

const closeWait = Duration.seconds(1);

const flushDelay = Duration.seconds(1);
const staleAfter = Duration.seconds(5);

const counted = { flushes: 0 };
export const isolateTelemetryFlushes = () => counted.flushes;

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

const measured = (batch: ResourceMetrics) =>
  batch.scopeMetrics.some((scope) => scope.metrics.length > 0);

const buffered = (signal: string) => `https://buffer.invalid/v1/${signal}`;

export const isolateTelemetry = (
  config: TelemetryConfig,
  keepAlive: (work: Promise<unknown>) => void,
  logger: Logger.Logger<unknown, void> = Logger.withConsoleError(Logger.formatJson),
) =>
  Effect.gen(function* () {
    const pending: Pending = { traces: [], logs: [], metrics: [] };
    const clock = yield* Clock.Clock;
    let dirty = false;
    let armed: { readonly at: number } | undefined;
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
          : spanAttributes(config.clock, true, onBuffered).pipe(
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

    arm = () => {
      const timer = { at: clock.currentTimeMillisUnsafe() };
      armed = timer;
      keepAlive(
        Effect.runPromise(
          Effect.sleep(flushDelay).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                if (armed === timer) armed = undefined;
                return dirty ? flush : Effect.void;
              }),
            ),
          ),
        ),
      );
    };

    const flushing = Layer.effectDiscard(
      Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const flushed = yield* Deferred.make<void>();
          keepAlive(
            Effect.runPromise(flush.pipe(Effect.ensuring(Deferred.succeed(flushed, undefined)))),
          );
          yield* Deferred.await(flushed).pipe(Effect.timeoutOption(closeWait));
        }),
      ),
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
      Layer.provideMerge(Layer.sync(Metric.MetricRegistry, () => new Map())),
    );
  });
