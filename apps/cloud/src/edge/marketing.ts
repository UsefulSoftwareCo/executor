// ---------------------------------------------------------------------------
// The `executor.sh` edge — decides which Worker answers a public request.
//
// On the production domain (`executor.sh`):
//  - v2's marketing site answers the landing page without a v1 session, its
//    pages, assets and docs, and its browser telemetry proxies;
//  - sign-up goes to v2 (a redirect to v2's sign-up page);
//  - a fixed list of v2 paths (sign-in issuer metadata, social sign-in
//    callbacks, Git smart HTTP and the agent skills index) is forwarded to
//    v2's Worker over a service binding;
//  - so is a connected-account OAuth callback whose `state` carries v2's
//    prefix;
//  - v1's terms of service, privacy policy and Google OAuth disclosure (and
//    their assets) stay on the `executor-marketing` worker.
// v1 owns everything not listed. This module deliberately has no TanStack
// Start or cloud application imports: the Worker entry calls it before
// loading the Start server graph.
// ---------------------------------------------------------------------------

import { parseCookie } from "../auth/cookies";

const PRODUCTION_HOST = "executor.sh";

/** v1's session cookie. `/` with it is v1's dashboard; without it, marketing. */
const SESSION_COOKIE = "wos-session";

// ---------------------------------------------------------------------------
// v1's legal pages on the `executor-marketing` worker
// ---------------------------------------------------------------------------

/** v1's legal pages stay on v1's marketing worker. v2's terms describe only
 *  v2's billing, and v1's cover the plans v1 customers are on; v1's privacy
 *  policy and Google OAuth disclosure describe v1's own data handling and
 *  Google OAuth app. The worker builds its assets under `/_v1-marketing`,
 *  apart from v2's `/_astro`. Each path matches itself and everything below
 *  it. */
const V1_MARKETING_PATHS: ReadonlyArray<string> = [
  "/terms",
  "/privacy",
  "/google-oauth",
  "/_v1-marketing",
];

/** Whether a pathname belongs to v1's marketing worker on `executor.sh`. */
export const isMarketingPath = (pathname: string): boolean =>
  V1_MARKETING_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));

/**
 * Project a production request for v1's legal pages (or their assets) onto the
 * `executor-marketing` service-binding request. Returns `null` for every
 * other request.
 */
export const marketingProxyRequest = (request: Request): Request | null => {
  const url = new URL(request.url);
  if (url.hostname !== PRODUCTION_HOST || !isMarketingPath(url.pathname)) return null;
  return new Request(url, request);
};

// ---------------------------------------------------------------------------
// v2 on `executor.sh`
// ---------------------------------------------------------------------------

const SIGN_UP_PATHS: ReadonlySet<string> = new Set(["/sign-up", "/signup"]);

/** A path pattern is an exact path, or `/x/*`, which matches every path
 *  that starts with `/x/` (and not `/x` itself). */
const matchesPathPattern = (pathname: string, pattern: string): boolean =>
  pattern.endsWith("/*") ? pathname.startsWith(pattern.slice(0, -1)) : pathname === pattern;

/** Path patterns v2 answers on `executor.sh`. `/git/*` never matches
 *  `/gitlab/...`. v1's own client metadata document
 *  (`/oauth/client-id-metadata.json`) stays with v1. */
const V2_PATHS: ReadonlyArray<string> = [
  // Sign-in issuer metadata for the issuer `https://executor.sh/api/auth`.
  "/.well-known/oauth-authorization-server/api/auth",
  // v2's outbound OAuth client metadata document: its connected-account
  // sign-ins name it as their client ID, beside their callback on this origin.
  "/oauth/client-metadata.json",
  "/git/*",
  "/.well-known/agent-skills/*",
];

/** v2's social sign-in callback is `/api/auth/callback/<provider>`. v1's
 *  WorkOS callback is the bare `/api/auth/callback`, which stays with v1. */
const SOCIAL_CALLBACK_PREFIX = "/api/auth/callback/";

