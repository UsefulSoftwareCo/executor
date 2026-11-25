import { Effect } from "effect";
import { driver, type Target } from "./platform.ts";

/**
 * The origin of a role host beside a Cloud deployment origin. Local Clouds and test stages put it
 * at `<role>.<deployment host>`: `http://mcp.localhost:4411`, `https://mcp.<slug>.executor.engineering`.
 * `edge` stands in for `executor.sh`, which v1's edge forwards to v2 from, and `signin` for
 * `signin.executor.sh`, v1's AuthKit host.
 */
export const roleHost = (origin: string, role: "app" | "mcp" | "api" | "edge" | "signin") => {
  const url = new URL(origin);
  url.hostname = `${role}.${url.hostname}`;
  return url.origin;
};

export const targetHosts = (target: typeof Target.Service) => {
  const origin = target.metadata.origin;
  if (target.metadata.target !== "cloud")
    return {
      deployment: origin,
      browser: origin,
      mcp: origin,
      api: origin,
      edge: origin,
      authKit: origin,
    };
  return {
    deployment: origin,
    browser: target.metadata.browserOrigin === "deployment" ? origin : roleHost(origin, "app"),
    mcp: roleHost(origin, "mcp"),
    api: roleHost(origin, "api"),
    edge: roleHost(origin, "edge"),
    authKit: roleHost(origin, "signin"),
  };
};

export const isMcpPath = (pathname: string) =>
  pathname === "/mcp" ||
  /^\/org\/[^/]+\/mcp$/.test(pathname) ||
  pathname.startsWith("/.well-known/oauth-protected-resource");

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
