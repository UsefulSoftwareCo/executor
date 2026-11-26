import {
  Context,
  Effect,
  FiberSet,
  Option,
  Redacted,
  Schema,
  Scope,
  Semaphore,
  Tracer,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { CurrentTelemetryConfig } from "./config.ts";
import { telemetryLayer } from "./layer.ts";
import { retryTelemetryExport, telemetryHttpClient } from "./transport.ts";
import { recordExportFailure } from "./measurements.ts";
import { appLog, appSpan } from "./app-records.ts";

const forwarder = Effect.gen(function* () {
  const fibers = yield* FiberSet.make();
  const sender = yield* Semaphore.make(1);
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
  let closing = false;
  let deadlineWhileClosing = false;
  const sendAll: Effect.Effect<void> = Effect.suspend(() => {
    const forwards = take();
    return forwards.length === 0
      ? Effect.void
      : exportForwards(forwards, "executor-app").pipe(
          Effect.catchTag("TimeoutError", () =>
            Effect.sync(() => {
              if (closing) deadlineWhileClosing = true;
            }).pipe(Effect.andThen(failed("timeout"))),
          ),
          Effect.catch(() => failed("relay")),
          Effect.andThen(sendAll),
        );
  });
  const drain: Effect.Effect<void> = Effect.suspend(() =>
    sender
      .withPermitsIfAvailable(1)(sendAll)
      .pipe(
        Effect.flatMap((sent) => (Option.isSome(sent) && pending.length > 0 ? drain : Effect.void)),
      ),
  );
  const reportWait = yield* TelemetryWaitReport;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closing = true;
    }).pipe(
      Effect.andThen(FiberSet.awaitEmpty(fibers)),
      Effect.timeoutOption("3 seconds"),
      Effect.tap((drained) =>
        Option.isNone(drained) || deadlineWhileClosing ? reportWait("forwarder") : Effect.void,
      ),
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

export type TelemetryWait = "forwarder" | "analytics";
export const TelemetryWaitReport = Context.Reference<(wait: TelemetryWait) => Effect.Effect<void>>(
  "@executor-js/telemetry/TelemetryWaitReport",
  { defaultValue: () => () => Effect.void },
);

export const TelemetryDrainScope = Context.Reference<Scope.Scope | undefined>(
  "@executor-js/telemetry/TelemetryDrainScope",
  { defaultValue: () => undefined },
);

export const makeTelemetryForwarder = Effect.flatMap(TelemetryDrainScope, (scope) =>
  scope === undefined
    ? forwarder
    : Effect.flatMap(Scope.fork(scope, "sequential"), (own) => Scope.provide(forwarder, own)),
);

const queueBudget = 8 * 1_048_576;
const exportBudget = 4 * 1_048_576;

const payloadBytes = 262_144;
const encoder = new TextEncoder();
const Payload = Schema.String.check(
  Schema.isMaxLength(payloadBytes),
  Schema.makeFilter((body) => encoder.encode(body).byteLength <= payloadBytes),
);
export const TelemetryBatch = Schema.Struct({
  traces: Schema.Array(Payload).check(Schema.isMaxLength(4)),
  logs: Schema.Array(Payload).check(Schema.isMaxLength(4)),
  dropped: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type TelemetryBatch = typeof TelemetryBatch.Type;

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

export interface TelemetrySource {
  readonly build?: string | undefined;
  readonly app?: string | undefined;
}

interface Forward {
  readonly batch: TelemetryBatch;
  readonly traceId: string | undefined;
  readonly source: TelemetrySource;
}

export const forwardTelemetry = (
  batch: TelemetryBatch,
  traceId: string | undefined,
  source: TelemetrySource,
  service: "executor-app" | "executor-web" = "executor-app",
) => exportForwards([{ batch, traceId, source }], service);

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
    const client = retryTelemetryExport(yield* HttpClient.HttpClient);
    const dropped = forwards.reduce((total, { batch }) => total + batch.dropped, 0);
    if (dropped > 0) yield* recordExportFailure("app", "capacity", dropped);
    const send = (signal: "traces" | "logs") =>
      Effect.gen(function* () {
        const target = config[signal];
        const sending = forwards.filter(({ batch }) => batch[signal].length > 0);
        if (target === undefined || sending.length === 0) return;
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
      });
    const sent = yield* Effect.forEach(
      ["traces", "logs"] as const,
      (signal) => Effect.result(send(signal)),
      { concurrency: "unbounded" },
    );
    yield* Effect.forEach(sent, (result) => Effect.fromResult(result), { discard: true });
  }).pipe(
    Effect.provide(telemetryHttpClient),
    Effect.provideService(Tracer.DisablePropagation, true),
    Effect.timeout("3 seconds"),
  );
