// ---------------------------------------------------------------------------
// Browser tracing layer — extracted from client.tsx so the export path itself
// is testable: what leaves the page is exactly what this layer serializes.
// ---------------------------------------------------------------------------

import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { OtlpTracer } from "effect/unstable/observability";
import * as Layer from "effect/Layer";

import { UrlRedactingOtlpSerializationJson } from "@executor-js/sdk/shared";

/**
 * OTLP tracing for the browser client, exporting to `tracesUrl`.
 *
 * The serialization layer is the redacting one from `@executor-js/sdk`: the
 * page exports its own spans (no server-side span processor ever sees them),
 * so credential-bearing URL components — query values, userinfo, fragments,
 * and URLs embedded in error text — are scrubbed at the serialization seam
 * before the batch leaves the page.
 *
 * `TracerDisabledWhen` must be URL-scoped, NOT a blanket `() => true` on the
 * exporter's client: addGlobalLayer leaks provided references into the shared
 * runtime context, and a blanket predicate silently disables tracing for
 * EVERY HttpClient — no spans, no traceparent, no export, no error.
 * URL-scoped, the leak is the desired behavior: any client posting to the
 * OTLP endpoint (the exporter) goes untraced, everything else is traced.
 */
export const makeBrowserTracingLayer = (tracesUrl: string): Layer.Layer<never> =>
  Layer.mergeAll(
    OtlpTracer.layer({
      url: tracesUrl,
      resource: { serviceName: "executor-web" },
      // Browser sessions are short; the 5s default loses the tail spans when
      // the tab closes.
      exportInterval: "1 second",
    }).pipe(Layer.provide(UrlRedactingOtlpSerializationJson), Layer.provide(FetchHttpClient.layer)),
    Layer.succeed(HttpClient.TracerDisabledWhen, (request) => request.url.includes("/v1/traces")),
  );
