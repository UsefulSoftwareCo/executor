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

import { createMiddleware } from "@tanstack/react-start";

const DOCS_UPSTREAM_HOST = "executor.mintlify.dev";

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
    return fetch(buildDocsUpstream(request));
  },
);
