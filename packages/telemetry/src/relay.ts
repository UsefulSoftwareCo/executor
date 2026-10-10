/** Bounded OTLP return channel for credential-free app isolates. The parent owns export. */
import { Effect, FiberSet, Option, Redacted, Schema, Semaphore, Tracer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { CurrentTelemetryConfig } from "./config.ts";
import { telemetryLayer } from "./layer.ts";
import { retryTelemetryExport, telemetryHttpClient } from "./transport.ts";
import { recordExportFailure } from "./measurements.ts";
import { appLog, appSpan } from "./app-records.ts";

/**
 * Forward app telemetry in the host scope without delaying an app result.
 * Batches wait in one queue and a single sender exports everything waiting as one request per
 * signal, so a burst of finished runs costs a few exports instead of one each. The queue holds at
 * most eight MiB of payload and one export carries at most four. Overload and shutdown loss are
 * reported through the normal safe export-failure signal. Scope release drains for the same
 * three-second budget as the other exporters.
 */
export const makeTelemetryForwarder = Effect.gen(function* () {
  const fibers = yield* FiberSet.make();
  const sender = yield* Semaphore.make(1);
  // Sizes are payload string lengths: UTF-16 code units, at most the payload's UTF-8 bytes.
  const pending: Array<Forward & { readonly size: number }> = [];
  let queued = 0;
  const failed = (reason: "capacity" | "timeout" | "relay" | "shutdown") =>
    recordExportFailure("app", reason);
  const take = () => {
    let size = 0;
    let count = 0;
    while (count < pending.length && (count === 0 || size + pending[count]!.size <= exportBudget))
      size += pending[count++]!.size;
    queued -= size;
    return pending.splice(0, count);
  };
  const sendAll: Effect.Effect<void> = Effect.suspend(() => {
    const forwards = take();
    return forwards.length === 0
      ? Effect.void
      : exportForwards(forwards, "executor-app").pipe(
          Effect.catchTag("TimeoutError", () => failed("timeout")),
          Effect.catch(() => failed("relay")),
          Effect.andThen(sendAll),
        );
  });
  // A batch queued after the sender's last look but before it lets go is sent by its recheck.
  const drain: Effect.Effect<void> = Effect.suspend(() =>
    sender
      .withPermitsIfAvailable(1)(sendAll)
      .pipe(
        Effect.flatMap((sent) => (Option.isSome(sent) && pending.length > 0 ? drain : Effect.void)),
      ),
  );
  yield* Effect.addFinalizer(() =>
    FiberSet.awaitEmpty(fibers).pipe(
      Effect.timeoutOption("3 seconds"),
      Effect.flatMap((drained) =>
        Option.isNone(drained) || pending.length > 0 ? failed("shutdown") : Effect.void,
      ),
    ),
  );
  return (batch: TelemetryBatch, traceId: string, source: TelemetrySource) =>
    Effect.suspend(() => {
      const size = [...batch.traces, ...batch.logs].reduce((total, body) => total + body.length, 0);
      if (queued + size > queueBudget) return failed("capacity");
      pending.push({ batch, traceId, source, size });
      queued += size;
      return FiberSet.run(fibers, drain).pipe(Effect.asVoid);
    });
});

const queueBudget = 8 * 1_048_576;
const exportBudget = 4 * 1_048_576;

const payloadBytes = 262_144;
const encoder = new TextEncoder();
const Payload = Schema.String.check(
  Schema.isMaxLength(payloadBytes),
  Schema.makeFilter((body) => encoder.encode(body).byteLength <= payloadBytes),
);
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
    const traces = recordPacker('{"resourceSpans":[{"scopeSpans":[{"spans":[', "]}]}]}");
    const logs = recordPacker('{"resourceLogs":[{"scopeLogs":[{"logRecords":[', "]}]}]}");
    let dropped = 0;
    const capture: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      // oxlint-disable-next-line executor/authored-code-through-adapter -- the exporter's own request
      const body = await request.text();
      if (new URL(request.url).pathname === "/v1/traces") {
        const payload = Schema.decodeUnknownSync(TracePayload)(body);
        dropped += traces.append(
          payload.resourceSpans.flatMap((resource) =>
            resource.scopeSpans.flatMap((scope) => scope.spans),
          ),
        );
      } else {
        const payload = Schema.decodeUnknownSync(LogPayload)(body);
        dropped += logs.append(
          payload.resourceLogs.flatMap((resource) =>
            resource.scopeLogs.flatMap((scope) => scope.logRecords),
          ),
        );
      }
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
    return { value, telemetry: { traces: traces.finish(), logs: logs.finish(), dropped } };
  });

// Native exporters split an invocation into several batches. Keep its last
// envelope open across batches so a partial envelope does not consume a slot.
// Both the four-envelope memory bound and 1,000-record decode bound still apply.
const recordPacker = (prefix: string, suffix: string) => {
  const target: string[] = [];
  let parts: string[] = [];
  const overhead = encoder.encode(prefix + suffix).byteLength;
  let bytes = overhead;
  const flush = () => {
    if (parts.length === 0) return;
    target.push(prefix + parts.join(",") + suffix);
    parts = [];
    bytes = overhead;
  };
  return {
    append(records: ReadonlyArray<Schema.Json>): number {
      let dropped = 0;
      for (const record of records) {
        const encoded = JSON.stringify(record);
        const size = encoder.encode(encoded).byteLength;
        if (size + overhead > payloadBytes || target.length >= 4) {
          dropped++;
          continue;
        }
        if (parts.length >= 1000 || bytes + size + (parts.length > 0 ? 1 : 0) > payloadBytes)
          flush();
        if (target.length >= 4) {
          dropped++;
          continue;
        }
        bytes += size + (parts.length > 0 ? 1 : 0);
        parts.push(encoded);
      }
      return dropped;
    },
    finish(): string[] {
      flush();
      return target;
    },
  };
};

