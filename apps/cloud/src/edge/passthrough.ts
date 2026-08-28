// ---------------------------------------------------------------------------
// Pure passthrough proxies — dispatched from the Worker entry, before Start.
// ---------------------------------------------------------------------------
//
// `/docs` and the PostHog proxy forward to an external origin and never touch
// the router, React, or the Effect app. They lived in Start's request
// middleware, which meant each one still paid Start's lazy `loadEntries`
// import of the whole server graph before it could forward a request.
//
// Measured on production (2026-08-18), splitting the two costs apart on a cold
// isolate: the graph import is p50 **3.1s** while the request's own work is
// p50 **33ms**. And essentially every request is cold — `worker.dispatch` ran
// 1,666 requests across 1,608 isolates (1.04 req/isolate), because `/mcp`
// dispatches before `fetchHandler` and so never warms the graph. A `/docs`
// page took 3-6s through the Worker against 0.098s straight from the upstream.
//
// So these move to the Worker entry, exactly as marketing did: classify and
// forward before anything imports Start. This module therefore must NOT import
// `@tanstack/react-start` or any app module — that import is the cost it
// exists to avoid.
//
// The middleware wrappers in `./docs` and `./posthog` stay registered. In the
// deployed Worker they become unreachable (server.ts answers first), but they
// keep the behavior identical on any host that reaches Start by another entry
// (local dev), and they source their matching from here so the two can't drift.
// ---------------------------------------------------------------------------

import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

const DOCS_UPSTREAM_HOST = "executor.mintlify.dev";
/** PostHog's US ingest origin. Exported because the server-side feature-flag
 *  gate (`../analytics/ema-rollout`) calls the same origin directly, and the
 *  two must not be able to drift onto different PostHog regions. */
export const POSTHOG_INGEST_HOST = "us.i.posthog.com";
const POSTHOG_ASSETS_HOST = "us-assets.i.posthog.com";

export const POSTHOG_PROXY_PATH = `/api/${(
  import.meta.env.VITE_PUBLIC_ANALYTICS_PATH ?? "a"
).replace(/^\/+|\/+$/g, "")}`;

// The proxy fetch gets its own client span: `/docs` requests otherwise render
// as a single opaque server span, and during the Aug 2026 regression there
// was no way to tell upstream (Mintlify/Vercel) latency from worker-side
// dispatch cost. The noop tracer applies when no provider is installed
// (local dev without AXIOM_TOKEN), so this is free there.
const tracer = trace.getTracer("executor-cloud-docs-proxy");

export const isDocsPath = (pathname: string): boolean =>
  pathname === "/docs" || pathname.startsWith("/docs/");

export const isPosthogPath = (pathname: string): boolean =>
  pathname === POSTHOG_PROXY_PATH || pathname.startsWith(`${POSTHOG_PROXY_PATH}/`);

/**
 * Build the upstream request for an already-classified `/docs` path. Caller
 * guarantees `isDocsPath(pathname)` — we only swap the origin and fix up the
 * forwarding headers, preserving method, body, path, and query.
 */
export const buildDocsUpstream = (request: Request): Request => {
  const url = new URL(request.url);
  const forwardedHost = url.host;

  url.hostname = DOCS_UPSTREAM_HOST;
  url.protocol = "https:";
  url.port = "";

  const upstream = new Request(url, request);
  // Mintlify keys canonical links off the public host; tell it the real one.
  upstream.headers.set("X-Forwarded-Host", forwardedHost);
  upstream.headers.set("X-Forwarded-Proto", "https");
  // Never leak the executor.sh session cookie to the docs origin.
  upstream.headers.delete("cookie");
  return upstream;
};

/** Build the upstream request for an already-classified PostHog proxy path. */
export const buildPosthogUpstream = (request: Request, pathname: string): Request => {
  const url = new URL(request.url);
  url.hostname = pathname.startsWith(`${POSTHOG_PROXY_PATH}/static/`)
    ? POSTHOG_ASSETS_HOST
    : POSTHOG_INGEST_HOST;
  url.protocol = "https:";
  url.port = "";
  url.pathname = pathname.slice(POSTHOG_PROXY_PATH.length) || "/";

  const upstream = new Request(url, request);
  upstream.headers.delete("cookie");
  return upstream;
};

export const docsProxyResponse = (request: Request, pathname: string): Promise<Response> =>
  tracer.startActiveSpan(
    `http.client ${request.method}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "server.address": DOCS_UPSTREAM_HOST,
        "url.path": pathname,
        "http.request.method": request.method,
      },
    },
    async (span) => {
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary; observe upstream response/error for span status, then pass both through unchanged
      try {
        const response = await fetch(buildDocsUpstream(request));
        span.setAttribute("http.response.status_code", response.status);
        if (response.status >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${response.status}` });
        }
        return response;
      } catch (err) {
        // oxlint-disable-next-line executor/no-instanceof-error, executor/no-unknown-error-message -- adapter boundary: fetch rejects untyped; normalized only for the OTel span record, the original error is rethrown below
        const cause = err instanceof Error ? err : String(err);
        span.recordException(cause);
        // oxlint-disable-next-line executor/no-unknown-error-message -- adapter boundary: same normalization as the recordException line above
        const message = typeof cause === "string" ? cause : cause.message;
        span.setStatus({ code: SpanStatusCode.ERROR, message });
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary; preserve the original rejection for the platform handler
        throw err;
      } finally {
        span.end();
      }
    },
  );

/**
 * Answer a pure passthrough request without loading the Start server graph.
 * Returns `null` when the request belongs to the app, so the caller falls
 * through to normal dispatch.
 */
export const passthroughResponse = (
  request: Request,
  pathname: string,
): Promise<Response> | null => {
  if (isDocsPath(pathname)) return docsProxyResponse(request, pathname);
  if (isPosthogPath(pathname)) return fetch(buildPosthogUpstream(request, pathname));
  return null;
};
