/** Telemetry uses a host-selected HTTP client without changing product HTTP requests. */
import { BinaryReader, WireType } from "@bufbuild/protobuf/wire";
import { Clock, Context, Duration, Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError, type HttpClientResponse } from "effect/http";
import { recordExportFailure } from "./measurements.ts";
import { telemetryRequestTimeout } from "./config.ts";

/** Local collector discovery can resolve its destination when an export runs. */
export const CurrentTelemetryClient = Context.Reference<HttpClient.HttpClient | undefined>(
  "executor/TelemetryClient",
  { defaultValue: () => undefined },
);

/** Exporters and browser/app relays use the same host transport; normal hosts use fetch. */
const selectedClient = Layer.unwrap(
  CurrentTelemetryClient.pipe(
    Effect.map((client) =>
      // Export-only RequestInit options, such as browser keepalive, must not
      // enter product clients that share the page's Layer memo map.
      client === undefined
        ? Layer.fresh(FetchHttpClient.layer)
        : Layer.succeed(HttpClient.HttpClient, client),
    ),
  ),
);

const Count = Schema.Union([Schema.Number, Schema.NumberFromString]).check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Acknowledgement = Schema.Struct({
  partialSuccess: Schema.optional(
    Schema.Struct({
      rejectedSpans: Schema.optional(Count),
      rejectedLogRecords: Schema.optional(Count),
      rejectedDataPoints: Schema.optional(Count),
      errorMessage: Schema.optional(Schema.String),
    }),
  ),
});

// Export{Trace,Logs,Metrics}ServiceResponse all have partial_success at field 1.
// Its field 1 is the rejected int64 count and field 2 is a diagnostic string.
// The maintained wire reader owns bounds, integer decoding and unknown fields.
const protobufAcknowledgement = (bytes: Uint8Array) => {
  const reader = new BinaryReader(bytes);
  let rejected = "0";
  let message = "";
  while (reader.pos < reader.len) {
    const [field, wire] = reader.tag();
    if (field !== 1 || wire !== WireType.LengthDelimited) {
      reader.skip(wire, field);
      continue;
    }
    const partial = new BinaryReader(reader.bytes());
    while (partial.pos < partial.len) {
      const [field, wire] = partial.tag();
      if (field === 1 && wire === WireType.Varint) rejected = String(partial.int64());
      else if (field === 2 && wire === WireType.LengthDelimited) message = partial.string();
      else partial.skip(wire, field);
    }
  }
  return { partialSuccess: { rejectedDataPoints: rejected, errorMessage: message } };
};

const acknowledge = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    const bytes = new Uint8Array(yield* response.arrayBuffer);
    const decoded = yield* Effect.try({
      try: (): unknown => {
        if (bytes.byteLength === 0) return {};
        if (response.headers["content-type"]?.includes("application/x-protobuf")) {
          return protobufAcknowledgement(bytes);
        }
        return JSON.parse(new TextDecoder().decode(bytes));
      },
      catch: () =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.DecodeError({
            request: response.request,
            response,
            description: "Invalid OTLP acknowledgement",
          }),
        }),
    });
    const acknowledgement = yield* Schema.decodeUnknownEffect(Acknowledgement)(decoded).pipe(
      Effect.mapError(
        () =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.DecodeError({
              request: response.request,
              response,
              description: "Invalid OTLP acknowledgement",
            }),
          }),
      ),
    );
    const partial = acknowledgement.partialSuccess;
    if (partial === undefined) return;
    const rejected =
      (partial.rejectedSpans ?? 0) +
      (partial.rejectedLogRecords ?? 0) +
      (partial.rejectedDataPoints ?? 0);
    // OTLP prohibits retrying partial success. Account for it without resending
    // accepted records, and never log a collector's potentially sensitive body.
    if (rejected > 0 || partial.errorMessage)
      yield* recordExportFailure(
        new URL(response.request.url).pathname,
        "partial-success",
        rejected,
      );
  });

