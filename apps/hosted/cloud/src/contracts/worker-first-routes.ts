import dashboardRoutes from "@executor-js/hosted-cloud-web/routes" with { type: "json" };
import { sitePages } from "./site-paths.ts";

/**
 * Paths the Worker handles before the static assets. An allowlist, so everything
 * else is served from the assets. Site pages, the docs included, run through the
 * Worker so that only the edge serves them; it reads them from the assets binding,
 * which applies the site's `_headers` and `_redirects` as direct asset requests do.
 */
export const workerFirstRoutes = [
  "/",
  ...sitePages,
  // The Worker renders every dashboard document; see `cloudflare-routes.ts`. Its
  // `/org/*` rule also covers each organization's `/org/*/mcp` endpoint.
  ...dashboardRoutes,
  "/api",
  "/api/*",
  "/health",
  "/openapi.json",
  "/mcp",
  // The OAuth Client ID Metadata Document; see `client-metadata.ts`.
  "/oauth/client-metadata.json",
  "/git/*",
  "/.well-known/*",
];