const isSocialCallbackPath = (pathname: string): boolean => {
  if (!pathname.startsWith(SOCIAL_CALLBACK_PREFIX)) return false;
  const provider = pathname.slice(SOCIAL_CALLBACK_PREFIX.length);
  return provider.length > 0 && !provider.includes("/");
};

/** Whether a pathname is a sign-up entry point that redirects to v2. */
export const isSignUpPath = (pathname: string): boolean => SIGN_UP_PATHS.has(pathname);

/** Whether `executor.sh` forwards a pathname to v2's Worker. */
export const isV2Path = (pathname: string): boolean =>
  V2_PATHS.some((pattern) => matchesPathPattern(pathname, pattern)) ||
  isSocialCallbackPath(pathname);

/** v2's marketing site on `executor.sh`, as path patterns (see
 *  {@link matchesPathPattern}): the pages, files and assets v2's marketing
 *  build publishes, and its docs. `/pricing` and `/home` match only
 *  themselves. `apps` and `experiments` are reserved org slugs, so `/apps`,
 *  `/apps/*` and `/experiments/*` are v2's; v2 publishes nothing at a bare
 *  `/experiments`, which stays with v1. `/demo` is a valid, unreserved v1
 *  organization slug, so it and everything below it stay with v1. The
 *  favicons stay with v1 too: v1's dashboard serves identical files. v1 has
 *  no `/favicon.png`, which v2's OAuth client metadata document names as its
 *  logo, so that one is v2's. */
const V2_MARKETING_PATHS: ReadonlyArray<string> = [
  "/home",
  "/pricing",
  "/pricing.md",
  "/index.md",
  "/setup-prompt.md",
  "/llms.txt",
  "/about-executor",
  "/google-workspace",
  "/blog",
  "/blog/*",
  "/docs",
  "/docs/*",
  "/apps",
  "/apps/*",
  "/experiments/*",
  "/_astro/*",
  "/authors/*",
  "/og-image.png",
  "/pattern-graph-paper.svg",
  "/favicon.png",
];

/** Whether a pathname belongs to v2's marketing site on `executor.sh`. `/`
 *  also does, without a v1 session; see {@link isV2Homepage}. */
export const isV2MarketingPath = (pathname: string): boolean =>
  V2_MARKETING_PATHS.some((pattern) => matchesPathPattern(pathname, pattern));

/** v2's pages that match only themselves (`/pricing`, `/home`,
 *  `/about-executor`, `/google-workspace`): exact patterns that are not
 *  files and have no `/x/*` beside them. Their slashed form (`/pricing/`)
 *  matches no pattern, so v1's sign-in gate would answer it. */
const V2_EXACT_PAGES: ReadonlySet<string> = new Set(
  V2_MARKETING_PATHS.filter(
    (pattern) =>
      !pattern.endsWith("/*") &&
      !pattern.includes(".") &&
      !V2_MARKETING_PATHS.includes(`${pattern}/*`),
  ),
);

/** The page a slashed v2 page (`/pricing/`) canonicalizes to (`/pricing`),
 *  or `null`. Deeper paths (`/pricing/extra`) stay with v1. */
export const v2PageForSlashedPath = (pathname: string): string | null => {
  if (!pathname.endsWith("/")) return null;
  const page = pathname.slice(0, -1);
  return V2_EXACT_PAGES.has(page) ? page : null;
};

/** v2's dashboard pages are `/org/<slug>/...` on v2's app host. `org` is a
 *  reserved v1 slug and v1's own `/org` page has nothing below it, so
 *  `executor.sh/org/*` is always a v2 dashboard link with the wrong host. */
const V2_DASHBOARD_PREFIX = "/org/";

/** The landing page without a v1 session is v2's marketing homepage. */
const isV2Homepage = (url: URL, request: Request): boolean =>
  url.pathname === "/" && parseCookie(request.headers.get("cookie"), SESSION_COOKIE) === null;

/** The one cookie v2's marketing reads: the anonymous visitor ID that keeps
 *  a visitor's homepage experiment assignment stable. v2 sets it on
 *  `executor.sh` itself. Every other cookie, v1's session included, stays
 *  with v1. */
