import { createMiddleware, createStart } from "@tanstack/react-start";
import { decodeOAuthCallbackState } from "@executor-js/sdk/shared";

import { cloudApiHandler } from "./app";
import { isAppOwnedPath } from "./app-paths";
import { authGateMiddleware } from "./auth/ssr-gate";
import { parseCookie } from "./auth/cookies";
import { ORG_SELECTOR_HEADER } from "./auth/organization";
import { loginPath } from "./auth/return-to";
import { prepareMcpOrgScope } from "./mcp/mount";
import {
  docsProxyMiddleware,
  marketingMiddleware,
  openAiAppsChallengeMiddleware,
  posthogProxyMiddleware,
  sentryTunnelMiddleware,
} from "./edge";

// ---------------------------------------------------------------------------
// The unified app web handler — `ExecutorApp.make`'s `toWebHandler` (app.ts).
// It serves EVERY app-owned path in one Effect HTTP layer: everything under
// `/api/*` (the protected plugin API + account + org, plus the cloud
// `extensions.routes` — Swagger at `/api/docs`, the Autumn billing proxy at
// `/api/billing/*`), AND the `/mcp` serving envelope + its `/.well-known/*`
// OAuth discovery docs — exactly like self-host's single `toWebHandler`.
// start.ts no longer hand-routes those surfaces; it only decides
// app-owned-vs-Start and forwards (after normalizing org-scoped MCP paths).
// ---------------------------------------------------------------------------

// Instantiate the unified app handler LAZILY, on the first server request that
// needs it. This is load-bearing for the CLIENT bundle: TanStack Start bundles
// `start.ts` into the browser build but strips `.server()` callback *bodies*, so
// any symbol referenced only inside a server callback is tree-shaken out of the
// client. A module-top-level `cloudApiHandler()` would instead survive that
// stripping and drag `./app` → `observability/telemetry` → `cloudflare:workers`
// (a workerd-only virtual module) into the browser build, breaking it. Keeping
// the call inside the server callback mirrors how every other server concern
// here stays server-only.
let app: ReturnType<typeof cloudApiHandler> | undefined;
const getApp = () => (app ??= cloudApiHandler());

const SESSION_COOKIE = "wos-session";
const OAUTH_CALLBACK_PATH = "/api/oauth/callback";

const oauthCallbackOrgScopedRequest = (request: Request): Request => {
  const url = new URL(request.url);
  const callbackState = decodeOAuthCallbackState(url.searchParams.get("state"));
  if (callbackState === null) return request;
  url.searchParams.set("state", callbackState.state);
  const rewritten = new Request(url, request);
  const headers = new Headers(rewritten.headers);
  headers.set(ORG_SELECTOR_HEADER, callbackState.orgSlug);
  return new Request(rewritten, { headers });
};

const oauthCallbackSignInMiddleware = createMiddleware({ type: "request" }).server(
  ({ pathname, request, next }) => {
    if (
      pathname !== OAUTH_CALLBACK_PATH ||
      (request.method !== "GET" && request.method !== "HEAD")
    ) {
      return next();
    }
    const sealed = parseCookie(request.headers.get("cookie"), SESSION_COOKIE);
    if (sealed) return next();

    const url = new URL(request.url);
    return new Response(null, {
      status: 302,
      headers: { location: loginPath(`${url.pathname}${url.search}`) },
    });
  },
);

// app-owned = anything under `/api/*` (incl. the cloud extension routes) OR an
// MCP/OAuth-discovery path (see `./app-paths`). The app handler serves these at
// their real paths, so we forward unmodified — except `prepareMcpOrgScope`
// rewrites an org-scoped MCP path (`/org_xxx/mcp`) to the bare path the shared
// envelope routes, pinning the org in an internal header (a no-op for everything
// else, including `/api/*`).
const appRequestMiddleware = createMiddleware({ type: "request" }).server(
  ({ pathname, request, next }) => {
    if (isAppOwnedPath(pathname)) {
      const scopedRequest =
        pathname === OAUTH_CALLBACK_PATH ? oauthCallbackOrgScopedRequest(request) : request;
      return getApp().handler(prepareMcpOrgScope(scopedRequest));
    }
    return next();
  },
);

// The edge concerns (marketing proxy, docs proxy, sentry tunnel, posthog proxy)
// live in `./edge`; they run before the app's own dispatch. Ordering is
// load-bearing: marketing first (production landing/page proxy), then the docs
// proxy and analytics tunnels, then the unified app plane (api + mcp), and last
// the SSR auth gate — it only sees document requests nothing above claimed, so
// signed-out visitors are redirected to /login before the SPA (and its
// app-shell skeleton) is served. The docs proxy sits among the edges (not after
// the auth gate) because `/docs` is public and must skip the sign-in redirect;
// its path is disjoint from every other matcher, so its slot is not otherwise
// load-bearing.
export const startInstance = createStart(() => ({
  requestMiddleware: [
    openAiAppsChallengeMiddleware,
    marketingMiddleware,
    docsProxyMiddleware,
    sentryTunnelMiddleware,
    posthogProxyMiddleware,
    oauthCallbackSignInMiddleware,
    appRequestMiddleware,
    authGateMiddleware,
  ],
}));