const HexTrace = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u));
const HexSpan = Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/u));
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

/**
 * What the host knows about the records' source, from its own invocation rather than the records:
 * the build that ran and, for an app isolate, the app's opaque ID. Both become resource attributes.
 */
export interface TelemetrySource {
  readonly build?: string | undefined;
  readonly app?: string | undefined;
}

/** One forwarded batch: the records, the trace they must belong to, and who sent them. */
interface Forward {
  readonly batch: TelemetryBatch;
  readonly traceId: string | undefined;
  readonly source: TelemetrySource;
}

/** Validate isolated records and export only this call's trace, using parent-owned credentials/identity. */
export const forwardTelemetry = (
  batch: TelemetryBatch,
  traceId: string | undefined,
  source: TelemetrySource,
  service: "executor-app" | "executor-web" = "executor-app",
) => exportForwards([{ batch, traceId, source }], service);

/**
 * Export several batches as one request per signal. Each batch keeps its own resource entry, so
 * batches from different apps and builds share a request without sharing attributes.
 */
const exportForwards = (
  forwards: ReadonlyArray<Forward>,
  service: "executor-app" | "executor-web",
) =>
  Effect.gen(function* () {
    const config = yield* CurrentTelemetryConfig;
    if (config === undefined) return;
    const resource = ({ build, app }: TelemetrySource) => ({
      attributes: [
        { key: "service.name", value: { stringValue: service } },
        { key: "service.version", value: { stringValue: config.version } },
        { key: "deployment.environment.name", value: { stringValue: config.environment } },
        ...(build === undefined
          ? []
          : [{ key: "executor.build.id", value: { stringValue: build } }]),
        ...(app === undefined ? [] : [{ key: "executor.app.id", value: { stringValue: app } }]),
      ],
    });
    // A collector that refuses an export for now gets it again inside the three-second budget.
    const client = retryTelemetryExport(yield* HttpClient.HttpClient);
    const dropped = forwards.reduce((total, { batch }) => total + batch.dropped, 0);
    if (dropped > 0) yield* recordExportFailure("app", "capacity", dropped);
    for (const signal of ["traces", "logs"] as const) {
      const target = config[signal];
      const sending = forwards.filter(({ batch }) => batch[signal].length > 0);
      if (target === undefined || sending.length === 0) continue;
      // The isolate return channel is already bounded to four 256 KiB envelopes.
      // Send each signal once instead of serializing four network acknowledgements
      // inside the same three-second drain budget.
      const data =
        signal === "traces"
          ? {
              resourceSpans: yield* Effect.forEach(sending, ({ batch, traceId, source }) =>
                Effect.forEach(batch.traces, (body) =>
                  Schema.decodeUnknownEffect(TracePayload)(body),
                ).pipe(
                  Effect.map((payloads) => ({
                    resource: resource(source),
                    scopeSpans: [
                      {
                        scope: { name: service },
                        spans: payloads
                          .flatMap((payload) => payload.resourceSpans)
                          .flatMap((r) => r.scopeSpans.flatMap((s) => s.spans))
                          .filter((span) => traceId === undefined || span.traceId === traceId)
                          // An app isolate's records are rebuilt from the host's vocabulary.
                          .flatMap((span) => {
                            if (service !== "executor-app") return [span];
                            const kept = appSpan(span);
                            return kept === undefined ? [] : [kept];
                          }),
                      },
                    ],
                  })),
                ),
              ),
            }
          : {
              resourceLogs: yield* Effect.forEach(sending, ({ batch, traceId, source }) =>
                Effect.forEach(batch.logs, (body) =>
                  Schema.decodeUnknownEffect(LogPayload)(body),
                ).pipe(
                  Effect.map((payloads) => ({
                    resource: resource(source),
                    scopeLogs: [
                      {
                        scope: { name: service },
                        logRecords: payloads
                          .flatMap((payload) => payload.resourceLogs)
                          .flatMap((r) => r.scopeLogs.flatMap((s) => s.logRecords))
                          .filter((log) => traceId === undefined || log.traceId === traceId)
                          .map((log) => (service === "executor-app" ? appLog(log) : log)),
                      },
                    ],
                  })),
                ),
              ),
            };
      yield* client.execute(
        HttpClientRequest.post(target.url).pipe(
          HttpClientRequest.setHeaders(
            target.headers === undefined ? {} : Redacted.value(target.headers),
          ),
          HttpClientRequest.bodyJsonUnsafe(data),
        ),
      );
    }
  }).pipe(
    Effect.provide(telemetryHttpClient),
    Effect.provideService(Tracer.DisablePropagation, true),
    Effect.timeout("3 seconds"),
  );
