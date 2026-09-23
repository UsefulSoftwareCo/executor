/** Alchemy provisions Axiom; its event scope owns the shared safe Effect exporters. */
import { TelemetryConfig, telemetryConfig, telemetryLayer } from "@executor-js/telemetry";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Axiom from "alchemy/Axiom";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import { adopt } from "alchemy/AdoptPolicy";
import { retain } from "alchemy/RemovalPolicy";
import { Stage } from "alchemy/Stage";
import * as Telemetry from "alchemy/Telemetry";
import { Config, Effect, Layer, Option, Redacted, Schema } from "effect";
import { testStage } from "./stage.ts";
import { InvocationTelemetry } from "./invocation-telemetry.ts";
import { sqlTracing } from "../implementation/sql-tracing.ts";

const binding = "EXECUTOR_TELEMETRY";

/**
 * Configured stages own their datasets and never adopt the original Executor's telemetry.
 * Test stages share one retained set and are told apart by the environment field, so a
 * destroyed test stage removes only its ingest token.
 */
export const telemetryResources = Effect.gen(function* () {
  const stage = yield* Stage;
  const shared = Option.isSome(yield* testStage.pipe(Effect.orDie));
  const owner = shared ? "test" : stage;
  const names = {
    traces: `executor-next-${owner}-traces`,
    logs: `executor-next-${owner}-logs`,
    metrics: `executor-next-${owner}-metrics`,
  };
  // Axiom marks ownership per stage; every test stage takes the shared datasets over on deploy.
  const dataset = (
    id: string,
    name: string,
    kind: "otel:traces:v1" | "otel:logs:v1" | "otel:metrics:v1",
  ) => Axiom.Dataset(id, { name, kind }).pipe(adopt(shared), retain());
  const traces = yield* dataset("TelemetryTraces", names.traces, "otel:traces:v1");
  const logs = yield* dataset("TelemetryLogs", names.logs, "otel:logs:v1");
  const metrics = yield* dataset("TelemetryMetrics", names.metrics, "otel:metrics:v1");
  // Health monitors stay in Axiom. Notification routing requires a separately
  // chosen destination; an observability deploy must not start messaging people.
  for (const monitor of [
    {
      id: "AppTelemetryRejected",
      title: "app telemetry rejected",
      query: `['${names.traces}'] | where ['resource.deployment.environment.name'] == '${stage}' | where ['attributes.url.path'] startswith '/_executor/api/telemetry/' | where ['attributes.http.response.status_code'] >= 400 | summarize count()`,
    },
    {
      id: "AppBrowserFailures",
      title: "app browser failures",
      query: `['${names.traces}'] | where ['resource.deployment.environment.name'] == '${stage}' | where name == 'ui.app.failure' | summarize count()`,
    },
    {
      id: "AppTraceContextMissing",
      title: "app trace context missing",
      query: `['${names.traces}'] | where ['resource.deployment.environment.name'] == '${stage}' | where name == 'ui.app.result.receive' and ['attributes.custom']['executor.trace.context_valid'] == false | summarize count()`,
    },
    {
      id: "TelemetryExportFailures",
      title: "telemetry export failures",
      query: `['${names.logs}'] | where ['resource.deployment.environment.name'] == '${stage}' | where body == 'Telemetry export failed' | summarize count()`,
    },
  ]) {
    yield* Axiom.Monitor(monitor.id, {
      name: `Executor ${stage}: ${monitor.title}`,
      type: "Threshold",
      aplQuery: monitor.query,
      operator: "Above",
      threshold: 0,
      intervalMinutes: 5,
      rangeMinutes: 5,
      alertOnNoData: false,
      resolvable: true,
      notifierIds: [],
    });
  }
  const ingest = yield* Axiom.ApiToken("TelemetryIngest", {
    name: `executor-next-${stage}-ingest`,
    datasetCapabilities: {
      [names.traces]: { ingest: ["create"] },
      [names.logs]: { ingest: ["create"] },
      [names.metrics]: { ingest: ["create"] },
    },
  });
  return { names, traces, logs, metrics, ingest };
});

