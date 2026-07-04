// ---------------------------------------------------------------------------
// Local-app observability.
//
// `ErrorCaptureLive` — the shared console implementation with a `local-`
// trace id prefix. Prints the squashed cause + pretty-printed structured cause
// to stderr and returns a short correlation id. Operators can grep for the id
// in their terminal scrollback when a user reports an opaque 500 traceId.
//
// `LocalObservabilityLive` — structured JSON stdout logging plus the OTLP
// traces/logs/metrics pipeline (enabled by `OTEL_EXPORTER_OTLP_ENDPOINT`).
// It rides in the app's `boot` layer for the typed `/api`, and the in-process
// MCP surface (`mcp.ts`) runs its Effects through `observabilityRuntime` so
// tool-call logs, spans, and metrics flow through the SAME pipeline. The
// runtime is process-lifetime: disposing it flushes buffered OTLP exports.
// ---------------------------------------------------------------------------

import { ManagedRuntime, type Layer } from "effect";

import { consoleErrorCapture } from "@executor-js/api/server";
import { observabilityLayer } from "@executor-js/observability";

export const ErrorCaptureLive = consoleErrorCapture("local");

export const LocalObservabilityLive: Layer.Layer<never> = observabilityLayer({
  serviceName: "executor-local",
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  headers: process.env.OTEL_EXPORTER_OTLP_HEADERS,
  logLevel: process.env.LOG_LEVEL,
});

// Built lazily on first use and re-creatable after dispose (mirrors
// `serverHandlersRuntime` in main.ts, whose handlers can be rebuilt after
// `disposeServerHandlers`). A ManagedRuntime separate from the boot layer
// means the MCP surface owns its own exporter lifetime (the boot layer's copy
// is scoped to the API handler).
let observabilityRuntime: ManagedRuntime.ManagedRuntime<never, never> | null = null;

export const getObservabilityRuntime = (): ManagedRuntime.ManagedRuntime<never, never> => {
  observabilityRuntime ??= ManagedRuntime.make(LocalObservabilityLive);
  return observabilityRuntime;
};

/** Dispose the MCP surface's observability runtime, flushing pending OTLP exports. */
export const disposeObservabilityRuntime = async (): Promise<void> => {
  const runtime = observabilityRuntime;
  if (!runtime) return;
  observabilityRuntime = null;
  await runtime.dispose();
};
