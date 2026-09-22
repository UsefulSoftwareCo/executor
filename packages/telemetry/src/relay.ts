/** Bounded OTLP return channel for credential-free app isolates. The parent owns export. */
import { Effect, Redacted, Schema, Tracer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { CurrentTelemetryConfig } from "./config.ts";
import { telemetryLayer } from "./layer.ts";
import { telemetryHttpClient } from "./transport.ts";

const Payload = Schema.String.check(Schema.isMaxLength(262_144));
/** Untrusted isolate batches are bounded before decoding; no endpoint or credential crosses back. */
export const TelemetryBatch = Schema.Struct({
  traces: Schema.Array(Payload).check(Schema.isMaxLength(4)),
  logs: Schema.Array(Payload).check(Schema.isMaxLength(4)),
  dropped: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
/** Parsed isolate telemetry envelope. */
export type TelemetryBatch = typeof TelemetryBatch.Type;

/** Collect one invocation into memory, flush before returning, and never contact a remote collector. */
export const collectTelemetry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const traces: string[] = [];
    const logs: string[] = [];
    let dropped = 0;
    const capture: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const body = await request.text();
      const target = new URL(request.url).pathname === "/v1/traces" ? traces : logs;
      if (body.length <= 262_144 && target.length < 4) target.push(body);
      else dropped++;
      return Response.json({});
    };
    const value = yield* effect.pipe(
      Effect.provide(
        telemetryLayer(
          {
            service: "executor-app",
            version: "invocation",
            environment: "isolated",
            clock: "WebSocketPair" in globalThis ? "cloudflare-io" : "system",
            traces: { url: "http://telemetry.internal/v1/traces" },
            logs: { url: "http://telemetry.internal/v1/logs" },
          },
          "event",
        ),
      ),
      Effect.provideService(FetchHttpClient.Fetch, capture),
    );
    return { value, telemetry: { traces, logs, dropped } };
  });

const HexTrace = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/));
const HexSpan = Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/));
// Parse correlation fields and retain the rest of each native OTLP record verbatim.
const Span = Schema.StructWithRest(Schema.Struct({ traceId: HexTrace, spanId: HexSpan }), [
  Schema.Record(Schema.String, Schema.Json),
]);
const LogRecord = Schema.StructWithRest(
  Schema.Struct({ traceId: Schema.optional(HexTrace), spanId: Schema.optional(HexSpan) }),
  [Schema.Record(Schema.String, Schema.Json)],
);
const TracePayload = Schema.fromJsonString(
  Schema.Struct({
    resourceSpans: Schema.Array(
      Schema.Struct({
        scopeSpans: Schema.Array(
          Schema.Struct({ spans: Schema.Array(Span).check(Schema.isMaxLength(1000)) }),
        ),
      }),
    ),
  }),
);
const LogPayload = Schema.fromJsonString(
  Schema.Struct({
    resourceLogs: Schema.Array(
      Schema.Struct({
        scopeLogs: Schema.Array(
          Schema.Struct({ logRecords: Schema.Array(LogRecord).check(Schema.isMaxLength(1000)) }),
        ),
      }),
    ),
  }),
);

/** Validate isolated records and export only this call's trace, using parent-owned credentials/identity. */
export const forwardTelemetry = (
  batch: TelemetryBatch,
  traceId: string | undefined,
  build: string | undefined,
  service: "executor-app" | "executor-web" = "executor-app",
) =>
  Effect.gen(function* () {
    const config = yield* CurrentTelemetryConfig;
    if (config === undefined) return;
    const resource = {
      attributes: [
        { key: "service.name", value: { stringValue: service } },
        { key: "service.version", value: { stringValue: config.version } },
        { key: "deployment.environment.name", value: { stringValue: config.environment } },
        ...(build === undefined
          ? []
          : [{ key: "executor.build.id", value: { stringValue: build } }]),
      ],
    };
    const client = yield* HttpClient.HttpClient;
    if (batch.dropped > 0)
      yield* Effect.logWarning("Telemetry batches were dropped before forwarding").pipe(
        Effect.annotateLogs({ droppedBatches: batch.dropped }),
      );
    for (const signal of ["traces", "logs"] as const) {
      const target = config[signal];
      if (target === undefined) continue;
      for (const body of batch[signal]) {
        const data =
          signal === "traces"
            ? yield* Schema.decodeUnknownEffect(TracePayload)(body).pipe(
                Effect.map((payload) => ({
                  resourceSpans: [
                    {
                      resource,
                      scopeSpans: [
                        {
                          scope: { name: service },
                          spans: payload.resourceSpans
                            .flatMap((r) => r.scopeSpans.flatMap((s) => s.spans))
                            .filter((span) => traceId === undefined || span.traceId === traceId),
                        },
                      ],
                    },
                  ],
                })),
              )
            : yield* Schema.decodeUnknownEffect(LogPayload)(body).pipe(
                Effect.map((payload) => ({
                  resourceLogs: [
                    {
                      resource,
                      scopeLogs: [
                        {
                          scope: { name: service },
                          logRecords: payload.resourceLogs
                            .flatMap((r) => r.scopeLogs.flatMap((s) => s.logRecords))
                            .filter((log) => traceId === undefined || log.traceId === traceId),
                        },
                      ],
                    },
                  ],
                })),
              );
        yield* client
          .pipe(HttpClient.filterStatusOk)
          .execute(
            HttpClientRequest.post(target.url).pipe(
              HttpClientRequest.setHeaders(
                target.headers === undefined ? {} : Redacted.value(target.headers),
              ),
              HttpClientRequest.bodyJsonUnsafe(data),
            ),
          );
      }
    }
  }).pipe(
    Effect.provide(telemetryHttpClient),
    Effect.provideService(Tracer.DisablePropagation, true),
    Effect.timeout("3 seconds"),
  );
