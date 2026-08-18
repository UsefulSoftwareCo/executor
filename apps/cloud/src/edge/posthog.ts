// ---------------------------------------------------------------------------
// PostHog reverse proxy — the browser SDK targets a build-randomized
// first-party path and we forward to PostHog's ingest + asset hosts. Keeps
// events flowing past adblockers that match *.posthog.com. See
// https://posthog.com/docs/advanced/proxy/cloudflare
//
// The matching and forwarding live in `./passthrough`, which server.ts
// dispatches BEFORE Start loads (a proxy must not pay for the server graph).
// This middleware stays registered so hosts that reach Start by another entry
// keep identical behavior; in the deployed Worker it is unreachable.
// ---------------------------------------------------------------------------

import { createMiddleware } from "@tanstack/react-start";

import { buildPosthogUpstream, isPosthogPath } from "./passthrough";

export const posthogProxyMiddleware = createMiddleware({ type: "request" }).server(
  ({ pathname, request, next }) => {
    if (!isPosthogPath(pathname)) return next();
    return fetch(buildPosthogUpstream(request, pathname));
  },
);