/** Telemetry consumers inspect status and headers; release response I/O inside each export scope. */
export const telemetryHttpClient = Layer.effect(
  HttpClient.HttpClient,
  HttpClient.HttpClient.pipe(
    Effect.map((client) =>
      client.pipe(
        HttpClient.filterStatusOk,
        HttpClient.transform((response, request) =>
          Effect.flatMap(Clock.currentTimeMillis, (started) => {
            const path = new URL(request.url).pathname;
            const elapsed = Effect.map(Clock.currentTimeMillis, (now) => now - started);
            return response.pipe(
              Effect.tap(acknowledge),
              Effect.timeout(telemetryRequestTimeout),
              Effect.catchTag("TimeoutError", () =>
                Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request,
                      description: "Telemetry collector acknowledgement timed out",
                    }),
                  }),
                ),
              ),
              Effect.tapError((error) => {
                const reason =
                  HttpClientError.isHttpClientError(error) &&
                  error.reason instanceof HttpClientError.DecodeError
                    ? "acknowledgement"
                    : "transport";
                return Effect.flatMap(elapsed, (ms) =>
                  recordExportFailure(path, reason, 0, ms),
                ).pipe(
                  Effect.annotateLogs({
                    "executor.telemetry.http_status": error.response?.status ?? 0,
                    "executor.telemetry.timed_out":
                      error.reason instanceof HttpClientError.TransportError &&
                      error.reason.description === "Telemetry collector acknowledgement timed out",
                  }),
                );
              }),
              Effect.onInterrupt(() =>
                Effect.flatMap(elapsed, (ms) => recordExportFailure(path, "interrupted", 0, ms)),
              ),
            );
          }),
        ),
        HttpClient.withScope,
        HttpClient.transformResponse(Effect.scoped),
      ),
    ),
  ),
).pipe(Layer.provide(selectedClient));

/**
 * Effect's exporter policy, extended to 503 as OTLP requires: a 429 or 503 waits for the delay
 * in seconds or the HTTP date its Retry-After names, five seconds when that is unreadable or a
 * 429 names none. Other failures wait a second.
 */
const retryDelay = (error: unknown) =>
  Effect.gen(function* () {
    if (
      !HttpClientError.isHttpClientError(error) ||
      error.reason._tag !== "StatusCodeError" ||
      (error.reason.response.status !== 429 && error.reason.response.status !== 503)
    )
      return Duration.seconds(1);
    const header = error.reason.response.headers["retry-after"]?.trim();
    if (header === undefined || header === "")
      return Duration.seconds(error.reason.response.status === 429 ? 5 : 1);
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Duration.seconds(seconds >= 0 ? seconds : 5);
    const date = Date.parse(header);
    if (Number.isNaN(date)) return Duration.seconds(5);
    return Duration.millis(Math.max(date - (yield* Clock.currentTimeMillis), 1));
  });

/** The attempts an export makes after its first, at most. */
const retries = 3;

/**
 * How long one export may take, its retries included. Cloudflare keeps an event's `waitUntil` work
 * 30 seconds after its response, and an event's close waits a second for its flush before the
 * response of a streamed request ends (`closeWait` in isolate.ts); 27 seconds leaves both, and
 * every export, the timer's included, runs inside some event's `waitUntil`.
 */
const exportBudget = Duration.seconds(27);

/**
 * Resend an export the collector refused for now, as OTLP requires and Effect's own
 * exporters do: lost connections, timeouts, 429 and 5xx overload, at most three more times. A
 * collector shedding load answers 429 or 503 with Retry-After, which sets the wait, as long as the
 * next attempt, with its own time-out, still ends within `exportBudget`; a longer wait is shortened
 * to that, so the last attempt runs before the runtime would cut it off. When no attempt fits, the
 * export ends with its last failure.
 */
export const retryTelemetryExport = (client: HttpClient.HttpClient) =>
  client.pipe(
    HttpClient.transformResponse((response) =>
      Effect.flatMap(Clock.currentTimeMillis, (started) => {
        const attemptMs = Duration.toMillis(Duration.fromInputUnsafe(telemetryRequestTimeout));
        const deadline = started + Duration.toMillis(exportBudget);
        const attempt = (made: number): typeof response =>
          response.pipe(
            Effect.catchIf(
              (error) => made < retries && HttpClient.isTransientError(error),
              (error) =>
                Effect.gen(function* () {
                  const wanted = Duration.toMillis(yield* retryDelay(error));
                  const left = deadline - (yield* Clock.currentTimeMillis) - attemptMs;
                  if (left < 0) return yield* Effect.fail(error);
                  yield* Effect.sleep(Duration.millis(Math.min(wanted, left)));
                  return yield* attempt(made + 1);
                }),
            ),
          );
        return attempt(0);
      }),
    ),
  );