const V2_MARKETING_COOKIES: ReadonlyArray<string> = ["executor_visitor"];

/** v2's browser telemetry lives under `/api/<16 lowercase hex>`, which v1's
 *  API never uses. Two settings say which paths are v2's. Both are outputs
 *  of v2's production infrastructure (stage `v2`; random, retained values),
 *  which v2 pins in its edge contract; v2 refuses to deploy stage `v2` if
 *  its outputs differ:
 *  - `V2_ANALYTICS_PROXY_PATH`, the PostHog browser proxy root (output
 *    `proxyPath` of v2's `executor-next-posthog` stack), forwarded below
 *    it (`<root>/*`), not the root itself, which v2 does not serve;
 *  - `V2_ERROR_TUNNEL_PATH`, the Sentry browser error tunnel (output
 *    `browserTunnel` of v2's `executor-next-sentry` stack), forwarded
 *    exactly. */
const ANALYTICS_PROXY_PATH_PATTERN = /^\/api\/[a-f0-9]{16}$/;
const ERROR_TUNNEL_PATH_PATTERN = /^\/api\/[a-f0-9]{16}\/submit$/;
const TELEMETRY_PATH_SHAPE = /^\/api\/[a-f0-9]{16}(?:\/|$)/;

/** Request headers v1 never passes to v2 as sent. The cookie header carries
 *  v1's `wos-session`; v2's own cookies are host-only on its own hosts,
 *  except marketing's visitor cookie, which is passed on by name. Client-sent
 *  forwarding headers are dropped so v2 sees no host claim other than the
 *  request URL's. */
const V2_STRIPPED_HEADERS = ["cookie", "x-forwarded-host", "x-forwarded-proto"] as const;

/**
 * Project an `executor.sh` request onto the request sent to v2's Worker.
 *
 * Keeps the URL (so v2 sees host `executor.sh`, path and query unchanged),
 * method, body stream and every header except {@link V2_STRIPPED_HEADERS},
 * including `Authorization`. The cookie header is rebuilt from `keptCookies`
 * only, and dropped when none of them is present. Redirects are returned to
 * the client, not followed: v2 answers callbacks with a redirect to its own
 * host.
 */
export const v2ForwardRequest = (
  request: Request,
  keptCookies: ReadonlyArray<string> = [],
): Request => {
  const cookieHeader = request.headers.get("cookie");
  const cookies = keptCookies.flatMap((name) => {
    const value = parseCookie(cookieHeader, name);
    return value === null ? [] : [`${name}=${value}`];
  });
  const headers = new Headers(request.headers);
  for (const name of V2_STRIPPED_HEADERS) headers.delete(name);
  if (cookies.length > 0) headers.set("cookie", cookies.join("; "));
  return new Request(request, { headers, redirect: "manual" });
};

/** The Worker that serves v2, reached over a service binding. */
export interface V2Service {
  readonly fetch: (request: Request) => Promise<Response>;
}

/** v1's connected-account OAuth callback. v2 shares it on `executor.sh`:
 *  a callback whose `state` starts with v2's prefix belongs to v2. */
const OAUTH_CALLBACK_PATH = "/api/oauth/callback";

/** A state prefix is URL-safe as is (so the query value carries it
 *  unencoded) and includes a character outside base64url. v1's states are
 *  base64url, so no v1 state can start with such a prefix. */
const OAUTH_STATE_PREFIX_PATTERN = /^[A-Za-z0-9._~-]*[.~][A-Za-z0-9._~-]*$/;

/** The edge's raw v2 settings, as the Worker environment holds them. */
export interface V2EdgeEnv {
  /** Service binding to v2's Worker. */
  readonly V2?: V2Service;
  /** Absolute URL of v2's sign-up page. */
  readonly V2_SIGN_UP_URL?: string;
  /** The prefix v2 puts on every connected-account OAuth `state`. */
  readonly V2_OAUTH_STATE_PREFIX?: string;
  /** Root of v2's PostHog browser proxy, `/api/<16 hex>`. */
  readonly V2_ANALYTICS_PROXY_PATH?: string;
  /** v2's Sentry browser error tunnel, `/api/<16 hex>/submit`. */
  readonly V2_ERROR_TUNNEL_PATH?: string;
}

