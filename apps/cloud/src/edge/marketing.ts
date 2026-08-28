// ---------------------------------------------------------------------------
// Marketing routes — proxied to the marketing worker via service binding.
//
// On the production domain (`executor.sh`), marketing paths and the
// unauthenticated landing page are served by the separate `executor-marketing`
// worker. This module deliberately has no TanStack Start or cloud application
// imports: the Worker entry calls it before loading the Start server graph.
// ---------------------------------------------------------------------------

import { parseCookie } from "../auth/cookies";

const MARKETING_PATHS = [
  "/home",
  "/setup",
  "/privacy",
  "/terms",
  "/about-executor",
  "/google-oauth",
  "/google-workspace",
  "/blog",
  "/changelog",
  "/changelog.json",
  "/llms.txt",
  "/api/detect",
  "/_astro",
  "/authors",
  "/og-image.png",
  "/pattern-graph-paper.svg",
];

const SESSION_COOKIE = "wos-session";

/** Whether an exact pathname belongs to the public marketing worker. */
export const isMarketingPath = (pathname: string): boolean =>
  MARKETING_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

/**
 * Project a production request onto the marketing service-binding request.
 * Returns `null` when the cloud application owns the request instead.
 */
export const marketingProxyRequest = (request: Request): Request | null => {
  const url = new URL(request.url);
  if (url.hostname !== "executor.sh") return null;

  const shouldProxy =
    isMarketingPath(url.pathname) ||
    (url.pathname === "/" && !parseCookie(request.headers.get("cookie"), SESSION_COOKIE));
  if (!shouldProxy) return null;

  if (url.pathname === "/home") url.pathname = "/";
  return new Request(url, request);
};
