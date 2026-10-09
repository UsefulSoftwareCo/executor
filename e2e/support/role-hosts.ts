/** Cloud role hosts, observed only through HTTP. No product code is imported. */
import { Effect } from "effect";
import { driver, type Target } from "./platform.ts";

/**
 * The origin of a role host beside a Cloud deployment origin. Local Clouds and test stages put it
 * at `<role>.<deployment host>`: `http://mcp.localhost:4411`, `https://mcp.<slug>.executor.engineering`.
 * `edge` stands in for `executor.sh`, which v1's edge forwards to v2 from.
 */
export const roleHost = (origin: string, role: "app" | "mcp" | "api" | "edge") => {
  const url = new URL(origin);
  url.hostname = `${role}.${url.hostname}`;
  return url.origin;
};

/**
 * Where a target serves each part of the product. A run's `origin` is the deployment origin
 * (`v2.executor.sh`'s place). Every Cloud target has role hosts, so its dashboard and sign-in are
 * on `app.`, or on the deployment origin under the rollback switch (`e2e:cloud --rollback`); the
 * canonical MCP and API resources are on `mcp.` and `api.`. Other targets serve everything on one
 * origin.
 */
export const targetHosts = (target: typeof Target.Service) => {
  const origin = target.metadata.origin;
  if (target.metadata.target !== "cloud")
    return { deployment: origin, browser: origin, mcp: origin, api: origin, edge: origin };
  return {
    deployment: origin,
    browser: target.metadata.browserOrigin === "deployment" ? origin : roleHost(origin, "app"),
    mcp: roleHost(origin, "mcp"),
    api: roleHost(origin, "api"),
    edge: roleHost(origin, "edge"),
  };
};

/** MCP endpoints and their resource discovery, which Cloud never serves on its browser origin. */
export const isMcpPath = (pathname: string) =>
  pathname === "/mcp" ||
  /^\/org\/[^/]+\/mcp$/.test(pathname) ||
  pathname.startsWith("/.well-known/oauth-protected-resource");

/** One request without following redirects; only its status, chosen headers and body text. */
export const rawRequest = (url: string, init: RequestInit = {}) => {
  const operation = `${init.method ?? "GET"} ${new URL(url).host}${new URL(url).pathname}`;
  return driver(operation, (signal) => fetch(url, { ...init, redirect: "manual", signal })).pipe(
    Effect.flatMap((response) =>
      driver(`read ${operation}`, () => response.text()).pipe(
        Effect.map((text) => ({
          status: response.status,
          location: response.headers.get("location"),
          cacheControl: response.headers.get("cache-control"),
          contentType: response.headers.get("content-type"),
          challenge: response.headers.get("www-authenticate"),
          setCookies: response.headers.getSetCookie(),
          allowOrigin: response.headers.get("access-control-allow-origin"),
          allowMethods: response.headers.get("access-control-allow-methods"),
          text,
        })),
      ),
    ),
  );
};
