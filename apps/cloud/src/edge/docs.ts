// ---------------------------------------------------------------------------
// Docs reverse proxy — `/docs` (and everything under it) is served by Mintlify,
// not this worker. We forward those requests to the Mintlify deployment so the
// docs live on the first-party origin (`executor.sh/docs`) instead of a
// `*.mintlify.dev` subdomain. Mintlify hosts the site under the same `/docs`
// base path, so the pathname is forwarded UNCHANGED — only the host/proto swap
// to the upstream origin (unlike the PostHog proxy, which strips its prefix).
//
// Like the PostHog/Sentry tunnels (and unlike the marketing proxy, which needs
// the prod-only `env.MARKETING` service binding), this is a plain external
// `fetch`, so it runs on every host — `/docs` previews against live Mintlify in
// local dev too. `/docs` is distinct from the app-owned `/api/docs` (Swagger),
// so this never shadows an Effect-served route.
// ---------------------------------------------------------------------------

import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { createMiddleware } from "@tanstack/react-start";

const DOCS_UPSTREAM_HOST = "executor.mintlify.dev";

// The proxy fetch gets its own client span: `/docs` requests otherwise render
// as a single opaque server span, and during the Aug 2026 regression there
// was no way to tell upstream (Mintlify/Vercel) latency from worker-side
// dispatch cost. The noop tracer applies when no provider is installed
// (local dev without AXIOM_TOKEN), so this is free there.
const tracer = trace.getTracer("executor-cloud-docs-proxy");

export const isDocsPath = (pathname: string) =>
  pathname === "/docs" || pathname.startsWith("/docs/");

// Build the upstream request for an already-classified `/docs` path. Caller
// guarantees `isDocsPath(pathname)` — we only swap the origin and fix up the
// forwarding headers, preserving method, body, path, and query.
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

export const docsProxyMiddleware = createMiddleware({ type: "request" }).server(
  ({ pathname, request, next }) => {
    if (!isDocsPath(pathname)) return next();
    return tracer.startActiveSpan(
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
  },
);
