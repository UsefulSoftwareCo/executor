import * as Atom from "effect/unstable/reactivity/Atom";
import * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability";
import { ExecutorApi } from "@executor-js/api/client";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { reportHandledFrontendError } from "./error-reporting";
import { notifyLocalAuthRequired } from "./local-auth";
import {
  EXECUTOR_ORG_HEADER,
  getActiveOrgSlug,
  getExecutorApiBaseUrl,
  getExecutorServerAuthorizationHeader,
} from "./server-connection";

const isApiClientInfrastructureCause = (cause: Cause.Cause<unknown>): boolean =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => false,
    onSome: (error) => Schema.isSchemaError(error) || HttpClientError.isHttpClientError(error),
  });

export const reportApiClientInfrastructureCause = (cause: Cause.Cause<unknown>) =>
  Effect.sync(() => {
    if (!isApiClientInfrastructureCause(cause)) return;
    reportHandledFrontendError(cause, {
      surface: "api_client",
      action: "decode_or_transport",
    });
  });

const isUnauthorizedCause = (cause: Cause.Cause<unknown>): boolean =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => false,
    onSome: (error) =>
      HttpClientError.isHttpClientError(error) &&
      "response" in error &&
      (error as { readonly response?: { readonly status?: number } }).response?.status === 401,
  });

const handleApiClientCause = (cause: Cause.Cause<unknown>) =>
  Effect.suspend(() => {
    // A 401 is an expected, handled state — show the local login gate (or, on a
    // hosted surface, the session re-auth). It is NOT an infrastructure error,
    // so don't surface it as frontend telemetry: that was noise, and via
    // globalThis.reportError it also tripped vite's dev error overlay, covering
    // the gate. Other causes (schema/transport) still report.
    if (isUnauthorizedCause(cause)) {
      notifyLocalAuthRequired();
      return Effect.void;
    }
    return reportApiClientInfrastructureCause(cause);
  });

// ---------------------------------------------------------------------------
// Browser tracing — only when the build names an OTLP endpoint
// (VITE_PUBLIC_OTLP_TRACES_URL; e2e points it at a local motel through a
// dev proxy). With a Tracer in the runtime, Effect's HttpClient opens an
// http.client span around every API request AND sends the W3C traceparent
// header, so server spans join the browser's trace — one trace from the
// click to the database. Without the env var this is exactly
// FetchHttpClient.layer: no tracing code in the hot path.
// ---------------------------------------------------------------------------

// Plain member access — vite `define` rewrites the exact expression
// `import.meta.env.VITE_PUBLIC_OTLP_TRACES_URL`; optional chaining would
// dodge the replacement and always read undefined.
const otlpTracesUrl = import.meta.env.VITE_PUBLIC_OTLP_TRACES_URL as string | undefined;
// Per-SESSION sampling for production: a page either traces everything it
// does or nothing (per-span sampling would shred the waterfalls). Unset = 1.
const otlpSampleRatio = Number(
  (import.meta.env.VITE_PUBLIC_OTLP_SAMPLE_RATIO as string | undefined) ?? "1",
);

// The tracer must reach the runtime context the atom effects EXECUTE in.
// Merging it into the `httpClient` option doesn't: AtomHttpApi builds the
// client with `Layer.provide(clientLayer, httpClient)`, which consumes the
// tracer during construction without exposing it to the running fibers
// (spans then come from the default native tracer — ids and traceparent,
// no export). addGlobalLayer is provideMerge'd into every runtime built by
// the default factory, which is exactly what AtomHttpApi services use.
//
// TracerDisabledWhen must be URL-scoped, NOT a blanket `() => true` on the
// exporter's client: addGlobalLayer leaks provided references into the
// shared runtime context, and a blanket predicate silently disables
// tracing for EVERY HttpClient — no spans, no traceparent, no export, no
// error. URL-scoped, the leak is the desired behavior: any client posting
// to the OTLP endpoint (the exporter) goes untraced, everything else is
// traced.
// Browser-only (this module is also evaluated during SSR, where the worker
// has its own tracer and a relative exporter URL would be meaningless).
if (otlpTracesUrl && typeof document !== "undefined" && Math.random() < otlpSampleRatio) {
  Atom.runtime.addGlobalLayer(
    Layer.mergeAll(
      OtlpTracer.layer({
        // Relative paths (the prod shape: "/v1/traces" → the worker's
        // forwarding route) resolve against the page's own origin.
        url: new URL(otlpTracesUrl, window.location.origin).toString(),
        resource: { serviceName: "executor-web" },
        // Browser sessions are short; the 5s default loses the tail spans
        // when the tab closes.
        exportInterval: "1 second",
      }).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer)),
      Layer.succeed(HttpClient.TracerDisabledWhen, (request) => request.url.includes("/v1/traces")),
    ),
  );
}

// ---------------------------------------------------------------------------
// Core API client — tools + secrets
// ---------------------------------------------------------------------------

const ExecutorApiClient = AtomHttpApi.Service<"ExecutorApiClient">()("ExecutorApiClient", {
  api: ExecutorApi,
  httpClient: FetchHttpClient.layer,
  transformClient: HttpClient.mapRequest((request) => {
    let next = HttpClientRequest.prependUrl(request, getExecutorApiBaseUrl());
    const authorization = getExecutorServerAuthorizationHeader();
    if (authorization) {
      next = HttpClientRequest.setHeader(next, "authorization", authorization);
    }
    // Scope the request to the org the console URL is on (see server-connection).
    const orgSlug = getActiveOrgSlug();
    if (orgSlug) {
      next = HttpClientRequest.setHeader(next, EXECUTOR_ORG_HEADER, orgSlug);
    }
    return next;
  }),
  transformResponse: (effect) => Effect.tapCause(effect, handleApiClientCause),
});

export { ExecutorApiClient };
