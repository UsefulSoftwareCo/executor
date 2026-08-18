// ---------------------------------------------------------------------------
// Docs reverse proxy — `/docs` (and everything under it) is served by Mintlify,
// not this worker. We forward those requests to the Mintlify deployment so the
// docs live on the first-party origin (`executor.sh/docs`) instead of a
// `*.mintlify.dev` subdomain. Mintlify hosts the site under the same `/docs`
// base path, so the pathname is forwarded UNCHANGED — only the host/proto swap
// to the upstream origin (unlike the PostHog proxy, which strips its prefix).
//
// The matching, upstream construction, and client span live in `./passthrough`,
// which server.ts dispatches BEFORE Start loads: forwarding a docs page must
// not pay for the whole server graph. This middleware stays registered so hosts
// that reach Start by another entry (local dev) keep identical behavior; in the
// deployed Worker it is unreachable. `/docs` is distinct from the app-owned
// `/api/docs` (Swagger), so this never shadows an Effect-served route.
// ---------------------------------------------------------------------------

import { createMiddleware } from "@tanstack/react-start";

import { docsProxyResponse, isDocsPath } from "./passthrough";

export { buildDocsUpstream, isDocsPath } from "./passthrough";

export const docsProxyMiddleware = createMiddleware({ type: "request" }).server(
  ({ pathname, request, next }) => {
    if (!isDocsPath(pathname)) return next();
    return docsProxyResponse(request, pathname);
  },
);