/**
 * Export invocation summaries and supplementary platform spans, joined by Ray ID.
 * Tail delivery supplies timings independently of native trace sampling.
 * This does not register a second Effect tracer.
 */
export const cloudObservability = Effect.gen(function* () {
  if ((yield* AlchemyContext).dev) return {};
  const stage = yield* Stage;
  const { names, traces, ingest } = yield* telemetryResources;
  const destination = yield* Cloudflare.Workers.ObservabilityDestination("PlatformTraces", {
    name: `executor-next-${stage}-platform-traces`,
    url: traces.otelTracesEndpoint,
    headers: {
      authorization: ingest.token.pipe(Output.map((token) => `Bearer ${Redacted.value(token)}`)),
      "X-Axiom-Dataset": names.traces,
    },
    logpushDataset: "opentelemetry-traces",
  });
  return {
    tailConsumers: [yield* InvocationTelemetry],
    observability: {
      enabled: true,
      redactQueryString: true,
      logs: { enabled: true, invocationLogs: true, persist: true },
      traces: {
        enabled: true,
        headSamplingRate: 1,
        persist: true,
        destinations: [destination.slug],
      },
    },
  };
}).pipe(Effect.orDie);

/** Worker props own provisioning; local workerd uses only explicit local OTLP settings. */
export const telemetryBindings = Effect.gen(function* () {
  if ((yield* AlchemyContext).dev) {
    const config = yield* telemetryConfig("executor-cloud");
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(TelemetryConfig))(config);
    return { [binding]: Output.asOutput(Redacted.make(encoded)) };
  }
  const { names, traces, logs, metrics, ingest } = yield* telemetryResources;
  const version = yield* Config.NonEmptyString("EXECUTOR_BUILD_VERSION");
  const environment = yield* Stage;
  return {
    [binding]: Output.all(
      traces.otelTracesEndpoint,
      logs.otelLogsEndpoint,
      metrics.otelMetricsEndpoint,
      ingest.token,
    ).pipe(
      Output.map(([traceUrl, logUrl, metricUrl, token]) => {
        const target = (url: string, dataset: string) => ({
          url,
          headers: { Authorization: `Bearer ${Redacted.value(token)}`, "X-Axiom-Dataset": dataset },
        });
        return Redacted.make(
          JSON.stringify({
            service: "executor-cloud",
            clock: "cloudflare-io",
            version,
            environment,
            traces: target(traceUrl, names.traces),
            logs: target(logUrl, names.logs),
            metrics: target(metricUrl, names.metrics),
          }),
        );
      }),
    ),
  };
}).pipe(Effect.orDie);

/** Alchemy builds this safe exporter in each Worker/DO event scope and flushes through waitUntil. */
export const cloudTelemetry = Layer.unwrap(
  Effect.gen(function* () {
    if (!globalThis.__ALCHEMY_RUNTIME__) return Layer.empty;
    const context = yield* CurrentRuntimeContext;
    if (context === undefined)
      return yield* Effect.die(new Error("Telemetry requires an Alchemy runtime"));
    const bound = yield* context.get<unknown>(binding);
    // Alchemy env props may arrive JSON-decoded; RuntimeContext.set uses a redacted marker.
    const value = Redacted.isRedacted(bound) ? Redacted.value(bound) : bound;
    const config = yield* Schema.decodeUnknownEffect(
      Schema.Union([Schema.fromJsonString(TelemetryConfig), TelemetryConfig]),
    )(value).pipe(Effect.catch(() => Effect.die(new Error("Invalid telemetry configuration"))));
    // Alchemy owns the exporter for the entire event, including streamed bodies.
    // Flush periodically so long-lived streams remain observable before disconnect.
    return Telemetry.layer(
      Layer.mergeAll(telemetryLayer({ ...config, clock: "cloudflare-io" }, "process"), sqlTracing),
    );
  }),
);
