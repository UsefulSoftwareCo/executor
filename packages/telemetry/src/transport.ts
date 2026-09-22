/** Telemetry uses a host-selected HTTP client without changing product HTTP requests. */
import { Context, Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { recordExportFailure } from "./measurements.ts";

/** Local collector discovery can resolve its destination when an export runs. */
export const CurrentTelemetryClient = Context.Reference<HttpClient.HttpClient | undefined>(
  "executor/TelemetryClient",
  { defaultValue: () => undefined },
);

/** Exporters and browser/app relays use the same host transport; normal hosts use fetch. */
const selectedClient = Layer.unwrap(
  CurrentTelemetryClient.pipe(
    Effect.map((client) =>
      client === undefined ? FetchHttpClient.layer : Layer.succeed(HttpClient.HttpClient, client),
    ),
  ),
);

/** Telemetry consumers inspect status and headers; release response I/O inside each export scope. */
export const telemetryHttpClient = Layer.effect(
  HttpClient.HttpClient,
  HttpClient.HttpClient.pipe(
    Effect.map((client) =>
      client.pipe(
        HttpClient.filterStatusOk,
        HttpClient.transform((response, request) =>
          response.pipe(Effect.tapError(() => recordExportFailure(new URL(request.url).pathname))),
        ),
        HttpClient.withScope,
        HttpClient.transformResponse(Effect.scoped),
      ),
    ),
  ),
).pipe(Layer.provide(selectedClient));
