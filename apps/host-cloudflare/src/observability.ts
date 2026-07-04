// Cloudflare host observability.
//
// `ErrorCaptureLive` — the shared console implementation with a `cloudflare-`
// trace-id prefix. Worker stdout is routed to Logpush/the dashboard, so the
// squashed cause is grep-able by the opaque 500 traceId.
//
// `makeCloudflareObservabilityLayer` — structured JSON stdout logging plus the
// OTLP traces/logs/metrics pipeline (fetch-based, workerd-safe), enabled by
// the `OTEL_EXPORTER_OTLP_ENDPOINT` binding. A Worker has no module-scope
// bindings, so the layer closes over the per-fetch `env` instead of process.env.

import type { Layer } from "effect";

import { consoleErrorCapture } from "@executor-js/api/server";
import { observabilityLayer } from "@executor-js/observability";

import type { CloudflareEnv } from "./config";

export const ErrorCaptureLive = consoleErrorCapture("cloudflare");

export const makeCloudflareObservabilityLayer = (env: CloudflareEnv): Layer.Layer<never> =>
  observabilityLayer({
    serviceName: "executor-cloudflare",
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    headers: env.OTEL_EXPORTER_OTLP_HEADERS,
    logLevel: env.LOG_LEVEL,
  });
