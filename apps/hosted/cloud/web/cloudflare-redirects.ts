import { inferFullPath } from "@tanstack/router-generator";
import type { GeneratorPlugin } from "@tanstack/router-generator";
import type { Plugin } from "vite-plus";

// Cloudflare and TanStack have different path grammars. Reject shapes we cannot
// translate faithfully rather than shipping a dashboard with broken deep links.
const rewritePath = (path: string): string => {
  const segments = path.replace(/\/$/, "").split("/").slice(1);
  const prefix = segments[0];
  if (
    !prefix ||
    prefix.startsWith("$") ||
    ["api", "assets", "health", "openapi.json"].includes(prefix)
  ) {
    throw new Error(
      `Dashboard route "${path}" needs a fixed page prefix outside API and asset paths.`,
    );
  }
  return (
    "/" +
    segments
      .map((segment, index) => {
        if (segment === "$" && index === segments.length - 1) return "*";
        if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) return `:param${index}`;
        if (/[\s$*{}:#?]/.test(segment)) {
          throw new Error(
            `Cannot translate dashboard route "${path}" to a Cloudflare rewrite: unsupported segment "${segment}".`,
          );
        }
        return segment;
      })
      .join("/")
  );
};

/** Pair TanStack's resolved route hook with a Vite asset emitter; no second route list. */
export const cloudflareRedirects = (): {
  readonly routes: GeneratorPlugin;
  readonly assets: Plugin;
} => {
  let patterns: ReadonlyArray<string> | undefined;

  return {
    routes: {
      name: "cloudflare-dashboard-routes",
      onRouteTreeChanged({ routeNodes }) {
        patterns = [
          ...new Set(
            routeNodes
              .map(inferFullPath)
              .flatMap((path) =>
                path === "/" ? [] : [path.startsWith("/org/") ? "/org/*" : rewritePath(path)],
              ),
          ),
        ];
      },
    },
    assets: {
      name: "cloudflare-dashboard-redirects",
      config: () => ({ appType: "mpa" }),
      configureServer(server) {
        // Run after asset/API middleware, before HTML transformation. Only page
        // paths from the same route tree used for deployment receive the SPA.
        return () =>
          server.middlewares.use((request, _response, next) => {
            if (patterns === undefined)
              return next(new Error("TanStack did not supply the dashboard route tree."));
            const segments = new URL(request.url ?? "/", "http://localhost").pathname
              .replace(/\/$/, "")
              .split("/");
            if (
              (request.method === "GET" || request.method === "HEAD") &&
              patterns.some((pattern) => {
                const parts = pattern.split("/");
                return (
                  (parts.at(-1) === "*"
                    ? segments.length >= parts.length - 1
                    : segments.length === parts.length) &&
                  parts.every(
                    (part, index) =>
                      part === "*" ||
                      (part.startsWith(":") ? Boolean(segments[index]) : part === segments[index]),
                  )
                );
              })
            )
              request.url = "/index.html";
            next();
          });
      },
      generateBundle() {
        if (patterns === undefined)
          return this.error("TanStack did not supply the dashboard route tree.");
        const rewrites = new Set<string>();
        for (const pattern of patterns) {
          // The Worker selects marketing or dashboard HTML at the root.
          // The dashboard entry is kept separate from the public index.html.
          // Organization pages share one SPA entry. A single namespace rewrite
          // keeps new dashboard pages within Cloudflare's 100 dynamic-rule limit.
          rewrites.add(`${pattern} /dashboard.html 200`);
          if (!pattern.endsWith("*")) rewrites.add(`${pattern}/ /dashboard.html 200`);
        }
        this.emitFile({
          type: "asset",
          fileName: "_redirects",
          source: [...rewrites].sort().join("\n") + "\n",
        });
        // The dashboard carries the MCP consent page, which grants credentials on
        // one click. No other site may frame any dashboard document. Marketing and
        // documentation paths are left alone because they share this asset root.
        const framed = [...rewrites]
          .map((rewrite) => rewrite.split(" ")[0])
          .filter((pattern): pattern is string => pattern !== undefined)
          .sort();
        this.emitFile({
          type: "asset",
          fileName: "_headers",
          source:
            framed
              .map(
                (pattern) =>
                  `${pattern}\n  Content-Security-Policy: frame-ancestors 'none'\n  X-Frame-Options: DENY`,
              )
              .join("\n\n") + "\n",
        });
      },
    },
  };
};
