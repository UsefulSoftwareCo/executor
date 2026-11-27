import dashboardRoutes from "@executor-js/hosted-cloud-web/routes" with { type: "json" };
import { sitePages } from "./site-paths.ts";

export const workerFirstRoutes = [
  "/",
  ...sitePages,
  ...dashboardRoutes,
  "/api",
  "/api/*",
  "/health",
  "/openapi.json",
  "/mcp",
  "/oauth/client-metadata.json",
  "/git/*",
  "/.well-known/*",
];
