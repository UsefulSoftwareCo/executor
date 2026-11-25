import { TelemetryConfig, telemetryConfig } from "@executor-js/telemetry";
import { isolateTelemetry } from "@executor-js/telemetry/isolate";
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

export const telemetryDatasets = Effect.gen(function* () {
  const shared = Option.isSome(yield* testStage.pipe(Effect.orDie));
  const owner = shared ? "test" : yield* Stage;
  return {
    shared,
    names: {
      traces: `executor-next-${owner}-traces`,
      logs: `executor-next-${owner}-logs`,
      metrics: `executor-next-${owner}-metrics`,
    },
  };
});

export const telemetryExport = Effect.gen(function* () {
  if (Option.isNone(yield* testStage)) return true;
  const telemetry = yield* Config.Literals(["export", "off"], "TEST_STAGE_TELEMETRY").pipe(
    Config.withDefault("off"),
  );
  return telemetry === "export";
}).pipe(Effect.orDie);

export const telemetryResources = Effect.gen(function* () {
  const stage = yield* Stage;
  const { shared, names } = yield* telemetryDatasets;
  const dataset = (
    id: string,
    name: string,
    kind: "otel:traces:v1" | "otel:logs:v1" | "otel:metrics:v1",
  ) => Axiom.Dataset(id, { name, kind }).pipe(adopt(shared), retain());
  const traces = yield* dataset("TelemetryTraces", names.traces, "otel:traces:v1");
  const logs = yield* dataset("TelemetryLogs", names.logs, "otel:logs:v1");
  const metrics = yield* dataset("TelemetryMetrics", names.metrics, "otel:metrics:v1");
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
      id: "RunnerFallback",
      title: "database call runner fallback",
      query: `['${names.traces}'] | where ['resource.deployment.environment.name'] == '${stage}' | where isnotempty(tostring(['attributes.custom']['executor.runner.fallback'])) | summarize count()`,
    },
    {
      id: "SupervisorRefusals",
      title: "data supervisor refusals",
      query: `['${names.traces}'] | where ['resource.deployment.environment.name'] == '${stage}' | where isnotempty(tostring(['attributes.custom']['executor.runner.refused'])) or isnotempty(tostring(['attributes.custom']['executor.supervisor.refused'])) | summarize count()`,
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

const platformLogs = {
  enabled: true,
  redactQueryString: true,
  logs: { enabled: true, invocationLogs: true, persist: true },
};

export const platformObservability = Effect.gen(function* () {
  if ((yield* AlchemyContext).dev) return {};
  return { observability: platformLogs };
});

export const cloudObservability = Effect.gen(function* () {
  if ((yield* AlchemyContext).dev) return {};
  const native = {
    ...platformLogs,
    traces: { enabled: true, headSamplingRate: 1, persist: true },
  };
  if (!(yield* telemetryExport)) return { observability: native };
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
      ...native,
      traces: { ...native.traces, destinations: [destination.slug] },
    },
  };
}).pipe(Effect.orDie);

export const telemetryBindings = Effect.gen(function* () {
  if ((yield* AlchemyContext).dev) {
    const config = yield* telemetryConfig("executor-cloud");
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(TelemetryConfig))(config);
    return { [binding]: Output.asOutput(Redacted.make(encoded)) };
  }
  const version = yield* Config.NonEmptyString("EXECUTOR_BUILD_VERSION");
  const environment = yield* Stage;
  if (!(yield* telemetryExport)) {
    const config = {
      service: "executor-cloud",
      clock: "cloudflare-io" as const,
      version,
      environment,
    };
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(TelemetryConfig))(config);
    return { [binding]: Output.asOutput(Redacted.make(encoded)) };
  }
  const { names, traces, logs, metrics, ingest } = yield* telemetryResources;
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

export const cloudTelemetry = Layer.unwrap(
  Effect.gen(function* () {
    if (!globalThis.__ALCHEMY_RUNTIME__) return Layer.empty;
    const context = yield* CurrentRuntimeContext;
    if (context === undefined)
      return yield* Effect.die(new Error("Telemetry requires an Alchemy runtime"));
    const bound = yield* context.get<unknown>(binding);
    const value = Redacted.isRedacted(bound) ? Redacted.value(bound) : bound;
    const config = yield* Schema.decodeUnknownEffect(
      Schema.Union([Schema.fromJsonString(TelemetryConfig), TelemetryConfig]),
    )(value).pipe(Effect.catch(() => Effect.die(new Error("Invalid telemetry configuration"))));
    const { waitUntil } = yield* Effect.promise(() => import("cloudflare:workers"));
    const exporters = yield* isolateTelemetry({ ...config, clock: "cloudflare-io" }, waitUntil);
    return Telemetry.layer(Layer.mergeAll(exporters, sqlTracing));
  }),
);