/** What the edge needs to hand requests to v2. */
export interface V2Edge {
  /** v2's Worker. */
  readonly service: V2Service;
  /** Absolute URL of v2's sign-up page (the `V2_SIGN_UP_URL` var). */
  readonly signUpUrl: URL;
  /** v2's connected-account OAuth state prefix (the `V2_OAUTH_STATE_PREFIX` var). */
  readonly oauthStatePrefix: string;
  /** Root of v2's PostHog browser proxy (the `V2_ANALYTICS_PROXY_PATH` var). */
  readonly analyticsProxyPath: string;
  /** v2's Sentry browser error tunnel (the `V2_ERROR_TUNNEL_PATH` var). */
  readonly errorTunnelPath: string;
}

/**
 * Parse the edge's v2 settings from the Worker environment. Returns `null`
 * when none is set (local dev, test workers), so v1 serves everything, and
 * the reason as a string when the deployment is broken: only some of them
 * set, a sign-up URL that is not absolute, a state prefix that could match a
 * v1 state, or a telemetry path of the wrong shape.
 */
export const parseV2Edge = (env: V2EdgeEnv): V2Edge | string | null => {
  const service = env.V2;
  const signUpUrl = env.V2_SIGN_UP_URL;
  const oauthStatePrefix = env.V2_OAUTH_STATE_PREFIX;
  const analyticsProxyPath = env.V2_ANALYTICS_PROXY_PATH;
  const errorTunnelPath = env.V2_ERROR_TUNNEL_PATH;
  if (
    service === undefined &&
    signUpUrl === undefined &&
    oauthStatePrefix === undefined &&
    analyticsProxyPath === undefined &&
    errorTunnelPath === undefined
  ) {
    return null;
  }
  if (
    service === undefined ||
    signUpUrl === undefined ||
    oauthStatePrefix === undefined ||
    analyticsProxyPath === undefined ||
    errorTunnelPath === undefined
  ) {
    return "The V2 binding, V2_SIGN_UP_URL, V2_OAUTH_STATE_PREFIX, V2_ANALYTICS_PROXY_PATH and V2_ERROR_TUNNEL_PATH must be set together";
  }
  const parsed = URL.parse(signUpUrl);
  if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    return "V2_SIGN_UP_URL must be an absolute http(s) URL";
  }
  if (!OAUTH_STATE_PREFIX_PATTERN.test(oauthStatePrefix)) {
    return "V2_OAUTH_STATE_PREFIX must be URL-safe and contain '.' or '~'";
  }
  if (!ANALYTICS_PROXY_PATH_PATTERN.test(analyticsProxyPath)) {
    return "V2_ANALYTICS_PROXY_PATH must be /api/<16 lowercase hex>";
  }
  if (!ERROR_TUNNEL_PATH_PATTERN.test(errorTunnelPath)) {
    return "V2_ERROR_TUNNEL_PATH must be /api/<16 lowercase hex>/submit";
  }
  return { service, signUpUrl: parsed, oauthStatePrefix, analyticsProxyPath, errorTunnelPath };
};

/**
 * v2's app host, or `null` where v1 does not hand requests to v2 (local dev
 * without the v2 settings, test workers, or broken settings). It is the origin
 * of v2's sign-up page, the same host the edge sends v2 dashboard links to.
 */
export const v2AppOrigin = (env: V2EdgeEnv): URL | null => {
  const signUpUrl = v2SignUpUrl(env);
  return signUpUrl === null ? null : new URL(signUpUrl.origin);
};

/**
 * v2's sign-up page (the `V2_SIGN_UP_URL` var), where new organizations are
 * created, or `null` where v1 does not hand requests to v2 (see
 * {@link v2AppOrigin}).
 */
