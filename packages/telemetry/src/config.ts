/** Telemetry configuration is parsed at composition roots; headers remain redacted. */
import { Config, Context, Effect, Option, Schema } from "effect";

/** Bound each collector request, including its acknowledgement; exporter retries retain the batch. */
export const telemetryRequestTimeout = "5 seconds" as const;

const Endpoint = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      const url = URL.parse(value);
      return (
        url !== null &&
        ["http:", "https:"].includes(url.protocol) &&
        url.username === "" &&
        url.password === ""
      );
    },
    { message: "Expected an HTTP telemetry endpoint without URL credentials" },
  ),
);

/** One private exporter target. Endpoints are complete signal URLs. */
export const TelemetryTarget = Schema.Struct({
  url: Endpoint,
  headers: Schema.optional(Schema.RedactedFromValue(Schema.Record(Schema.String, Schema.String))),
});
/** Parsed target with redaction-safe headers. */
export type TelemetryTarget = typeof TelemetryTarget.Type;

/** Shared identity and independently selectable OTLP signals. */
export const TelemetryConfig = Schema.Struct({
  service: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  environment: Schema.NonEmptyString,
  clock: Schema.optional(Schema.Literals(["system", "cloudflare-io"])),
  traces: Schema.optional(TelemetryTarget),
  logs: Schema.optional(TelemetryTarget),
  metrics: Schema.optional(TelemetryTarget),
  metricsProtocol: Schema.optional(Schema.Literals(["http/json", "http/protobuf"])),
});
/** Resolved telemetry configuration. */
export type TelemetryConfig = typeof TelemetryConfig.Type;

/** Host-only destinations; never copied into an app's invocation telemetry capability. */
export const CurrentTelemetryConfig = Context.Reference<TelemetryConfig | undefined>(
  "executor/TelemetryConfig",
  { defaultValue: () => undefined },
);

/** Read OTLP endpoints uniformly for all signals; development chooses which signals to configure. */
export const telemetryConfig = (service: string) =>
  Effect.gen(function* () {
    const base = yield* Config.URL("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(Config.option);
    const version = yield* Config.String("EXECUTOR_BUILD_VERSION").pipe(
      Config.withDefault("development"),
    );
    const environment = yield* Config.String("EXECUTOR_ENVIRONMENT").pipe(
      Config.withDefault("development"),
    );
    const metricsProtocol = yield* Config.String("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL").pipe(
      Config.withDefault("http/protobuf"),
    );
    const target = (signal: "TRACES" | "LOGS" | "METRICS") =>
      Effect.gen(function* () {
        const endpoint = yield* Config.URL(`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`).pipe(
          Config.option,
        );
        let url = Option.getOrUndefined(endpoint)?.href;
        if (url === undefined && Option.isSome(base)) {
          const target = new URL(base.value.href);
          target.pathname = `${target.pathname.replace(/\/+$/, "")}/v1/${signal.toLowerCase()}`;
          url = target.href;
        }
        if (url === undefined) return undefined;
        const headers = yield* Config.Record(
          Schema.String,
          Schema.StringFromUriComponent,
          `OTEL_EXPORTER_OTLP_${signal}_HEADERS`,
        ).pipe(
          Config.orElse(() =>
            Config.Record(
              Schema.String,
              Schema.StringFromUriComponent,
              "OTEL_EXPORTER_OTLP_HEADERS",
            ),
          ),
          Config.option,
        );
        return { url, ...(Option.isNone(headers) ? {} : { headers: headers.value }) };
      });
    return yield* Schema.decodeUnknownEffect(TelemetryConfig)({
      service,
      version,
      environment,
      clock: "system",
      metricsProtocol,
      traces: yield* target("TRACES"),
      logs: yield* target("LOGS"),
      metrics: yield* target("METRICS"),
    });
  });
