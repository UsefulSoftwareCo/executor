/** Paths that are browser navigations, and paths that belong to MCP, for host routing. */
import dashboardRoutes from "@executor-js/hosted-cloud-web/routes" with { type: "json" };

/** Dashboard page patterns: exact paths, and prefixes for routes ending in `/*`. */
const pages = dashboardRoutes.map((route) =>
  route.endsWith("/*")
    ? { prefix: route.slice(0, -1) }
    : { exact: route.endsWith("/") && route !== "/" ? route.slice(0, -1) : route },
);

/**
 * Better Auth endpoints a browser navigates to rather than calls: the start of an MCP or API
 * authorization, and the return from a social provider. Both need the sign-in cookies, which
 * are host-only on the browser origin.
 */
const browserAuthPath = /^\/api\/auth\/(?:oauth2\/authorize|callback\/[^/]+)$/;

/** MCP endpoints and resource discovery, which only resource origins serve. */
export const isMcpPath = (pathname: string) =>
  pathname === "/mcp" ||
  /^\/org\/[^/]+\/mcp$/.test(pathname) ||
  pathname.startsWith("/.well-known/oauth-protected-resource");

/**
 * Whether a GET to `pathname` is a page a person opens in the browser: the homepage, a
 * dashboard page or a browser navigation through Better Auth. An organization's MCP endpoint
 * shares the `/org/*` prefix and is not a page.
 */
export const isBrowserPage = (pathname: string) => {
  if (pathname === "/" || browserAuthPath.test(pathname)) return true;
  if (isMcpPath(pathname)) return false;
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return pages.some((page) =>
    "prefix" in page ? path.startsWith(page.prefix) : path === page.exact,
  );
};