export const v2SignUpUrl = (env: V2EdgeEnv): URL | null => {
  const edge = parseV2Edge(env);
  if (edge === null || typeof edge === "string") return null;
  return new URL(edge.signUpUrl);
};

/** Whether a connected-account callback carries v2's state prefix. Reads the
 *  query only: a callback without `state` in its query stays with v1. */
const isV2OAuthCallback = (url: URL, prefix: string): boolean =>
  url.searchParams.get("state")?.startsWith(prefix) === true;

/** Whether a pathname is below v2's analytics proxy root, or exactly v2's
 *  error tunnel. */
const isV2TelemetryPath = (pathname: string, edge: V2Edge): boolean =>
  matchesPathPattern(pathname, `${edge.analyticsProxyPath}/*`) || pathname === edge.errorTunnelPath;

/**
 * Answer a production request that belongs to v2 and return `null` when v1
 * owns it:
 *  - sign-up (`GET`, any query) redirects to v2's sign-up page;
 *  - a `GET` or `HEAD` for a slashed v2 page (`/pricing/`) redirects (308)
 *    to the page, query kept, as v2's site does on its own hosts;
 *  - a `GET` or `HEAD` for a v2 dashboard page (`/org/<slug>/...`) redirects
 *    (308) to the same path and query on v2's app host, the sign-up URL's
 *    origin;
 *  - a {@link isV2Path} request, a connected-account callback whose `state`
 *    starts with v2's prefix, or a request for v2's analytics proxy or error
 *    tunnel is forwarded to v2's Worker without cookies;
 *  - a {@link isV2MarketingPath} request, or `/` without a v1 session, is
 *    forwarded with only v2's marketing visitor cookie.
 * v2's response comes back unchanged (status, headers and body stream).
 *
 * Broken settings answer the requests the edge always owns with a 500 and
 * leave the rest of v1 serving. Which callbacks and `/api/<16 hex>` requests
 * are v2's depends on the settings, so v1 keeps those until they parse.
 */
export const v2EdgeResponse = (request: Request, env: V2EdgeEnv): Promise<Response> | null => {
  const url = new URL(request.url);
  if (url.hostname !== PRODUCTION_HOST) return null;

  const signUp = isSignUpPath(url.pathname) && request.method === "GET";
  const slashedPage =
    request.method === "GET" || request.method === "HEAD"
      ? v2PageForSlashedPath(url.pathname)
      : null;
  const dashboard =
    (request.method === "GET" || request.method === "HEAD") &&
    url.pathname.startsWith(V2_DASHBOARD_PREFIX);
  const marketing = isV2MarketingPath(url.pathname) || isV2Homepage(url, request);
  const owned = signUp || slashedPage !== null || dashboard || marketing || isV2Path(url.pathname);
  const callback = url.pathname === OAUTH_CALLBACK_PATH;
  const telemetry = TELEMETRY_PATH_SHAPE.test(url.pathname);
  if (!owned && !callback && !telemetry) return null;
  const edge = parseV2Edge(env);
  if (edge === null) return null;
  if (typeof edge === "string") {
    if (!owned) return null;
    console.error(`executor.sh v2 edge misconfigured: ${edge}`);
    return Promise.resolve(new Response("Service misconfigured", { status: 500 }));
  }
  if (signUp) return Promise.resolve(Response.redirect(edge.signUpUrl.href, 302));
  if (slashedPage !== null) {
    const page = new URL(url);
    page.pathname = slashedPage;
    return Promise.resolve(Response.redirect(page.href, 308));
  }
  if (dashboard) {
    const page = new URL(url.pathname + url.search, edge.signUpUrl.origin);
    return Promise.resolve(Response.redirect(page.href, 308));
  }
  if (marketing) return edge.service.fetch(v2ForwardRequest(request, V2_MARKETING_COOKIES));
  if (callback && !isV2OAuthCallback(url, edge.oauthStatePrefix)) return null;
  if (telemetry && !isV2TelemetryPath(url.pathname, edge)) return null;
  return edge.service.fetch(v2ForwardRequest(request));
};
