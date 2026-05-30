// ---------------------------------------------------------------------------
// Marketing routes — proxied to the marketing worker via service binding.
//
// On the production domain (`executor.sh`), marketing paths and the
// unauthenticated landing page are served by the separate `executor-marketing`
// worker (bound as `env.MARKETING`). In local dev that worker isn't running, so
// unauthenticated visits fall through to the cloud app's routes (the sign-in
// page).
// ---------------------------------------------------------------------------

import { env } from "cloudflare:workers";
import { createMiddleware } from "@tanstack/react-start";

const MARKETING_PATHS = [
  "/home",
  "/setup",
  "/privacy",
  "/terms",
  "/api/detect",
  "/_astro",
  "/og-image.png",
  "/pattern-graph-paper.svg",
];

const isMarketingPath = (pathname: string) =>
  MARKETING_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

const getMarketingWorker = () => env.MARKETING as { fetch: typeof fetch } | undefined;

const parseCookie = (cookieHeader: string | null, name: string): string | null => {
  if (!cookieHeader) return null;
  const match = cookieHeader
    .split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) || null : null;
};

export const marketingMiddleware = createMiddleware({ type: "request" }).server(
  async ({ pathname, request, next }) => {
    // Only proxy to the marketing worker on the production domain. In local
    // dev we don't run `executor-marketing`, so unauthenticated visits fall
    // through to the cloud app's routes (which show the sign-in page).
    const host = new URL(request.url).hostname;
    if (host !== "executor.sh") return next();

    const shouldProxyToMarketing =
      isMarketingPath(pathname) ||
      (pathname === "/" && !parseCookie(request.headers.get("cookie"), "wos-session"));

    if (!shouldProxyToMarketing) return next();

    const marketing = getMarketingWorker();
    if (!marketing) return next();

    const url = new URL(request.url);
    // Rewrite /home to / so marketing worker serves its homepage
    if (pathname === "/home") {
      url.pathname = "/";
    }
    return marketing.fetch(new Request(url, request));
  },
);
