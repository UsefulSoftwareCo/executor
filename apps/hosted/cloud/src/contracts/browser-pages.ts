import dashboardRoutes from "@executor-js/hosted-cloud-web/routes" with { type: "json" };

const pages = dashboardRoutes.map((route) =>
  route.endsWith("/*")
    ? { prefix: route.slice(0, -1) }
    : { exact: route.endsWith("/") && route !== "/" ? route.slice(0, -1) : route },
);

const browserAuthPath = /^\/api\/auth\/(?:oauth2\/authorize|callback\/[^/]+)$/;

export const isMcpPath = (pathname: string) =>
  pathname === "/mcp" ||
  /^\/org\/[^/]+\/mcp$/.test(pathname) ||
  pathname.startsWith("/.well-known/oauth-protected-resource");

export const isBrowserPage = (pathname: string) => {
  if (pathname === "/" || browserAuthPath.test(pathname)) return true;
  if (isMcpPath(pathname)) return false;
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return pages.some((page) =>
    "prefix" in page ? path.startsWith(page.prefix) : path === page.exact,
  );
};
