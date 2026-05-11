import { env } from "cloudflare:workers";
import { createMiddleware, createStart } from "@tanstack/react-start";
import { Effect } from "effect";
import { handleApiRequest } from "./api";
import { mcpFetch } from "./mcp";
import { handleSentryTunnelRequest } from "./sentry-tunnel";

// ---------------------------------------------------------------------------
// Marketing routes — proxied to the marketing worker via service binding
// ---------------------------------------------------------------------------

const MARKETING_PATHS = ["/home", "/setup", "/privacy", "/terms", "/api/detect", "/_astro"];

const isMarketingPath = (pathname: string) =>
  MARKETING_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

const getMarketingWorker = () => env.MARKETING as { fetch: typeof fetch } | undefined;

const marketingMiddleware = createMiddleware({ type: "request" }).server(
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

const parseCookie = (cookieHeader: string | null, name: string): string | null => {
  if (!cookieHeader) return null;
  const match = cookieHeader
    .split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) || null : null;
};

// ---------------------------------------------------------------------------
// MCP middleware — routes /mcp and /.well-known/* to the MCP handler
// ---------------------------------------------------------------------------

const mcpRequestMiddleware = createMiddleware({ type: "request" }).server(
  async ({ pathname, request, next }) => {
    if (pathname === "/mcp" || pathname.startsWith("/.well-known/")) {
      const response = await mcpFetch(request);
      if (response) return response;
    }
    return next();
  },
);

// ---------------------------------------------------------------------------
// Sentry tunnel — the browser SDK POSTs envelopes to /api/sentry-tunnel
// (configured in routes/__root.tsx) to dodge adblockers and CSP. We parse
// the envelope header to recover the DSN, validate against our own, and
// forward the body to Sentry's ingest endpoint. See
// https://docs.sentry.io/platforms/javascript/troubleshooting/#using-the-tunnel-option
// ---------------------------------------------------------------------------

const sentryTunnelMiddleware = createMiddleware({ type: "request" }).server(
  ({ pathname, request, next }) => {
    if (pathname !== "/api/sentry-tunnel" || request.method !== "POST") {
      return next();
    }

    const configuredDsn = (env as { SENTRY_DSN?: string }).SENTRY_DSN;
    if (!configuredDsn) return new Response(null, { status: 204 });

    return Effect.runPromise(handleSentryTunnelRequest(request, configuredDsn));
  },
);

// ---------------------------------------------------------------------------
// PostHog reverse proxy — the browser SDK targets a build-randomized
// first-party path and we forward to PostHog's ingest + asset hosts. Keeps
// events flowing past adblockers that match *.posthog.com. See
// https://posthog.com/docs/advanced/proxy/cloudflare
// ---------------------------------------------------------------------------

const POSTHOG_INGEST_HOST = "us.i.posthog.com";
const POSTHOG_ASSETS_HOST = "us-assets.i.posthog.com";
const POSTHOG_PROXY_PATH = `/api/${(import.meta.env.VITE_PUBLIC_ANALYTICS_PATH ?? "a").replace(
  /^\/+|\/+$/g,
  "",
)}`;

const posthogProxyMiddleware = createMiddleware({ type: "request" }).server(
  ({ pathname, request, next }) => {
    if (pathname !== POSTHOG_PROXY_PATH && !pathname.startsWith(`${POSTHOG_PROXY_PATH}/`)) {
      return next();
    }

    const url = new URL(request.url);
    url.hostname = pathname.startsWith(`${POSTHOG_PROXY_PATH}/static/`)
      ? POSTHOG_ASSETS_HOST
      : POSTHOG_INGEST_HOST;
    url.protocol = "https:";
    url.port = "";
    url.pathname = pathname.slice(POSTHOG_PROXY_PATH.length) || "/";

    const upstream = new Request(url, request);
    upstream.headers.delete("cookie");
    return fetch(upstream);
  },
);

// ---------------------------------------------------------------------------
// API middleware — routes /api/* to the Effect HTTP layer
// ---------------------------------------------------------------------------

const apiRequestMiddleware = createMiddleware({ type: "request" }).server(
  ({ pathname, request, next }) => {
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      const url = new URL(request.url);
      url.pathname = url.pathname.replace(/^\/api/, "");
      return handleApiRequest(new Request(url, request));
    }
    return next();
  },
);

export const startInstance = createStart(() => ({
  requestMiddleware: [
    marketingMiddleware,
    mcpRequestMiddleware,
    sentryTunnelMiddleware,
    posthogProxyMiddleware,
    apiRequestMiddleware,
  ],
}));
