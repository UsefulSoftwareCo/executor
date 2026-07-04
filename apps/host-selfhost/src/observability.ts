// ---------------------------------------------------------------------------
// Self-host observability.
//
// `ErrorCaptureLive` — the shared console implementation with a `selfhost-`
// trace id prefix. Prints the squashed + pretty cause to stderr and returns a
// short correlation id that surfaces in the opaque 500 traceId, so operators
// can grep their logs. Cloud swaps in a Sentry-backed impl behind the same tag.
//
// `SelfHostObservabilityLive` — structured JSON stdout logging plus the OTLP
// traces/logs/metrics pipeline, enabled by `OTEL_EXPORTER_OTLP_ENDPOINT`.
// ---------------------------------------------------------------------------

import type { Layer } from "effect";

import { consoleErrorCapture } from "@executor-js/api/server";
import { observabilityLayer } from "@executor-js/observability";

export const ErrorCaptureLive = consoleErrorCapture("selfhost");

export const SelfHostObservabilityLive: Layer.Layer<never> = observabilityLayer({
  serviceName: "executor-selfhost",
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  headers: process.env.OTEL_EXPORTER_OTLP_HEADERS,
  logLevel: process.env.LOG_LEVEL,
});
