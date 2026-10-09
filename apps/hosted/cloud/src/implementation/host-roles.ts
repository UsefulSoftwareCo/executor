/**
 * Which part of the product a request reaches, by the host of its URL
 * (`notes/cloud-domains.md`). The URL is the one the Worker received: a request v1's edge
 * forwards through its service binding keeps its original `https://executor.sh/...` URL.
 * Forwarding headers such as `X-Forwarded-Host` are never read; anyone can send them.
 *
 * - `app.` (the browser origin) serves the dashboard, sign-in and the dashboard API. MCP and its
 *   resource discovery are not there: `mcp.` serves them.
 * - `mcp.` and `api.` answer only from their own routers, so any other path there is the
 *   router's 404, as for an unknown path anywhere.
 * - The edge (`executor.sh`) answers only the requests v1 forwards (`servedOnEdge`), from its
 *   own router.
 * - The deployment origin (`v2.executor.sh`) and any other host keep the full product, except
 *   browser pages, which redirect permanently to the same path on the browser origin, and site
 *   pages, which redirect permanently to the edge. Its homepage goes to the dashboard for a
 *   browser that still holds a session cookie and to the site otherwise.
 * - Site pages on the browser origin also go to the edge; its homepage sends a signed-out
 *   visitor to sign-in.
 * - Under the rollback switch (`CLOUD_BROWSER_ORIGIN=deployment`) the browser origin is the
 *   deployment origin, which then serves its pages itself and sends only a signed-out homepage
 *   and site pages to the edge; `app.` redirects its pages there temporarily and keeps serving
 *   everything else, such as the token endpoint clients hold. Every redirect is `no-store`, so
 *   no browser keeps either direction when the switch flips.
 */
import { Effect, Option } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { CloudHosts, HostRole } from "../infrastructure/stage.ts";
import { isBrowserPage, isMcpPath } from "../contracts/browser-pages.ts";
import { servedOnEdge } from "../contracts/edge-paths.ts";
import { isSitePage } from "../contracts/site-paths.ts";

/** The host of the URL a request arrived at; never a forwarding header. */
const requestHost = (request: HttpServerRequest.HttpServerRequest) =>
  URL.parse(request.originalUrl)?.host;

type Route = HostRole | "edge" | "deployment";

/** The part of the product a request's host names. */
const routeOf = (hosts: CloudHosts, host: string | undefined): Route =>
  Option.match(hosts.roles, {
    onNone: () => "deployment" as const,
    onSome: (roles): Route => {
      if (host === new URL(roles.origins.app).host) return "app";
      if (host === new URL(roles.origins.mcp).host) return "mcp";
      if (host === new URL(roles.origins.api).host) return "api";
      if (host === new URL(roles.edge).host) return "edge";
      return "deployment";
    },
  });

/** The same path and query on `origin`. */
const sameRequestAt = (request: HttpServerRequest.HttpServerRequest, origin: string) => {
  const url = new URL(request.originalUrl);
  return new URL(`${url.pathname}${url.search}`, origin).href;
};

/**
 * A redirect to the same path and query on `origin`: 308 for a permanent move, 307 for a page the
 * rollback switch moves, 302 for a provider callback whose code is single-use.
 */
export const redirectTo = (origin: string, status: 302 | 307 | 308) =>
  Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
    HttpServerResponse.redirect(sameRequestAt(request, origin), {
      status,
      headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
    }),
  );

const notFound = HttpServerResponse.empty({ status: 404 });

/**
 * Name the request's host and the role it reaches on the request's server span, so traffic can be
 * split by host. The host is this Worker's own: Cloudflare routes it only Executor's domains. The
 * role is one of a closed set, and the query string never leaves the URL.
 */
const annotateHost = (request: HttpServerRequest.HttpServerRequest, role: Route) => {
  const hostname = URL.parse(request.originalUrl)?.hostname;
  return Effect.annotateCurrentSpan({
    ...(hostname === undefined ? {} : { "server.address": hostname }),
    "executor.host_role": role,
  });
};

/**
 * Serve each role host from its own handler and every other host from `main`. Without role
 * hosts, `main` serves every request. Either way the request's span names its host and role.
 */
export const withRoleHosts =
  <E1, R1, E2, R2, E3, R3>(
    hosts: CloudHosts,
    /** Whether the request carries a session cookie: a routing hint, never authority. */
    hasSession: (headers: HttpServerRequest.HttpServerRequest["headers"]) => boolean,
    handlers: {
      readonly mcp: Effect.Effect<HttpServerResponse.HttpServerResponse, E1, R1>;
      readonly api: Effect.Effect<HttpServerResponse.HttpServerResponse, E2, R2>;
      readonly edge: Effect.Effect<HttpServerResponse.HttpServerResponse, E3, R3>;
    },
  ) =>
  <E, R>(main: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Option.match(hosts.roles, {
      onNone: () =>
        Effect.gen(function* () {
          yield* annotateHost(yield* HttpServerRequest.HttpServerRequest, "deployment");
          return yield* main;
        }),
      onSome: ({ edge }) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const route = routeOf(hosts, requestHost(request));
          yield* annotateHost(request, route);
          const url = new URL(request.originalUrl);
          const { pathname } = url;
          const page = request.method === "GET" || request.method === "HEAD";
          // Under the rollback switch the deployment origin is the browser origin again.
          const rolledBack = hosts.browser === hosts.deployment;
          switch (route) {
            case "app":
              if (isMcpPath(pathname)) return notFound;
              if (page && isSitePage(pathname)) return yield* redirectTo(edge, 308);
              if (page && rolledBack && isBrowserPage(pathname))
                return yield* redirectTo(hosts.browser, 307);
              if (page && pathname === "/" && !hasSession(request.headers))
                return HttpServerResponse.redirect(new URL("/login", hosts.browser).href, {
                  status: 307,
                  headers: { "cache-control": "no-store" },
                });
              return yield* main;
            case "mcp":
              return yield* handlers.mcp;
            case "api":
              return yield* handlers.api;
            case "edge":
              return servedOnEdge(url) ? yield* handlers.edge : notFound;
            case "deployment":
              if (page && isSitePage(pathname)) return yield* redirectTo(edge, 308);
              if (page && pathname === "/" && !hasSession(request.headers))
                return yield* redirectTo(edge, 308);
              return page && !rolledBack && isBrowserPage(pathname)
                ? yield* redirectTo(hosts.browser, 308)
                : yield* main;
          }
        }),
    });
