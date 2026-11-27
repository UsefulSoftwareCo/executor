import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite-plus";

export const dashboardRoutesFile = fileURLToPath(
  new URL("./src/implementation/worker-routes.gen.json", import.meta.url),
);

const workerPattern = (path: string): string => {
  const segments = path.replace(/\/$/, "").split("/").slice(1);
  const prefix = segments[0];
  if (
    !prefix ||
    prefix.startsWith("$") ||
    ["api", "assets", "docs", "health", "openapi.json"].includes(prefix)
  ) {
    throw new Error(
      `Dashboard route "${path}" needs a fixed page prefix outside API, docs and asset paths.`,
    );
  }
  const dynamic = segments.findIndex((segment) => segment.startsWith("$"));
  for (const segment of segments)
    if (!segment.startsWith("$") && /[\s*{}:#?!]/.test(segment))
      throw new Error(
        `Cannot translate dashboard route "${path}" to a Worker route: unsupported segment "${segment}".`,
      );
  return dynamic === -1 ? `/${segments.join("/")}` : `/${segments.slice(0, dynamic).join("/")}/*`;
};

declare global {
  var TSS_ROUTES_MANIFEST: Record<string, unknown> | undefined;
}

const fullPath = (routePath: string) =>
  "/" +
  routePath
    .split("/")
    .filter((segment) => segment !== "" && !segment.startsWith("_"))
    .map((segment) => segment.replace(/_$/, ""))
    .join("/");

export const cloudflareRoutes = (): Plugin => ({
  name: "cloudflare-dashboard-routes",
  generateBundle() {
    if (this.environment.name !== "client") return;
    const manifest = globalThis.TSS_ROUTES_MANIFEST;
    if (manifest === undefined) return this.error("TanStack did not supply the route manifest.");
    const patterns = new Set<string>();
    for (const routePath of Object.keys(manifest)) {
      if (routePath === "__root__") continue;
      const path = fullPath(routePath);
      if (path === "/") continue;
      const pattern = path.startsWith("/org/") ? "/org/*" : workerPattern(path);
      patterns.add(pattern);
      if (!pattern.endsWith("*")) patterns.add(`${pattern}/`);
    }
    const source = JSON.stringify([...patterns].sort(), null, 2) + "\n";
    if (!existsSync(dashboardRoutesFile) || readFileSync(dashboardRoutesFile, "utf8") !== source)
      writeFileSync(dashboardRoutesFile, source);
  },
});
