/** Telemetry uses a host-selected HTTP client without changing product HTTP requests. */
import { BinaryReader, WireType } from "@bufbuild/protobuf/wire";
import { Context, Effect, Layer, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  type HttpClientResponse,
} from "effect/unstable/http";
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
          response.pipe(
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
            Effect.tapError((error) =>
              recordExportFailure(
                new URL(request.url).pathname,
                HttpClientError.isHttpClientError(error) &&
                  error.reason instanceof HttpClientError.DecodeError
                  ? "acknowledgement"
                  : "transport",
              ).pipe(
                Effect.annotateLogs({
                  "executor.telemetry.http_status": error.response?.status ?? 0,
                  "executor.telemetry.timed_out":
                    error.reason instanceof HttpClientError.TransportError &&
                    error.reason.description === "Telemetry collector acknowledgement timed out",
                }),
              ),
            ),
            Effect.onInterrupt(() =>
              recordExportFailure(new URL(request.url).pathname, "interrupted"),
            ),
          ),
        ),
        HttpClient.withScope,
        HttpClient.transformResponse(Effect.scoped),
      ),
    ),
  ),
).pipe(Layer.provide(selectedClient));
