import { classifyMcpPath } from "./mcp/mount";
import { isValidOrgSlug } from "@executor-js/api";

// ---------------------------------------------------------------------------
// Single source of truth for "does the unified app handler own this path?" —
// the decision `start.ts` makes per request (app handler vs TanStack Start).
//
// The app handler (`ExecutorApp.make`'s `toWebHandler`) serves everything under
// `/api/*` — the typed API plus the cloud `extensions.routes` (the Autumn billing
// proxy at `/api/billing/*` and Swagger at `/api/docs` both live under `/api`) —
// plus the `/mcp` serving envelope and its `/.well-known/*` OAuth discovery docs.
// The dispatcher forwards those UNMODIFIED; anything else falls through to the
// Start router. Keeping every served route under `/api` (no separate top-level
// namespace) is what keeps this gate a simple two-prefix check.
// ---------------------------------------------------------------------------

export const isApiPath = (pathname: string) => pathname === "/api" || pathname.startsWith("/api/");

export const isTenantApiPath = (pathname: string): boolean => {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  return segments.length >= 2 && segments[1] === "api" && isValidOrgSlug(segments[0]);
};

export const isAppOwnedPath = (pathname: string) =>
  isApiPath(pathname) || isTenantApiPath(pathname) || classifyMcpPath(pathname) !== null;
